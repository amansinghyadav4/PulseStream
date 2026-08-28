"""Phase 7 unit tests: heartbeat payload with consumer lag + metrics gauge wiring."""
import json
from unittest.mock import patch

import pytest
from fakeredis import FakeAsyncRedis

from app.redis.client import _reset_for_tests, _set_redis_for_tests
from app.services.heartbeat import beat, read_heartbeat


@pytest.fixture
async def fake_redis():
    redis = FakeAsyncRedis(decode_responses=True)
    _set_redis_for_tests(redis)
    yield redis
    await redis.flushall()
    await redis.aclose()
    _reset_for_tests()


@pytest.mark.asyncio
async def test_beat_with_extra_stores_json_payload(fake_redis):
    ok = await beat("persistence", extra={"group": "persistence-workers", "lag": {"0": 12, "1": 0}})
    assert ok is True
    status = await read_heartbeat("persistence")
    assert status["status"] == "healthy"
    assert status["heartbeat_ttl_s"] > 0
    assert status["group"] == "persistence-workers"
    assert status["lag"] == {"0": 12, "1": 0}


@pytest.mark.asyncio
async def test_beat_without_extra_stays_healthy_and_has_no_lag(fake_redis):
    assert await beat("analytics") is True
    status = await read_heartbeat("analytics")
    assert status["status"] == "healthy"
    assert "lag" not in status
    # raw value must be valid JSON with ts (legacy int readers only need freshness)
    raw = await fake_redis.get("pulsestream:worker_heartbeat:analytics")
    assert isinstance(json.loads(raw), dict)
    assert "ts" in json.loads(raw)


@pytest.mark.asyncio
async def test_read_heartbeat_missing_key_is_unhealthy(fake_redis):
    status = await read_heartbeat("persistence")
    assert status == {"status": "unhealthy", "detail": "no fresh heartbeat"}


@pytest.mark.asyncio
async def test_read_heartbeat_redis_down_is_unknown():
    with patch("app.redis.client.get_redis", return_value=None):
        status = await read_heartbeat("persistence")
    assert status["status"] == "unknown"


@pytest.mark.asyncio
async def test_lag_gauge_refreshed_from_heartbeat_payload(fake_redis):
    from app.core.metrics import _set_lag_gauges, consumer_lag

    await beat("persistence", extra={"group": "persistence-workers", "lag": {"3": 7}})
    status = await read_heartbeat("persistence")
    _set_lag_gauges("persistence-workers", status.get("lag"))
    value = consumer_lag.labels(group="persistence-workers", partition="3")._value.get()
    assert value == 7


@pytest.mark.asyncio
async def test_lag_gauge_ignores_invalid_payloads():
    from app.core.metrics import _set_lag_gauges

    # non-dict and bad values are ignored, never raise
    _set_lag_gauges("g", None)
    _set_lag_gauges("g", {"x": "not-a-number"})
    _set_lag_gauges("g", {99: -5})  # clamped to 0


@pytest.mark.asyncio
async def test_total_consumer_lag_sums_both_workers(fake_redis):
    from app.services.analytics_service import _total_consumer_lag

    assert await _total_consumer_lag() is None  # no fresh heartbeats yet
    await beat("persistence", extra={"lag": {"0": 10, "1": 5}})
    await beat("analytics", extra={"lag": {"0": 2}})
    assert await _total_consumer_lag() == 17


@pytest.mark.asyncio
async def test_total_consumer_lag_ignores_heartbeat_without_lag(fake_redis):
    from app.services.analytics_service import _total_consumer_lag

    await beat("persistence")  # legacy payload without lag
    await beat("analytics", extra={"lag": {"0": 3}})
    assert await _total_consumer_lag() == 3
