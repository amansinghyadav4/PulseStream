"""Latency measurement tests (server-side processing latency).

The previous metric was now(utc) - event.timestamp (client-supplied), which
produced astronomically large values for events with old timestamps.
These tests pin the corrected semantics: latency is the measured duration of
analytics-worker processing only, and client timestamps cannot influence it.
"""
import uuid
from datetime import datetime, timezone

import pytest

from app.services.analytics_service import get_metrics, record_event, reset_metrics


def _event(**overrides):
    base = {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "svc-a",
        "timestamp": datetime.now(timezone.utc),
        "payload": {},
        "schema_version": 1,
    }
    base.update(overrides)
    return base


@pytest.fixture(autouse=True)
async def _clean():
    await reset_metrics()
    yield
    await reset_metrics()


@pytest.mark.asyncio
async def test_normal_event_produces_sensible_latency(fake_redis):
    await record_event(_event())
    metrics = await get_metrics()
    avg = metrics["processing_latency_avg_ms"]
    assert avg is not None, "first counted event must produce a latency sample"
    # A single in-process record_event call takes far less than one second.
    assert 0 <= avg < 1000, f"processing latency should be sub-second, got {avg}"


@pytest.mark.asyncio
async def test_old_client_timestamp_does_not_inflate_latency(fake_redis):
    """THE regression test: a 6-year-old event timestamp must be irrelevant."""
    ancient = datetime(2020, 1, 1, tzinfo=timezone.utc)
    await record_event(_event(timestamp=ancient))
    await record_event(_event(timestamp=ancient))
    metrics = await get_metrics()
    avg = metrics["processing_latency_avg_ms"]
    assert avg is not None
    assert avg < 1000, f"old timestamp must not inflate latency; got {avg} ms"
    assert avg < 10_000_000  # the old bug produced values like 115,358,393 ms


@pytest.mark.asyncio
async def test_missing_timestamp_is_handled(fake_redis):
    evt = _event()
    evt.pop("timestamp")
    await record_event(evt)  # must not raise, must still count
    await record_event(_event(timestamp=None))
    metrics = await get_metrics()
    assert metrics["total"] == 2
    assert metrics["processing_latency_avg_ms"] is not None


@pytest.mark.asyncio
async def test_zero_events_latency_unavailable(fake_redis):
    metrics = await get_metrics()
    assert metrics["total"] == 0
    assert metrics["processing_latency_avg_ms"] is None


@pytest.mark.asyncio
async def test_duplicate_delivery_does_not_skew_latency(fake_redis):
    eid = uuid.uuid4()
    for _ in range(5):
        await record_event(_event(event_id=eid))  # same id -> seen-gate dedupes
    metrics = await get_metrics()
    assert metrics["total"] == 1
    # exactly ONE latency sample (count key == 1)
    count = int(await fake_redis.get("pulsestream:analytics:latency:count"))
    assert count == 1


@pytest.mark.asyncio
async def test_fallback_in_memory_records_latency(monkeypatch):
    import app.redis.client as redis_client
    import app.services.analytics_service as svc

    async def mock_get_redis_none():
        return None

    monkeypatch.setattr(redis_client, "get_redis", mock_get_redis_none)
    monkeypatch.setattr(svc, "get_redis", mock_get_redis_none, raising=False)

    await record_event(_event(timestamp=datetime(2019, 6, 1, tzinfo=timezone.utc)))
    metrics = await get_metrics()  # redis unavailable -> in-memory fallback branch
    assert metrics["total"] == 1
    avg = metrics["processing_latency_avg_ms"]
    assert avg is not None and avg < 1000
