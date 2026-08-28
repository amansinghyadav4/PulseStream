import uuid

import pytest
from sqlalchemy import text

from app.db.base import Base
from app.db.session import engine


@pytest.fixture(scope="module", autouse=True)
async def database():
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("PostgreSQL unavailable; skipping integration tests")
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


async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


async def test_ingest_and_fetch_roundtrip(client):
    eid = str(uuid.uuid4())
    resp = await client.post(
        "/events",
        json=_event(event_id=eid, user_id="u-123"),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["event_id"] == eid
    assert body["schema_version"] == 1
    assert body["timestamp"] == "2026-08-24T12:00:00Z"

    got = await client.get(f"/events/{eid}")
    assert got.status_code == 200
    assert got.json()["payload"] == {"page": "/home"}
    assert got.json()["user_id"] == "u-123"


async def test_generated_event_id_and_timestamp(client):
    resp = await client.post("/events", json=_event(source="mobile-app"))
    assert resp.status_code == 201
    body = resp.json()
    uuid.UUID(body["event_id"])  # parses -> server generated one
    assert body["timestamp"].endswith("+00:00") or body["timestamp"].endswith("Z")


async def test_duplicate_single_returns_409(client):
    eid = str(uuid.uuid4())
    first = await client.post("/events", json=_event(event_id=eid))
    assert first.status_code == 201
    dup = await client.post("/events", json=_event(event_id=eid))
    assert dup.status_code == 409
    err = dup.json()["error"]
    assert err["code"] == "duplicate_event"
    assert err["details"]["event_id"] == eid


async def test_batch_ingest_and_in_batch_duplicate(client):
    e1, e2 = str(uuid.uuid4()), str(uuid.uuid4())
    resp = await client.post(
        "/events/batch",
        json={"events": [_event(event_id=e1), _event(event_id=e2, event_type="cart.updated")]},
    )
    assert resp.status_code == 201
    assert [e["event_id"] for e in resp.json()] == [e1, e2]

    dup_batch = await client.post(
        "/events/batch",
        json={"events": [_event(event_id=e1), _event(event_id=e1)]},
    )
    assert dup_batch.status_code == 409
    assert dup_batch.json()["error"]["code"] == "duplicate_event"


async def test_batch_conflict_with_persisted_event(client):
    e1 = str(uuid.uuid4())
    first = await client.post("/events/batch", json={"events": [_event(event_id=e1)]})
    assert first.status_code == 201
    second = await client.post("/events/batch", json={"events": [_event(event_id=e1)]})
    assert second.status_code == 409


async def test_validation_error_envelope(client):
    resp = await client.post("/events", json=_event(event_type="Bad-Type"))
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["code"] == "validation_error"
    assert isinstance(err["details"], list)


async def test_get_missing_returns_404(client):
    resp = await client.get(f"/events/{uuid.uuid4()}")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


async def test_batch_over_limit_rejected(client):
    events = [_event() for _ in range(1001)]
    resp = await client.post("/events/batch", json={"events": events})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "batch_too_large"


async def test_payload_too_large(client):
    big_payload = {"blob": "x" * (2 * 1024 * 1024)}
    resp = await client.post("/events", json=_event(payload=big_payload))
    assert resp.status_code == 413
    assert resp.json()["error"]["code"] == "payload_too_large"
