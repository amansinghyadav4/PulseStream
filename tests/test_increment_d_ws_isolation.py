"""Increment D — multi-tenant WebSocket isolation.

The dashboard's live socket (`/ws`) is now authenticated and partitioned per
organization. These tests drive the real auth resolver, the real
``ConnectionManager`` rooms and the real per-org broadcaster against a
``FakeWebSocket`` transport — httpx/ASGITransport cannot open a real WebSocket,
and Starlette's sync ``TestClient`` cannot share this suite's event loop (its
asyncio.run portal would collide with asyncpg's loop-bound pool). Calling the
endpoint coroutine directly keeps everything on one loop, so a real signup
(Postgres) and real per-org metrics (fake Redis) compose without cross-loop
hazards.

* **Integration** (need Postgres, skip cleanly when unreachable — same pattern
  as the Increment C suite): everything that resolves a real session cookie.
* **Always-run**: the no-cookie rejection path (returns before touching the DB)
  and the manager/broadcaster mechanics.

Filename sorts BEFORE ``test_prometheus_metrics`` / ``test_websocket_unit`` for
the same event-loop reason documented in ``test_increment_c_isolation``.
"""
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import WebSocketDisconnect
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app.api.ws import manager, websocket_endpoint
from app.core.config import get_settings
from app.core.tenant_context import resolve_ws_organization
from app.db.base import Base
from app.db.session import engine
from app.main import app
from app.services.broadcaster import broadcast_once

PASSWORD = "correct horse battery staple"


@pytest.fixture
async def database():
    """Non-autouse: only session-cookie tests request it; the rest run always."""
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("PostgreSQL unavailable; skipping WebSocket isolation integration tests")
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _clean_manager():
    # Reset the per-process auth rate limiter so repeated signups here are not
    # throttled by counters other suites left in the same 60s window.
    from app.core.rate_limit import reset_rate_limits

    reset_rate_limits()
    manager.reset()
    yield
    manager.reset()


class FakeWebSocket:
    """Minimal WebSocket double: records accept/close/sent frames.

    Only ``.cookies`` is read for authorization; ``.query_params`` / ``.headers``
    are carried so a test can prove they are IGNORED for org resolution.
    """

    def __init__(self, *, cookies=None, query_params=None, headers=None, send_error=False):
        self.cookies = cookies or {}
        self.query_params = query_params or {}
        self.headers = headers or {}
        self.accepted = False
        self.closed = False
        self.close_code = None
        self.sent: list = []
        self._send_error = send_error

    async def accept(self):
        self.accepted = True

    async def send_json(self, data):
        if self._send_error:
            raise RuntimeError("simulated send failure")
        self.sent.append(data)

    async def receive_text(self):
        # Endpoint stays in a receive loop until the client goes away.
        raise WebSocketDisconnect(code=1000)

    async def close(self, code=1000):
        self.closed = True
        self.close_code = code


def _email() -> str:
    return f"ws-{uuid.uuid4().hex}@example.com"


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _signup_cookie() -> dict:
    """Sign up a fresh tenant and return the session cookie as a WS cookie dict."""
    name = get_settings().session_cookie_name
    async with _client() as c:
        r = await c.post("/api/v1/auth/signup", json={"email": _email(), "password": PASSWORD})
        assert r.status_code == 201, r.text
        return {name: c.cookies.get(name)}


