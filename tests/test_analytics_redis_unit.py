import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from fakeredis import FakeAsyncRedis

from app.core.config import get_settings
from app.redis.client import _reset_for_tests, _set_redis_for_tests
from app.services.analytics_service import get_metrics, record_event, reset_metrics


@pytest.fixture
async def fake_redis():
    # Create fakeredis and inject
    redis = FakeAsyncRedis(decode_responses=True)
    _set_redis_for_tests(redis)
    await reset_metrics()
    yield redis
    await redis.flushall()
    await redis.aclose()
    _reset_for_tests()
    await reset_metrics()


def _event(**overrides):
    base = {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "checkout-service",
        "timestamp": datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        "user_id": "u-1",
        "request_id": "r-1",
        "payload": {"total": 1},
        "schema_version": 1,
        "created_at": datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_redis_counters_basic(fake_redis):
    await record_event(_event(event_type="order.created", source="svc-a"))
    await record_event(_event(event_type="order.created", source="svc-a"))
    await record_event(_event(event_type="page.viewed", source="svc-b"))
    metrics = await get_metrics()
    assert metrics["total"] == 3
    assert metrics["events_by_type"]["order.created"] == 2
    assert metrics["events_by_type"]["page.viewed"] == 1
    assert metrics["events_by_source"]["svc-a"] == 2
    assert metrics["events_by_source"]["svc-b"] == 1


@pytest.mark.asyncio
async def test_duplicate_event_id_does_not_double_count(fake_redis):
    eid = uuid.uuid4()
    evt = _event(event_id=eid, event_type="order.created", source="svc-a")
    await record_event(evt)
    # duplicate same event_id
    await record_event(evt)
    metrics = await get_metrics()
    assert metrics["total"] == 1, "duplicate should not increment total"
    assert metrics["events_by_type"]["order.created"] == 1
    # also check seen key exists with TTL
    settings = get_settings()
    prefix = settings.redis_key_prefix
    seen_key = f"{prefix}seen:{eid}"
    ttl = await fake_redis.ttl(seen_key)
    assert ttl > 0 and ttl <= settings.redis_idempotency_ttl
    # ensure TTL is bounded (24h)
    assert ttl <= 86400


@pytest.mark.asyncio
async def test_per_minute_bucket_and_ttl(fake_redis):
    # Use fixed timestamp minute
    ts = datetime(2026, 8, 24, 12, 34, 56, tzinfo=timezone.utc)
    evt = _event(timestamp=ts)
    await record_event(evt)
    # per_minute key should be minute truncated
    settings = get_settings()
    prefix = settings.redis_key_prefix
    minute_str = ts.strftime("%Y-%m-%dT%H:%M")
    per_minute_key = f"{prefix}analytics:per_minute:{minute_str}"
    val = await fake_redis.get(per_minute_key)
    assert val == "1"
    ttl = await fake_redis.ttl(per_minute_key)
    assert ttl > 0 and ttl <= settings.redis_per_minute_ttl
    assert ttl <= 120

    # second event same minute increments per_minute
    await record_event(_event(timestamp=ts))
    val2 = await fake_redis.get(per_minute_key)
    assert val2 == "2"

    # get_metrics should return per_minute for current minute if we set timestamp to now
    # For this test, per_minute in metrics is for now, not our fixed ts, so may be 0
    # Instead test that per_minute bucket exists
    metrics = await get_metrics()
    # total should be 2
    assert metrics["total"] == 2


@pytest.mark.asyncio
async def test_redis_unavailable_fallback(monkeypatch):
    # Simulate Redis unavailable by making get_redis return None
    import app.redis.client as redis_client
    import app.services.analytics_service as svc

    # ensure clean in-memory
    await reset_metrics()
    # patch get_redis to return None
    async def mock_get_redis_none():
        return None

    monkeypatch.setattr(redis_client, "get_redis", mock_get_redis_none)
    monkeypatch.setattr(svc, "get_redis", mock_get_redis_none, raising=False)

    # record should fallback to in-memory and succeed
    await record_event(_event(event_type="order.created", source="svc-a"))
    await record_event(_event(event_type="order.created", source="svc-a"))
    metrics = await get_metrics()
    assert metrics["total"] == 2
    assert metrics["events_by_type"]["order.created"] == 2

    # also test that it doesn't raise, and still allows commit (worker would commit)
    await reset_metrics()


@pytest.mark.asyncio
async def test_payload_never_logged_redis(fake_redis, caplog):
    import logging
    evt = _event(payload={"secret_payload": "DO_NOT_LOG_REDIS_XYZ"})
    caplog.set_level(logging.INFO)
    with caplog.at_level(logging.INFO, logger="app.services.analytics_service"):
        await record_event(evt)
    combined = " ".join(rec.message for rec in caplog.records) + " ".join(str(rec.__dict__) for rec in caplog.records)
    assert "DO_NOT_LOG_REDIS_XYZ" not in combined
    assert "secret_payload" not in combined

    # also test get_metrics doesn't log payload
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app.services.analytics_service"):
        await get_metrics()
    combined2 = " ".join(rec.message for rec in caplog.records)
    assert "DO_NOT_LOG" not in combined2


@pytest.mark.asyncio
async def test_atomic_idempotency_with_pipeline(fake_redis):
    # Ensure that duplicate check and increments are atomic via pipeline
    # We test by sending two concurrent record_event for same ID
    eid = uuid.uuid4()
    evt = _event(event_id=eid)
    # run concurrently
    import asyncio

    await asyncio.gather(record_event(evt), record_event(evt))
    metrics = await get_metrics()
    # Only one should count
    assert metrics["total"] == 1
