import uuid
from datetime import datetime, timezone

import pytest
from fakeredis import FakeAsyncRedis

from app.redis.client import _reset_for_tests, _set_redis_for_tests
from app.services.analytics_service import record_event, reset_metrics


@pytest.fixture
async def fake_redis():
    redis = FakeAsyncRedis(decode_responses=True)
    _set_redis_for_tests(redis)
    await reset_metrics()
    yield redis
    await redis.flushall()
    await redis.aclose()
    _reset_for_tests()
    await reset_metrics()


@pytest.mark.asyncio
async def test_analytics_endpoint_returns_metrics(client, fake_redis):
    # record some events via service directly
    await record_event({"event_id": uuid.uuid4(), "event_type": "order.created", "source": "svc-a", "payload": {}, "timestamp": datetime.now(timezone.utc), "schema_version": 1})
    await record_event({"event_id": uuid.uuid4(), "event_type": "page.viewed", "source": "svc-b", "payload": {}, "timestamp": datetime.now(timezone.utc), "schema_version": 1})

    for path in ["/analytics", "/api/v1/analytics"]:
        resp = await client.get(path)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "total" in data
        assert "events_by_type" in data
        assert "events_by_source" in data
        assert "events_per_minute" in data
        assert data["total"] >= 2


@pytest.mark.asyncio
async def test_analytics_endpoint_empty_initially(client, fake_redis):
    await reset_metrics()
    resp = await client.get("/api/v1/analytics")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["events_by_type"] == {}
    assert data["events_by_source"] == {}


@pytest.mark.asyncio
async def test_analytics_endpoint_graceful_when_redis_down(client, monkeypatch):
    import app.redis.client as redis_client
    import app.services.analytics_service as svc

    async def mock_none():
        return None

    monkeypatch.setattr(redis_client, "get_redis", mock_none)
    monkeypatch.setattr(svc, "get_redis", mock_none, raising=False)

    await reset_metrics()
    # record via fallback in-memory
    await record_event({"event_id": uuid.uuid4(), "event_type": "order.created", "source": "svc-a", "payload": {}, "timestamp": datetime.now(timezone.utc), "schema_version": 1})
    resp = await client.get("/api/v1/analytics")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
