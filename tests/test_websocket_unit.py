"""WebSocket endpoint — sync TestClient level (handshake + broadcaster lifecycle).

Increment D made `/ws` authenticated: an unauthenticated handshake is now
rejected. The no-cookie rejection path returns before any DB access, so these
handshake tests need no Postgres and always run. The per-tenant room mechanics,
isolation and message-shape guarantees are exercised on a shared event loop in
``test_increment_d_ws_isolation`` (a real signup + FakeWebSocket), which avoids
the asyncio.run/asyncpg cross-loop hazard that a sync TestClient would hit for
authenticated flows.
"""
import asyncio

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.ws import manager
from app.main import app
from app.services.broadcaster import start_broadcaster, stop_broadcaster


@pytest.fixture(autouse=True)
async def cleanup_manager():
    manager.reset()
    yield
    manager.reset()
    await stop_broadcaster()


def test_unauthenticated_ws_handshake_is_rejected():
    """No session cookie → the handshake is closed, never accepted."""
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws"):
            pass
    assert len(manager.active_connections) == 0


def test_unauthenticated_ws_handshake_is_rejected_on_v1_prefix():
    """Same rejection on the canonical ``/api/v1/ws`` mount."""
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/ws"):
            pass
    assert len(manager.active_connections) == 0


def test_unauthenticated_ws_does_not_join_any_room():
    """A rejected connection leaves no tenant room behind."""
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws"):
            pass
    assert manager.organizations() == []


def test_broadcaster_start_stop():
    # Sync + dedicated loop: runs last in suite order, avoids Windows session-loop reuse quirks.
    async def _run():
        await start_broadcaster(interval=0.1)
        from app.services.broadcaster import _task

        assert _task is not None
        await stop_broadcaster()
        from app.services.broadcaster import _task as t2

        assert t2 is None

    asyncio.run(_run())
