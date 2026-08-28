from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


class ConnectionManager:
    """Manages dashboard WebSocket connections, **partitioned per organization**.

    Increment D turns the previously-flat connection set into per-tenant *rooms*:
    connections are grouped by the organization id that was resolved
    server-side from the caller's session cookie (never from client input). A
    broadcast is always addressed to a single organization, so one tenant's
    metrics can never reach another tenant's socket.

    Guarantees preserved from the pre-tenant manager:
      * multiple clients supported;
      * broken-client removal on send failure (one failing socket never crashes
        the others);
      * payload-free logging (only counts / type / org id, never event payload).
    """

    def __init__(self) -> None:
        # org_id -> set of live sockets. An org key exists only while it has at
        # least one connection (empty rooms are deleted, so `organizations()`
        # never yields a tenant with nothing to send to).
        self._rooms: dict[uuid.UUID, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    # -- introspection -------------------------------------------------------
    @property
    def active_connections(self) -> set[WebSocket]:
        """Aggregate, cross-tenant view of every live socket.

        Read-only convenience for the Prometheus gauge and the health endpoint;
        callers MUST NOT broadcast to this — broadcasting is always per-org.
        """
        out: set[WebSocket] = set()
        for conns in self._rooms.values():
            out |= conns
        return out

    def organizations(self) -> list[uuid.UUID]:
        """Org ids that currently have at least one connected client."""
        return [org for org, conns in self._rooms.items() if conns]

    def connection_count(self, organization_id: uuid.UUID) -> int:
        return len(self._rooms.get(organization_id, ()))

    # -- lifecycle -----------------------------------------------------------
    async def connect(self, websocket: WebSocket, organization_id: uuid.UUID) -> None:
        await websocket.accept()
        async with self._lock:
            self._rooms.setdefault(organization_id, set()).add(websocket)
        self._update_gauge()
        logger.info(
            "websocket connected",
            extra={"organization_id": str(organization_id), "active": len(self.active_connections)},
        )

    async def disconnect(self, websocket: WebSocket, organization_id: uuid.UUID) -> None:
        async with self._lock:
            self._drop(websocket, organization_id)
        self._update_gauge()
        logger.info(
            "websocket disconnected",
            extra={"organization_id": str(organization_id), "active": len(self.active_connections)},
        )

    async def broadcast_to_org(self, organization_id: uuid.UUID, data: dict[str, Any]) -> None:
        """Send one payload to every socket in a single organization's room.

        Never touches any other tenant's room. Sockets that fail to receive are
        removed so a dead client cannot wedge the broadcast loop.
        """
        msg_type = data.get("type", "unknown") if isinstance(data, dict) else "unknown"
        async with self._lock:
            conns = list(self._rooms.get(organization_id, ()))
        if not conns:
            return
        logger.info(
            "broadcasting",
            extra={"type": msg_type, "organization_id": str(organization_id), "clients": len(conns)},
        )
        for ws in conns:
            try:
                await ws.send_json(data)
            except Exception:
                logger.warning(
                    "websocket send failed - removing",
                    extra={"organization_id": str(organization_id)},
                )
                async with self._lock:
                    self._drop(ws, organization_id)
        self._update_gauge()

    async def disconnect_all(self) -> None:
        async with self._lock:
            conns = [ws for room in self._rooms.values() for ws in room]
            self._rooms.clear()
        for ws in conns:
            try:
                await ws.close()
            except Exception:
                pass
        self._update_gauge()

    def reset(self) -> None:
        """Drop all rooms without closing sockets — test helper only."""
        self._rooms.clear()
        self._update_gauge()

    # -- internals -----------------------------------------------------------
    def _drop(self, websocket: WebSocket, organization_id: uuid.UUID) -> None:
        """Remove a socket from its room, deleting the room when it empties.
        Caller must hold the lock."""
        room = self._rooms.get(organization_id)
        if room is None:
            return
        room.discard(websocket)
        if not room:
            del self._rooms[organization_id]

    def _update_gauge(self) -> None:
        try:
            from app.core.metrics import websocket_connections

            websocket_connections.set(len(self.active_connections))
        except Exception:
            pass


manager = ConnectionManager()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Authenticated, per-tenant metrics stream.

    The organization is resolved **server-side** from the session cookie; query
    params, headers and any client-supplied org id are ignored for
    authorization. An unauthenticated (or invalid-session) connection is closed
    with a policy-violation code and is never accepted into a room.
    """
    # Import here to avoid a circular import at module load (tenant_context ->
    # services -> ws is safe; ws -> tenant_context at call time is fine).
    from app.core.tenant_context import resolve_ws_organization

    organization_id = await resolve_ws_organization(websocket)
    if organization_id is None:
        # Reject BEFORE accept() so the handshake fails (HTTP 403 to the client);
        # the socket is never added to any tenant room.
        await websocket.close(code=1008)  # 1008 = policy violation
        logger.info("websocket rejected: unauthenticated")
        return

    await manager.connect(websocket, organization_id)
    try:
        # Immediate snapshot so a freshly-connected client is not blank until the
        # next broadcaster tick. Same message shape as the periodic broadcast.
        try:
            from app.services.analytics_service import get_metrics

            await websocket.send_json(
                {"type": "metrics", "data": await get_metrics(organization_id=organization_id)}
            )
        except Exception:
            logger.warning("websocket initial snapshot failed", extra={"organization_id": str(organization_id)})

        while True:
            # Keep the connection alive; we read to detect disconnect but never
            # log the payload (only its length).
            data = await websocket.receive_text()
            logger.info("websocket message received", extra={"length": len(data)})
    except WebSocketDisconnect:
        logger.info(
            "websocket client disconnect",
            extra={"organization_id": str(organization_id), "active": len(manager.active_connections)},
        )
    except Exception:
        logger.exception("websocket error")
    finally:
        await manager.disconnect(websocket, organization_id)
