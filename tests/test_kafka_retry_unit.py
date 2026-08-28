import logging
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.exc import SQLAlchemyError

from app.kafka.retry import MAX_ATTEMPTS, is_transient, with_retry_and_dlq
from app.kafka.serialization import serialize_event
from app.models.event import Event


def _make_event_dict(payload=None):
    return {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "svc-a",
        "timestamp": datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        "user_id": "u-1",
        "request_id": "r-1",
        "payload": payload or {"total": 1},
        "schema_version": 1,
        "created_at": datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    }


def test_is_transient_classification():
    assert is_transient(ValueError("bad")) is False
    assert is_transient(SQLAlchemyError("db")) is True
    assert is_transient(ConnectionError("net")) is True
    assert is_transient(TimeoutError("t")) is True
    assert is_transient(OSError("os")) is True
    assert is_transient(RuntimeError("generic")) is True  # default transient


@pytest.mark.asyncio
async def test_transient_retry_then_success():
    event = _make_event_dict()
    raw = b'{"dummy":1}'
    dlq = AsyncMock()
    dlq.send = AsyncMock()

    call_count = {"n": 0}

    async def handler(e):
        call_count["n"] += 1
        if call_count["n"] < 3:
            raise SQLAlchemyError("transient db fail")
        # third succeeds

    with patch("app.kafka.retry.asyncio.sleep", new=AsyncMock()) as mock_sleep:
        await with_retry_and_dlq(handler, event, raw, dlq, max_attempts=3, base_backoff=0.01)
        # should have retried twice, slept twice
        assert call_count["n"] == 3
        assert mock_sleep.await_count == 2
        dlq.send.assert_not_awaited()


@pytest.mark.asyncio
async def test_transient_exhaustion_then_dlq():
    event = _make_event_dict()
    raw = b'raw-bytes'
    dlq = AsyncMock()
    dlq.send = AsyncMock()

    async def handler(e):
        raise SQLAlchemyError("always transient")

    with patch("app.kafka.retry.asyncio.sleep", new=AsyncMock()):
        await with_retry_and_dlq(handler, event, raw, dlq, max_attempts=3, base_backoff=0.01)
        # after 3 attempts, DLQ should be called
        assert dlq.send.await_count == 1
        dlq.send.assert_awaited_once()
        # raw and error passed, key is event_id
        kwargs = dlq.send.call_args.kwargs
        assert kwargs["key"] == str(event["event_id"])
        assert "always transient" in kwargs["error"] or "always transient" in str(dlq.send.call_args.args)


@pytest.mark.asyncio
async def test_permanent_no_retry_dlq_directly():
    event = _make_event_dict()
    raw = b'raw'
    dlq = AsyncMock()
    dlq.send = AsyncMock()

    call_count = {"n": 0}

    async def handler(e):
        call_count["n"] += 1
        raise ValueError("permanent validation fail")

    with patch("app.kafka.retry.asyncio.sleep", new=AsyncMock()) as mock_sleep:
        await with_retry_and_dlq(handler, event, raw, dlq, max_attempts=3)
        assert call_count["n"] == 1  # no retry for permanent
        assert mock_sleep.await_count == 0
        dlq.send.assert_awaited_once()


@pytest.mark.asyncio
async def test_permanent_dlq_failure_raises():
    event = _make_event_dict()
    raw = b'raw'
    dlq = AsyncMock()
    dlq.send = AsyncMock(side_effect=Exception("dlq down"))

    async def handler(e):
        raise ValueError("permanent")

    with pytest.raises(ValueError):
        await with_retry_and_dlq(handler, event, raw, dlq)

    dlq.send.assert_awaited_once()


@pytest.mark.asyncio
async def test_transient_dlq_failure_raises():
    event = _make_event_dict()
    raw = b'raw'
    dlq = AsyncMock()
    dlq.send = AsyncMock(side_effect=Exception("dlq down"))

    async def handler(e):
        raise SQLAlchemyError("transient")

    with patch("app.kafka.retry.asyncio.sleep", new=AsyncMock()):
        with pytest.raises(SQLAlchemyError):
            await with_retry_and_dlq(handler, event, raw, dlq, max_attempts=2)

    dlq.send.assert_awaited_once()


