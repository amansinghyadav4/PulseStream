import json
import logging
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.kafka.consumer import KafkaEventConsumer, create_consumer
from app.kafka.serialization import serialize_event
from app.models.event import Event


def _make_event(**overrides):
    base = {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "checkout-service",
        "timestamp": datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        "user_id": "u-123",
        "request_id": "req-1",
        "payload": {"total": 42, "secret": "DO_NOT_LOG_CONSUMER"},
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


def test_consumer_configuration_uses_application_events():
    # default via create_consumer
    consumer = create_consumer(group_id="persistence-workers")
    assert consumer._topic == "application-events"
    assert consumer._group_id == "persistence-workers"

    consumer2 = KafkaEventConsumer(
        bootstrap_servers="localhost:9092",
        topic="application-events",
        group_id="analytics-workers",
    )
    assert consumer2._topic == "application-events"
    assert consumer2._group_id == "analytics-workers"


@pytest.mark.asyncio
async def test_group_id_is_correctly_passed():
    with patch("app.kafka.consumer.AIOKafkaConsumer") as MockConsumer:
        mock_inst = MagicMock()
        mock_inst.start = AsyncMock()
        MockConsumer.return_value = mock_inst
        consumer = KafkaEventConsumer(
            bootstrap_servers="localhost:9092",
            topic="application-events",
            group_id="my-group",
            auto_offset_reset="earliest",
            enable_auto_commit=False,
        )
        await consumer.start()
        MockConsumer.assert_called_once()
        kwargs = MockConsumer.call_args.kwargs
        assert kwargs["group_id"] == "my-group"
        # positional topic
        args = MockConsumer.call_args.args
        assert args[0] == "application-events"


@pytest.mark.asyncio
async def test_auto_offset_reset_is_correctly_passed():
    with patch("app.kafka.consumer.AIOKafkaConsumer") as MockConsumer:
        mock_inst = MagicMock()
        mock_inst.start = AsyncMock()
        MockConsumer.return_value = mock_inst
        consumer = KafkaEventConsumer(
            bootstrap_servers="localhost:9092",
            topic="application-events",
            group_id="g",
            auto_offset_reset="earliest",
        )
        await consumer.start()
        assert MockConsumer.call_args.kwargs["auto_offset_reset"] == "earliest"

        # custom value
        mock_inst2 = MagicMock()
        mock_inst2.start = AsyncMock()
        MockConsumer.return_value = mock_inst2
        consumer2 = KafkaEventConsumer(
            bootstrap_servers="localhost:9092",
            topic="application-events",
            group_id="g",
            auto_offset_reset="latest",
        )
        await consumer2.start()
        assert MockConsumer.call_args.kwargs["auto_offset_reset"] == "latest"


@pytest.mark.asyncio
async def test_enable_auto_commit_is_false():
    with patch("app.kafka.consumer.AIOKafkaConsumer") as MockConsumer:
        mock_inst = MagicMock()
        mock_inst.start = AsyncMock()
        MockConsumer.return_value = mock_inst
        consumer = KafkaEventConsumer(
            bootstrap_servers="localhost:9092",
            topic="application-events",
            group_id="g",
            enable_auto_commit=False,
        )
        await consumer.start()
        assert MockConsumer.call_args.kwargs["enable_auto_commit"] is False

    # also via factory from settings
    consumer2 = create_consumer(group_id="persistence-workers")
    assert consumer2._enable_auto_commit is False
    assert consumer2._auto_offset_reset == "earliest"


@pytest.mark.asyncio
async def test_valid_message_is_deserialized_through_shared_serializer():
    evt = _make_event(payload={"hello": "world", "x": 1})
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(
        bootstrap_servers="localhost:9092",
        topic="application-events",
        group_id="g",
    )
    mock_consumer = AsyncMock()
    mock_consumer.commit = AsyncMock()
    consumer._consumer = mock_consumer  # inject mock, bypass start

    received = {}

    async def handler(event):
        received["event"] = event

    committed = await consumer.handle_raw(raw, handler)
    assert committed is True
    assert "event" in received
    assert received["event"]["event_id"] == evt.event_id
    assert received["event"]["event_type"] == evt.event_type
    assert received["event"]["payload"] == {"hello": "world", "x": 1}
    # timestamp is datetime, tz-aware
    assert received["event"]["timestamp"].tzinfo is not None
    mock_consumer.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_handler_success_commits_offset():
    evt = _make_event()
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    mock_consumer = AsyncMock()
    mock_consumer.commit = AsyncMock()
    consumer._consumer = mock_consumer

    async def handler(event):
        pass

    committed = await consumer.handle_raw(raw, handler)
    assert committed is True
    mock_consumer.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_handler_failure_does_not_commit():
    evt = _make_event()
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    mock_consumer = AsyncMock()
    mock_consumer.commit = AsyncMock()
    consumer._consumer = mock_consumer

    async def handler(event):
        raise RuntimeError("handler boom")

    committed = await consumer.handle_raw(raw, handler)
    assert committed is False
    mock_consumer.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_graceful_start_stop():
    # start success
    with patch("app.kafka.consumer.AIOKafkaConsumer") as MockConsumer:
        mock_inst = MagicMock()
        mock_inst.start = AsyncMock()
        mock_inst.stop = AsyncMock()
        MockConsumer.return_value = mock_inst
        consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
        await consumer.start()
        mock_inst.start.assert_awaited_once()
        assert consumer._consumer is mock_inst
        await consumer.stop()
        mock_inst.stop.assert_awaited_once()
        assert consumer._consumer is None

    # stop when not started is no-op
    consumer2 = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    assert consumer2._consumer is None
    await consumer2.stop()  # should not raise
    assert consumer2._consumer is None


@pytest.mark.asyncio
async def test_kafka_unavailable_during_startup_handled_gracefully():
    with patch("app.kafka.consumer.AIOKafkaConsumer") as MockConsumer:
        mock_inst = MagicMock()
        mock_inst.start = AsyncMock(side_effect=Exception("kafka down"))
        mock_inst.stop = AsyncMock()
        MockConsumer.return_value = mock_inst
        consumer = KafkaEventConsumer(bootstrap_servers="badhost:9092", topic="application-events", group_id="g")
        # should not raise
        await consumer.start()
        assert consumer._consumer is None
        mock_inst.stop.assert_awaited_once()

        # after failed start, handle_raw should not crash and return False
        evt = _make_event()
        raw = serialize_event(evt)

        async def handler(event):
            pass

        committed = await consumer.handle_raw(raw, handler)
        # no consumer to commit, so False, but handler was still called? In our impl when _consumer is None we still deserialize and call handler but return False
        # Actually current handle_raw when _consumer is None still attempts handler but returns False for commit.
        # For unavailable case, we expect graceful, not committed
        assert committed is False


@pytest.mark.asyncio
async def test_malformed_event_does_not_commit():
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    mock_consumer = AsyncMock()
    mock_consumer.commit = AsyncMock()
    consumer._consumer = mock_consumer

    async def handler(event):
        pytest.fail("handler should not be called for malformed")

    # not json
    committed = await consumer.handle_raw(b"not json", handler)
    assert committed is False
    mock_consumer.commit.assert_not_awaited()

    # missing fields
    bad = json.dumps({"event_type": "x"}).encode()
    committed2 = await consumer.handle_raw(bad, handler)
    assert committed2 is False
    mock_consumer.commit.assert_not_awaited()

    # invalid uuid
    evt = _make_event()
    obj = json.loads(serialize_event(evt))
    obj["event_id"] = "not-uuid"
    committed3 = await consumer.handle_raw(json.dumps(obj).encode(), handler)
    assert committed3 is False
    mock_consumer.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_payload_never_logged(caplog):
    evt = _make_event(payload={"secret_payload": "DO_NOT_LOG_CONSUMER_XYZ"})
    raw = serialize_event(evt)
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g")
    mock_consumer = AsyncMock()
    mock_consumer.commit = AsyncMock()
    consumer._consumer = mock_consumer

    async def handler(event):
        raise RuntimeError("fail")

    caplog.set_level(logging.ERROR)
    with caplog.at_level(logging.ERROR, logger="app.kafka.consumer"):
        await consumer.handle_raw(raw, handler)
        # malformed path
        await consumer.handle_raw(b"not json", handler)

    combined = " ".join(rec.message for rec in caplog.records)
    extra_str = " ".join(str(rec.__dict__) for rec in caplog.records)
    assert "DO_NOT_LOG_CONSUMER_XYZ" not in combined
    assert "DO_NOT_LOG_CONSUMER_XYZ" not in extra_str
    assert "secret_payload" not in combined
