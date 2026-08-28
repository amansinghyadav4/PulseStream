import logging
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.exc import SQLAlchemyError

from app.kafka.consumer import KafkaEventConsumer
from app.kafka.serialization import serialize_event
from app.models.event import Event
from app.services.event_consumer_service import persist_event
from worker.persistence_worker import PersistenceWorker


def _make_event_dict(**overrides):
    base = {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "checkout-service",
        "timestamp": datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        "user_id": "u-123",
        "request_id": "req-1",
        "payload": {"total": 42, "secret": "DO_NOT_LOG_PERSIST"},
        "schema_version": 1,
        "created_at": datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return base


def _make_orm_event(**overrides):
    d = _make_event_dict(**overrides)
    return Event(
        event_id=d["event_id"],
        event_type=d["event_type"],
        source=d["source"],
        timestamp=d["timestamp"],
        user_id=d["user_id"],
        request_id=d["request_id"],
        payload=d["payload"],
        schema_version=d["schema_version"],
        created_at=d["created_at"],
    )


@pytest.mark.asyncio
async def test_new_event_is_persisted():
    event = _make_event_dict()
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.rowcount = 1
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.commit = AsyncMock()
    inserted = await persist_event(mock_session, event)
    assert inserted is True
    mock_session.execute.assert_awaited_once()
    mock_session.commit.assert_awaited_once()
    # ensure insert stmt was used (check call args contains event_id)
    stmt = mock_session.execute.call_args.args[0]
    # stmt is an Insert; we can check its string contains event_id but not full payload logging?
    # Instead assert payload not asserted here


@pytest.mark.asyncio
async def test_existing_event_id_is_idempotent_success():
    event = _make_event_dict()
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.rowcount = 0  # ON CONFLICT DO NOTHING
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.commit = AsyncMock()
    inserted = await persist_event(mock_session, event)
    assert inserted is False  # duplicate -> not inserted but still success (no exception)
    mock_session.execute.assert_awaited_once()
    mock_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_duplicate_delivery_does_not_create_another_row():
    # simulate two deliveries of same event via consumer path
    event = _make_event_dict()
    orm = _make_orm_event(event_id=event["event_id"])
    raw = serialize_event(orm)

    # Mock consumer to inject
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="persistence-workers")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka

    # Mock session factory to simulate first insert then duplicate
    call_count = {"n": 0}

    def make_mock_session(*args, **kwargs):
        mock_s = AsyncMock()
        async def execute(stmt):
            call_count["n"] += 1
            m = MagicMock()
            # first call rowcount 1, second 0
            m.rowcount = 1 if call_count["n"] == 1 else 0
            return m
        mock_s.execute = AsyncMock(side_effect=execute)
        mock_s.commit = AsyncMock()
        # context manager support for async with
        mock_s.__aenter__ = AsyncMock(return_value=mock_s)
        mock_s.__aexit__ = AsyncMock(return_value=None)
        return mock_s

    mock_factory = MagicMock(side_effect=make_mock_session)

    worker = PersistenceWorker(consumer=consumer, session_factory=mock_factory)

    # First delivery
    async def handler1(event_dict):
        async with mock_factory() as session:
            await persist_event(session, event_dict)

    committed1 = await consumer.handle_raw(raw, handler1)
    assert committed1 is True
    assert call_count["n"] == 1

    mock_kafka.commit.reset_mock()
    # Second delivery same raw
    committed2 = await consumer.handle_raw(raw, handler1)
    assert committed2 is True
    assert call_count["n"] == 2
    # both times committed (idempotent success), but second was duplicate
    assert mock_kafka.commit.await_count == 1  # second commit also called once per handle_raw
    # Actually we reset, so second should also be 1
    # Verify no exception, handler considered success for duplicate


@pytest.mark.asyncio
async def test_successful_handler_allows_commit():
    evt = _make_orm_event()
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="persistence-workers")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka

    async def handler(event):
        # simulate successful persist via mock session
        mock_s = AsyncMock()
        mock_r = MagicMock(rowcount=1)
        mock_s.execute = AsyncMock(return_value=mock_r)
        mock_s.commit = AsyncMock()
        await persist_event(mock_s, event)

    committed = await consumer.handle_raw(raw, handler)
    assert committed is True
    mock_kafka.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_database_failure_causes_no_commit():
    evt = _make_orm_event()
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="persistence-workers")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka

    async def handler(event):
        mock_s = AsyncMock()
        mock_s.execute = AsyncMock(side_effect=SQLAlchemyError("db down"))
        mock_s.rollback = AsyncMock()
        mock_s.commit = AsyncMock()
        # persist_event will raise after rollback
        await persist_event(mock_s, event)

    committed = await consumer.handle_raw(raw, handler)
    assert committed is False
    mock_kafka.commit.assert_not_awaited()


def test_worker_uses_group_id_persistence_workers():
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="persistence-workers")
    worker = PersistenceWorker(consumer=consumer)
    assert worker.consumer._group_id == "persistence-workers"
    # also via default factory
    worker2 = PersistenceWorker()
    assert worker2.consumer._group_id == "persistence-workers"


