import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api.ws import manager


@pytest.fixture(scope="module", autouse=True)
async def database_pg():
    try:
        from sqlalchemy import text

        from app.db.session import engine

        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("PostgreSQL unavailable; skipping metrics integration assertions")
        return


def test_metrics_200_and_content_type():
    client = TestClient(app)
    r = client.get("/metrics")
    assert r.status_code == 200
    assert "text/plain" in r.headers["content-type"]
    body = r.text
    for expected in [
        "pulsestream_http_requests_total",
        "pulsestream_http_request_latency_seconds",
        "pulsestream_events_processed_total",
        "pulsestream_events_failed_total",
        "pulsestream_websocket_connections",
        "pulsestream_worker_heartbeat",
    ]:
        assert expected in body, f"missing metric {expected}"


def test_metrics_versioned_prefix():
    client = TestClient(app)
    r = client.get("/api/v1/metrics")
    assert r.status_code == 200
    assert "pulsestream_http_requests_total" in r.text


def test_request_counter_increments_from_real_request():
    client = TestClient(app)
    before = _counter_value(client, "/health")
    client.get("/health")
    after = _counter_value(client, "/health")
    assert after >= before + 1


def _counter_value(client: TestClient, path: str) -> float:
    import re

    body = client.get("/metrics").text
    m = re.search(rf'pulsestream_http_requests_total{{[^}}]*path="{re.escape(path)}"[^}}]*}}\s+([0-9.e+-]+)', body)
    return float(m.group(1)) if m else 0.0


def test_websocket_gauge_changes():
    # The gauge reflects live room membership. `/ws` now requires auth, so drive
    # the manager directly with a fake socket rather than an (now-rejected)
    # unauthenticated handshake.
    import asyncio
    import uuid

    from app.api.ws import manager

    class _FakeWS:
        async def accept(self):
            pass

        async def send_json(self, data):
            pass

        async def close(self, code=1000):
            pass

    client = TestClient(app)

    def gauge() -> float:
        import re

        body = client.get("/metrics").text
        m = re.search(r"pulsestream_websocket_connections\s+([0-9.e+-]+)", body)
        return float(m.group(1)) if m else -1

    base = gauge()
    ws = _FakeWS()
    org = uuid.uuid4()
    asyncio.run(manager.connect(ws, org))
    during = gauge()
    assert during == base + 1
    asyncio.run(manager.disconnect(ws, org))
    after = gauge()
    assert after == base


def test_worker_gauges_present_both_workers():
    client = TestClient(app)
    body = client.get("/metrics").text
    assert 'worker="persistence"' in body
    assert 'worker="analytics"' in body


def test_processed_counter_increments_via_persist_hook():
    # Direct hook-level verification without DB (persist_event increments even on mocked session)
    from unittest.mock import AsyncMock, MagicMock

    from app.services.event_consumer_service import persist_event

    client = TestClient(app)
    before = _simple_total(client, "pulsestream_events_processed_total")
    evt = {
        "event_id": uuid.uuid4(),
        "event_type": "t",
        "source": "s",
        "timestamp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc),
        "payload": {},
        "schema_version": 1,
    }
    session = AsyncMock()
    res = MagicMock(rowcount=1)
    session.execute = AsyncMock(return_value=res)
    session.commit = AsyncMock()

    import asyncio

    asyncio.run(persist_event(session, evt))
    after = _simple_total(client, "pulsestream_events_processed_total")
    assert after >= before + 1


def _simple_total(client: TestClient, name: str) -> float:
    import re

    body = client.get("/metrics").text
    m = re.search(rf"{name}_total\s+([0-9.e+-]+)", body)
    if not m:
        m = re.search(rf"{name}\s+([0-9.e+-]+)", body)
    return float(m.group(1)) if m else 0.0


def test_no_payload_in_metrics_output():
    client = TestClient(app)
    body = client.get("/metrics").text
    assert "DO_NOT_LOG" not in body
