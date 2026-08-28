import logging
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.kafka.consumer import KafkaEventConsumer
from app.kafka.serialization import serialize_event
from app.models.event import Event
from app.services.analytics_service import get_metrics, record_event, reset_metrics
from worker.analytics_worker import AnalyticsWorker


def _make_orm_event(**overrides):
    base = {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "checkout-service",
        "timestamp": datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        "user_id": "u-1",
        "request_id": "r-1",
        "payload": {"total": 1, "secret": "DO_NOT_LOG_ANALYTICS"},
        "schema_version": 1,
        "created_at": datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return Event(
        event_id=base["event_id"],
        event_type=base["event_type"],
        source=base["source"],
        timestamp=base["timestamp"],
        user_id=base["user_id"],
        request_id=base["request_id"],
        payload=base["payload"],
        schema_version=base["schema_version"],
        created_at=base["created_at"],
    )


def test_analytics_worker_group_topic_configuration():
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="analytics-workers")
    worker = AnalyticsWorker(consumer=consumer)
    assert worker.consumer._group_id == "analytics-workers"
    assert worker.consumer._topic == "application-events"
    # default factory
    worker2 = AnalyticsWorker()
    assert worker2.consumer._group_id == "analytics-workers"
    assert worker2.consumer._topic == "application-events"
    assert worker2.consumer._enable_auto_commit is False
    assert worker2.consumer._auto_offset_reset == "earliest"


@pytest.mark.asyncio
async def test_event_counting():
    await reset_metrics()
    await record_event({"event_id": uuid.uuid4(), "event_type": "order.created", "source": "svc-a", "payload": {}, "timestamp": datetime.now(timezone.utc), "schema_version": 1})
    await record_event({"event_id": uuid.uuid4(), "event_type": "order.created", "source": "svc-a", "payload": {}, "timestamp": datetime.now(timezone.utc), "schema_version": 1})
    await record_event({"event_id": uuid.uuid4(), "event_type": "page.viewed", "source": "svc-b", "payload": {}, "timestamp": datetime.now(timezone.utc), "schema_version": 1})
    metrics = await get_metrics()
    assert metrics["total"] == 3
    assert metrics["events_by_type"]["order.created"] == 2
    assert metrics["events_by_type"]["page.viewed"] == 1
    assert metrics["events_by_source"]["svc-a"] == 2
    assert metrics["events_by_source"]["svc-b"] == 1
    await reset_metrics()
    assert (await get_metrics())["total"] == 0


@pytest.mark.asyncio
async def test_analytics_success_allows_commit():
    await reset_metrics()
    evt = _make_orm_event(event_type="page.viewed", source="web-app")
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="analytics-workers")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka
    worker = AnalyticsWorker(consumer=consumer)

    # handler via consumer handle_raw -> record_event
    committed = await consumer.handle_raw(raw, worker.handle_event)
    assert committed is True
    mock_kafka.commit.assert_awaited_once()
    metrics = await get_metrics()
    assert metrics["total"] == 1
    assert metrics["events_by_type"]["page.viewed"] == 1
    await reset_metrics()


@pytest.mark.asyncio
async def test_analytics_failure_prevents_commit(monkeypatch):
    await reset_metrics()
    evt = _make_orm_event()
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="analytics-workers")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka

    # make record_event raise
    async def failing_record(event):
        raise RuntimeError("analytics fail")

    import app.services.analytics_service as svc

    monkeypatch.setattr(svc, "record_event", failing_record)
    import worker.analytics_worker as wmod

    monkeypatch.setattr(wmod, "record_event", failing_record)

    worker = AnalyticsWorker(consumer=consumer)
    consumer._dlq = None  # no DLQ: ultimate handler failure must NOT commit (set AFTER worker wiring)
    # need to ensure worker.handle_event uses failing
    async def patched_handler(event):
        await failing_record(event)

    committed = await consumer.handle_raw(raw, patched_handler)
    assert committed is False
    mock_kafka.commit.assert_not_awaited()
    # also test via worker.handle_event path with monkeypatched service
    # Reset and test worker directly
    mock_kafka.commit.reset_mock()
    # restore to failing via worker
    with pytest.raises(RuntimeError):
        await worker.handle_event({"event_id": uuid.uuid4(), "event_type": "x", "source": "y", "payload": {}, "timestamp": datetime.now(timezone.utc), "schema_version": 1})

    await reset_metrics()