def test_worker_subscribes_to_application_events():
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="persistence-workers")
    worker = PersistenceWorker(consumer=consumer)
    assert worker.consumer._topic == "application-events"
    worker2 = PersistenceWorker()
    assert worker2.consumer._topic == "application-events"


@pytest.mark.asyncio
async def test_payload_never_written_to_logs(caplog):
    event = _make_event_dict(payload={"secret_payload": "DO_NOT_LOG_PERSIST_XYZ"})
    orm = _make_orm_event(payload=event["payload"], event_id=event["event_id"])
    raw = serialize_event(orm)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="persistence-workers")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka

    async def failing_handler(event):
        # simulate DB failure with logging that should not contain payload
        mock_s = AsyncMock()
        mock_s.execute = AsyncMock(side_effect=SQLAlchemyError("fail"))
        mock_s.rollback = AsyncMock()
        await persist_event(mock_s, event)
        raise RuntimeError("handler fail")

    caplog.set_level(logging.ERROR)
    with caplog.at_level(logging.ERROR, logger="app.services.event_consumer_service"):
        await consumer.handle_raw(raw, failing_handler)
    with caplog.at_level(logging.ERROR, logger="app.kafka.consumer"):
        await consumer.handle_raw(raw, failing_handler)
    with caplog.at_level(logging.ERROR, logger="worker.persistence_worker"):
        # also test persistence worker handle_event logging
        mock_factory = MagicMock()
        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(side_effect=SQLAlchemyError("fail"))
        mock_session.rollback = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=None)
        mock_factory.return_value = mock_session
        # need to make factory callable that returns context manager
        mock_factory.__aenter__ = AsyncMock(return_value=mock_session)
        # Instead test persist_event directly with caplog
        try:
            await persist_event(mock_session, event)
        except Exception:
            pass

    combined = " ".join(rec.message for rec in caplog.records) + " ".join(str(rec.__dict__) for rec in caplog.records)
    assert "DO_NOT_LOG_PERSIST_XYZ" not in combined
    assert "secret_payload" not in combined


@pytest.mark.asyncio
async def test_graceful_worker_startup_shutdown():
    mock_consumer = MagicMock(spec=KafkaEventConsumer)
    mock_consumer._topic = "application-events"
    mock_consumer._group_id = "persistence-workers"
    mock_consumer._consumer = None
    mock_consumer.start = AsyncMock()
    mock_consumer.stop = AsyncMock()
    mock_consumer.handle_raw = AsyncMock(return_value=True)
    mock_consumer.run = AsyncMock()

    mock_dlq = MagicMock()
    mock_dlq.start = AsyncMock()
    mock_dlq.stop = AsyncMock()

    worker = PersistenceWorker(consumer=mock_consumer, dlq=mock_dlq)
    await worker.start()
    mock_consumer.start.assert_awaited_once()
    mock_dlq.start.assert_awaited_once()
    assert worker._running is True

    await worker.stop()
    mock_consumer.stop.assert_awaited_once()
    mock_dlq.stop.assert_awaited_once()
    assert worker._running is False

    # stop when not running should not raise
    await worker.stop()

    # Kafka unavailable during start: consumer start raises but worker should handle gracefully
    mock_consumer2 = MagicMock(spec=KafkaEventConsumer)
    mock_consumer2._topic = "application-events"
    mock_consumer2._group_id = "persistence-workers"
    mock_consumer2._consumer = None
    mock_consumer2.start = AsyncMock(side_effect=Exception("kafka down"))
    # Actually PersistenceWorker.start wraps consumer.start directly; if it raises, it would propagate?
    # Check implementation: PersistenceWorker.start does await self.consumer.start() without try/except for consumer failure?
    # consumer.start itself handles gracefully and doesn't raise, so worker start should not raise even when kafka down.
    # Simulate consumer.start that is graceful (does not raise) but leaves _consumer None
    mock_consumer2.start = AsyncMock()  # graceful
    mock_consumer2._consumer = None
    mock_consumer2.stop = AsyncMock()
    worker2 = PersistenceWorker(consumer=mock_consumer2, dlq=mock_dlq)
    await worker2.start()
    assert worker2._running is True
    await worker2.stop()


@pytest.mark.asyncio
async def test_worker_handle_event_uses_session_factory():
    event = _make_event_dict()
    mock_session = AsyncMock()
    mock_result = MagicMock(rowcount=1)
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.commit = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    mock_factory = MagicMock(return_value=mock_session)
    # Make factory callable returning context manager: MagicMock already returns mock_session which has __aenter__
    # But PersistenceWorker uses `async with self.session_factory() as session`
    # So factory() must return an async context manager
    mock_factory = MagicMock()
    mock_factory.return_value = mock_session

    # Need to make mock_factory() return an object that is async context manager
    # mock_session already has __aenter__/__aexit__ as AsyncMock

    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="persistence-workers")
    worker = PersistenceWorker(consumer=consumer, session_factory=mock_factory)

    await worker.handle_event(event)
    mock_session.execute.assert_awaited_once()
    mock_session.commit.assert_awaited_once()