def _seed_event(org_id, **overrides) -> dict:
    body = {
        "event_id": str(uuid.uuid4()),
        "event_type": "ws.test",
        "source": "unit",
        "timestamp": datetime.now(timezone.utc),
        "organization_id": org_id,
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------------------- #
# Auth gate (endpoint level)                                                  #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_unauthenticated_ws_is_rejected_not_accepted():
    """No cookie → closed with policy code, never accepted, never in a room.
    Runs without Postgres (the no-token path returns before any DB access)."""
    ws = FakeWebSocket()
    await websocket_endpoint(ws)
    assert ws.accepted is False
    assert ws.closed is True
    assert ws.close_code == 1008
    assert manager.organizations() == []


@pytest.mark.asyncio
async def test_invalid_session_ws_is_rejected(database):
    """A syntactically-present but bogus session cookie is rejected, not
    silently downgraded to Demo."""
    name = get_settings().session_cookie_name
    ws = FakeWebSocket(cookies={name: "not-a-real-session-token"})
    await websocket_endpoint(ws)
    assert ws.accepted is False
    assert ws.closed is True
    assert manager.organizations() == []


@pytest.mark.asyncio
async def test_authenticated_ws_connection_accepted_and_gets_snapshot(database, fake_redis):
    """Valid session → accepted into its org room and receives an immediate
    metrics frame of the preserved shape."""
    cookie = await _signup_cookie()
    ws = FakeWebSocket(cookies=cookie)
    # Full endpoint run: resolves org, connects, sends initial snapshot, then the
    # fake client "disconnects" so the receive loop exits and disconnect runs.
    await websocket_endpoint(ws)
    assert ws.accepted is True
    assert ws.closed is False  # closed by the client side, not the server
    assert len(ws.sent) == 1
    frame = ws.sent[0]
    assert frame["type"] == "metrics"
    assert isinstance(frame["data"], dict)
    assert "total" in frame["data"]
    # Cleaned up after the client went away.
    assert manager.organizations() == []


@pytest.mark.asyncio
async def test_ws_org_comes_from_session_not_query_or_headers(database, fake_redis):
    """A forged org id in query params / headers must be ignored — the room is
    the session's real org."""
    cookie = await _signup_cookie()
    forged = str(uuid.uuid4())
    ws = FakeWebSocket(
        cookies=cookie,
        query_params={"organization_id": forged},
        headers={"x-organization-id": forged},
    )
    resolved = await resolve_ws_organization(ws)
    assert resolved is not None
    assert str(resolved) != forged


# --------------------------------------------------------------------------- #
# Tenant isolation (connect + per-org broadcast)                              #
# --------------------------------------------------------------------------- #
async def _connect(cookie) -> tuple[FakeWebSocket, uuid.UUID]:
    ws = FakeWebSocket(cookies=cookie)
    org = await resolve_ws_organization(ws)
    assert org is not None
    await manager.connect(ws, org)
    return ws, org


@pytest.mark.asyncio
async def test_tenant_a_and_b_receive_only_their_own_metrics(database, fake_redis):
    """A's socket sees A's totals, B's socket sees B's totals; neither sees the
    other's — no cross-tenant leakage."""
    from app.services.analytics_service import record_event, reset_metrics

    await reset_metrics()
    ws_a, org_a = await _connect(await _signup_cookie())
    ws_b, org_b = await _connect(await _signup_cookie())
    assert org_a != org_b

    # 3 events into A's keyspace, 1 into B's.
    for _ in range(3):
        await record_event(_seed_event(str(org_a)))
    await record_event(_seed_event(str(org_b)))

    # Fresh snapshots (drop the initial-connect frames, which predate seeding).
    ws_a.sent.clear()
    ws_b.sent.clear()
    await broadcast_once()

    assert len(ws_a.sent) == 1 and len(ws_b.sent) == 1
    a_total = ws_a.sent[0]["data"]["total"]
    b_total = ws_b.sent[0]["data"]["total"]
    assert a_total == 3, a_total
    assert b_total == 1, b_total
    # The leakage assertion: A never received B's count and vice versa.
    assert a_total != b_total
    await reset_metrics()


@pytest.mark.asyncio
async def test_multiple_clients_same_org_get_identical_snapshot(database, fake_redis):
    """Two sockets in the same organization receive the same org snapshot."""
    from app.services.analytics_service import record_event, reset_metrics

    await reset_metrics()
    cookie = await _signup_cookie()
    ws1, org1 = await _connect(cookie)
    ws2, org2 = await _connect(cookie)
    assert org1 == org2
    assert manager.connection_count(org1) == 2

    await record_event(_seed_event(str(org1)))
    await record_event(_seed_event(str(org1)))
    ws1.sent.clear()
    ws2.sent.clear()
    await broadcast_once()

    assert ws1.sent == ws2.sent
    assert ws1.sent[0]["data"]["total"] == 2
    await reset_metrics()


@pytest.mark.asyncio
async def test_disconnected_client_is_cleaned_up(database, fake_redis):
    """After disconnect the room is emptied and receives no further broadcasts."""
    ws, org = await _connect(await _signup_cookie())
    assert manager.connection_count(org) == 1

    await manager.disconnect(ws, org)
    assert org not in manager.organizations()
    assert manager.connection_count(org) == 0

    ws.sent.clear()
    await broadcast_once()  # nothing connected → nothing sent
    assert ws.sent == []


@pytest.mark.asyncio
async def test_broken_client_removed_without_crashing_others(database, fake_redis):
    """One socket that fails on send is dropped; a healthy socket in the same
    room still receives its snapshot."""
    from app.services.analytics_service import record_event, reset_metrics

    await reset_metrics()
    cookie = await _signup_cookie()
    good, org = await _connect(cookie)
    broken = FakeWebSocket(cookies=cookie, send_error=True)
    await manager.connect(broken, org)
    assert manager.connection_count(org) == 2

    await record_event(_seed_event(str(org)))
    good.sent.clear()
    await broadcast_once()

    # Broken socket evicted, good socket served.
    assert manager.connection_count(org) == 1
    assert len(good.sent) == 1
    assert good.sent[0]["type"] == "metrics"
    await reset_metrics()


# --------------------------------------------------------------------------- #
# Contract / logging                                                          #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_broadcast_message_shape_preserved(database, fake_redis):
    """The wire contract stays ``{"type": "metrics", "data": {...}}``."""
    ws, org = await _connect(await _signup_cookie())
    ws.sent.clear()
    await broadcast_once()
    assert len(ws.sent) == 1
    frame = ws.sent[0]
    assert set(frame.keys()) == {"type", "data"}
    assert frame["type"] == "metrics"
    assert isinstance(frame["data"], dict)


@pytest.mark.asyncio
async def test_broadcast_never_logs_payload(database, fake_redis, caplog):
    """Broadcasting logs counts/type/org only — never event payload contents."""
    import logging

    ws, org = await _connect(await _signup_cookie())
    secret = "DO_NOT_LOG_WS_SECRET"
    with caplog.at_level(logging.INFO):
        await manager.broadcast_to_org(org, {"type": "metrics", "data": {"secret": secret}})
    combined = " ".join(r.message for r in caplog.records)
    combined += " ".join(str(r.__dict__) for r in caplog.records)
    assert secret not in combined