@pytest.mark.asyncio
async def test_payload_never_logged(caplog):
    await reset_metrics()
    evt = _make_orm_event(payload={"secret_payload": "DO_NOT_LOG_ANALYTICS_XYZ"})
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="analytics-workers")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka

    async def failing_handler(event):
        raise RuntimeError("fail analytics")

    caplog.set_level(logging.ERROR)
    with caplog.at_level(logging.ERROR, logger="app.kafka.consumer"):
        await consumer.handle_raw(raw, failing_handler)
    with caplog.at_level(logging.ERROR, logger="app.services.analytics_service"):
        # also test record_event failure path does not log payload
        # record_event logs on success, but payload should not appear
        # call successful record and check logs
        caplog.clear()
        with caplog.at_level(logging.INFO, logger="app.services.analytics_service"):
            await record_event({"event_id": evt.event_id, "event_type": evt.event_type, "source": evt.source, "payload": {"secret_payload": "DO_NOT_LOG_ANALYTICS_XYZ"}})

    combined = " ".join(rec.message for rec in caplog.records) + " ".join(str(rec.__dict__) for rec in caplog.records)
    assert "DO_NOT_LOG_ANALYTICS_XYZ" not in combined
    assert "secret_payload" not in combined
    await reset_metrics()


@pytest.mark.asyncio
async def test_independent_consumer_group_semantics():
    # Two workers with different groups both receive same message (independent consumption)
    await reset_metrics()
    evt = _make_orm_event(event_type="order.created", source="svc-a")
    raw = serialize_event(evt)

    # persistence-like and analytics-like consumers with different group_ids but same topic
    consumer_p = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="persistence-workers")
    consumer_a = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="analytics-workers")
    mock_p = AsyncMock()
    mock_p.commit = AsyncMock()
    mock_a = AsyncMock()
    mock_a.commit = AsyncMock()
    consumer_p._consumer = mock_p
    consumer_a._consumer = mock_a

    from worker.analytics_worker import AnalyticsWorker
    from worker.persistence_worker import PersistenceWorker
    from unittest.mock import MagicMock

    # For analytics, use real record_event; for persistence, mock DB to avoid needing real PG
    mock_session = AsyncMock()
    mock_result = MagicMock(rowcount=1)
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.commit = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)
    mock_factory = MagicMock(return_value=mock_session)
    mock_factory.return_value = mock_session

    worker_p = PersistenceWorker(consumer=consumer_p, session_factory=mock_factory)
    worker_a = AnalyticsWorker(consumer=consumer_a)

    # Both handle same raw via their consumers
    committed_p = await consumer_p.handle_raw(raw, worker_p.handle_event)
    committed_a = await consumer_a.handle_raw(raw, worker_a.handle_event)

    assert committed_p is True
    assert committed_a is True
    mock_p.commit.assert_awaited_once()
    mock_a.commit.assert_awaited_once()

    # analytics metrics should have 1, persistence should have inserted (mocked)
    metrics = await get_metrics()
    assert metrics["total"] == 1
    assert metrics["events_by_type"]["order.created"] == 1
    await reset_metrics()


@pytest.mark.asyncio
async def test_graceful_start_stop():
    mock_consumer = MagicMock(spec=KafkaEventConsumer)
    mock_consumer._topic = "application-events"
    mock_consumer._group_id = "analytics-workers"
    mock_consumer._consumer = None
    mock_consumer.start = AsyncMock()
    mock_consumer.stop = AsyncMock()

    worker = AnalyticsWorker(consumer=mock_consumer)
    await worker.start()
    mock_consumer.start.assert_awaited_once()
    assert worker._running is True
    await worker.stop()
    mock_consumer.stop.assert_awaited_once()
    assert worker._running is False
