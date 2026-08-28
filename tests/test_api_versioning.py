import uuid

import pytest
from sqlalchemy import text

from app.db.base import Base
from app.db.session import engine


@pytest.fixture(scope="module")
async def database_versioning():
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("PostgreSQL unavailable; skipping versioning integration tests")
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


def _event(**overrides):
    base = {
        "event_type": "page.viewed",
        "source": "web-app",
        "timestamp": "2026-08-24T12:00:00Z",
        "payload": {"page": "/home"},
    }
    base.update(overrides)
    return base


async def test_health_both_prefixes(client):
    for path in ["/health", "/api/v1/health"]:
        resp = await client.get(path)
        assert resp.status_code == 200, f"{path} failed: {resp.text}"
        assert resp.json() == {"status": "ok"}


async def test_ready_both_prefixes(client):
    for path in ["/ready", "/api/v1/ready"]:
        resp = await client.get(path)
        # ready returns 200 when DB up, 503 when down — both acceptable, but should be same for both paths
        assert resp.status_code in (200, 503)
        # json should contain status
        assert "status" in resp.json()


async def test_versioned_ingest_and_fetch(client, database_versioning):
    eid = str(uuid.uuid4())
    resp = await client.post("/api/v1/events", json=_event(event_id=eid, user_id="u-v1"))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["event_id"] == eid

    got = await client.get(f"/api/v1/events/{eid}")
    assert got.status_code == 200
    assert got.json()["user_id"] == "u-v1"

    # legacy fetch same id
    got2 = await client.get(f"/events/{eid}")
    assert got2.status_code == 200
    assert got2.json()["event_id"] == eid


async def test_versioned_batch(client, database_versioning):
    e1, e2 = str(uuid.uuid4()), str(uuid.uuid4())
    resp = await client.post(
        "/api/v1/events/batch",
        json={"events": [_event(event_id=e1), _event(event_id=e2, event_type="cart.updated")]},
    )
    assert resp.status_code == 201
    assert [e["event_id"] for e in resp.json()] == [e1, e2]


async def test_legacy_and_versioned_interop_duplicate(client, database_versioning):
    eid = str(uuid.uuid4())
    first = await client.post("/events", json=_event(event_id=eid))
    assert first.status_code == 201
    # duplicate via versioned prefix should also be 409 (same DB, same event_id)
    dup = await client.post("/api/v1/events", json=_event(event_id=eid))
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "duplicate_event"


async def test_versioned_validation_envelope(client, database_versioning):
    resp = await client.post("/api/v1/events", json=_event(event_type="Bad-Type"))
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