@pytest.mark.asyncio
async def test_success_no_dlq():
    event = _make_event_dict()
    raw = b'raw'
    dlq = AsyncMock()
    dlq.send = AsyncMock()

    async def handler(e):
        pass

    await with_retry_and_dlq(handler, event, raw, dlq)
    dlq.send.assert_not_awaited()


@pytest.mark.asyncio
async def test_payload_never_logged(caplog):
    event = _make_event_dict(payload={"secret_payload": "DO_NOT_LOG_RETRY_XYZ"})
    raw = b'raw'
    dlq = AsyncMock()
    dlq.send = AsyncMock()

    async def handler(e):
        raise ValueError("permanent with payload secret")

    caplog.set_level(logging.INFO)
    with caplog.at_level(logging.INFO, logger="app.kafka.retry"):
        await with_retry_and_dlq(handler, event, raw, dlq)

    combined = " ".join(rec.message for rec in caplog.records) + " ".join(str(rec.__dict__) for rec in caplog.records)
    assert "DO_NOT_LOG_RETRY_XYZ" not in combined
    assert "secret_payload" not in combined


@pytest.mark.asyncio
async def test_consumer_malformed_goes_to_dlq_and_commits():
    # Test KafkaEventConsumer handle_raw with malformed + DLQ -> commits
    from app.kafka.consumer import KafkaEventConsumer

    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka
    dlq = AsyncMock()
    dlq.send = AsyncMock()
    consumer._dlq = dlq

    malformed = b"not json"

    # handler should not be called for malformed, but DLQ should
    async def handler(e):
        pytest.fail("handler should not be called for malformed")

    committed = await consumer.handle_raw(malformed, handler)
    assert committed is True
    dlq.send.assert_awaited_once()
    mock_kafka.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_consumer_transient_retry_exhaustion_dlq_then_commit():
    from app.kafka.consumer import KafkaEventConsumer

    evt = Event(
        event_id=uuid.uuid4(),
        event_type="order.created",
        source="svc-a",
        timestamp=datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        user_id="u-1",
        request_id=None,
        payload={"total": 1},
        schema_version=1,
        created_at=datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    )
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka
    dlq = AsyncMock()
    dlq.send = AsyncMock()
    consumer._dlq = dlq

    call_count = {"n": 0}

    async def handler(e):
        call_count["n"] += 1
        raise SQLAlchemyError("transient")

    with patch("app.kafka.retry.asyncio.sleep", new=AsyncMock()):
        committed = await consumer.handle_raw(raw, handler)

    assert committed is True  # DLQ success -> commit
    assert call_count["n"] == MAX_ATTEMPTS  # 3 attempts
    dlq.send.assert_awaited_once()
    mock_kafka.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_consumer_success_commits():
    from app.kafka.consumer import KafkaEventConsumer

    evt = Event(
        event_id=uuid.uuid4(),
        event_type="order.created",
        source="svc-a",
        timestamp=datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        user_id="u-1",
        request_id=None,
        payload={"total": 1},
        schema_version=1,
        created_at=datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    )
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka

    async def handler(e):
        pass

    committed = await consumer.handle_raw(raw, handler)
    assert committed is True
    mock_kafka.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_consumer_failure_no_dlq_then_no_commit():
    from app.kafka.consumer import KafkaEventConsumer

    evt = Event(
        event_id=uuid.uuid4(),
        event_type="order.created",
        source="svc-a",
        timestamp=datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        user_id="u-1",
        request_id=None,
        payload={"total": 1},
        schema_version=1,
        created_at=datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    )
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka
    # no DLQ set
    consumer._dlq = None

    async def handler(e):
        raise SQLAlchemyError("transient no dlq")

    with patch("app.kafka.retry.asyncio.sleep", new=AsyncMock()):
        committed = await consumer.handle_raw(raw, handler)

    assert committed is False
    mock_kafka.commit.assert_not_awaited()
