import json
import logging
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.kafka.serialization import serialize_event
from app.models.event import Event
from app.services.kafka_publisher import KafkaEventPublisher


def _make_event(**overrides):
    base = {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "checkout-service",
        "timestamp": datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        "user_id": "u-123",
        "request_id": "req-1",
        "payload": {"total": 42, "secret": "should-not-log"},
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


@pytest.mark.asyncio
async def test_user_id_selected_as_partition_key():
    evt = _make_event(user_id="alice", source="svc-a")
    pub = KafkaEventPublisher(bootstrap_servers="localhost:9092", topic="application-events", enabled=True)
    mock_producer = AsyncMock()
    mock_producer.send_and_wait = AsyncMock()
    pub._producer = mock_producer  # type: ignore — bypass start
    await pub.publish_event(evt)
    mock_producer.send_and_wait.assert_awaited_once()
    kwargs = mock_producer.send_and_wait.call_args.kwargs
    assert kwargs["key"] == b"alice"
    assert kwargs["topic"] == "application-events" if "topic" in kwargs else True  # positional may be value; check args
    # value is serialized event
    value = kwargs.get("value") or mock_producer.send_and_wait.call_args.args[1] if len(mock_producer.send_and_wait.call_args.args) > 1 else kwargs["value"]
    obj = json.loads(value)
    assert obj["event_id"] == str(evt.event_id)
    assert obj["payload"] == {"total": 42, "secret": "should-not-log"}


@pytest.mark.asyncio
async def test_source_fallback_when_user_id_absent():
    evt = _make_event(user_id=None, source="payment-service")
    pub = KafkaEventPublisher(bootstrap_servers="localhost:9092", topic="application-events", enabled=True)
    mock_producer = AsyncMock()
    mock_producer.send_and_wait = AsyncMock()
    pub._producer = mock_producer
    await pub.publish_event(evt)
    mock_producer.send_and_wait.assert_awaited_once()
    kwargs = mock_producer.send_and_wait.call_args.kwargs
    assert kwargs["key"] == b"payment-service"

    # blank user_id also falls back
    evt_blank = _make_event(user_id="  ", source="svc-blank")
    mock_producer.reset_mock()
    await pub.publish_event(evt_blank)
    assert mock_producer.send_and_wait.call_args.kwargs["key"] == b"svc-blank"


@pytest.mark.asyncio
async def test_event_id_fallback_when_no_user_or_source():
    eid = uuid.uuid4()
    evt = _make_event(event_id=eid, user_id=None, source=None)  # type: ignore
    # source is required in DB but test defensive fallback; manually set empty
    evt.source = ""  # type: ignore
    evt.user_id = None
    pub = KafkaEventPublisher(bootstrap_servers="localhost:9092", topic="application-events", enabled=True)
    mock_producer = AsyncMock()
    mock_producer.send_and_wait = AsyncMock()
    pub._producer = mock_producer
    # partition_key logic: empty source -> fallback to event_id
    await pub.publish_event(evt)
    assert mock_producer.send_and_wait.call_args.kwargs["key"] == str(eid).encode()

    # also blank source
    evt2 = _make_event(event_id=eid, user_id="  ", source="  ")
    evt2.source = "  "
    evt2.user_id = "  "
    mock_producer.reset_mock()
    await pub.publish_event(evt2)
    assert mock_producer.send_and_wait.call_args.kwargs["key"] == str(eid).encode()


@pytest.mark.asyncio
async def test_publisher_calls_producer_with_expected_key_value():
    evt = _make_event(user_id="u-part", source="svc-x", payload={"hello": "world"})
    pub = KafkaEventPublisher(bootstrap_servers="localhost:9092", topic="application-events", enabled=True)
    mock_producer = AsyncMock()
    mock_producer.send_and_wait = AsyncMock()
    pub._producer = mock_producer
    await pub.publish_event(evt)
    mock_producer.send_and_wait.assert_awaited_once()
    args, kwargs = mock_producer.send_and_wait.call_args
    # key deterministic
    assert kwargs["key"] == b"u-part"
    # value equals serialize_event output
    assert kwargs["value"] == serialize_event(evt)
    # topic is first positional arg per publisher impl
    topic = kwargs.get("topic") or (args[0] if args else None)
    assert topic == "application-events"


@pytest.mark.asyncio
async def test_producer_config_retains_acks_and_idempotence():
    with patch("app.services.kafka_publisher.AIOKafkaProducer") as MockProducer:
        mock_instance = MagicMock()
        mock_instance.start = AsyncMock()
        MockProducer.return_value = mock_instance
        pub = KafkaEventPublisher(bootstrap_servers="myhost:9092", topic="application-events", enabled=True)
        await pub.start()
        MockProducer.assert_called_once()
        kwargs = MockProducer.call_args.kwargs
        assert kwargs["bootstrap_servers"] == "myhost:9092"
        assert kwargs["acks"] == "all"
        assert kwargs["enable_idempotence"] is True
        mock_instance.start.assert_awaited_once()


@pytest.mark.asyncio
async def test_kafka_unavailable_does_not_propagate():
    evt = _make_event(payload={"total": 1})
    pub = KafkaEventPublisher(bootstrap_servers="localhost:9092", topic="application-events", enabled=True)
    mock_producer = AsyncMock()
    # simulate broker down on send
    mock_producer.send_and_wait = AsyncMock(side_effect=Exception("broker down"))
    pub._producer = mock_producer
    # should not raise
    await pub.publish_event(evt)
    mock_producer.send_and_wait.assert_awaited_once()

    # also direct publish should not raise
    await pub.publish("key", b"value")  # no exception

    # disabled producer is no-op, not exception
    pub2 = KafkaEventPublisher(bootstrap_servers="localhost:9092", topic="application-events", enabled=False)
    assert pub2._producer is None
    await pub2.publish_event(evt)  # should be no-op

    # start failure path: producer start raises, publisher disables
    with patch("app.services.kafka_publisher.AIOKafkaProducer") as MockProducer:
        mock_inst = MagicMock()
        mock_inst.start = AsyncMock(side_effect=Exception("kafka down"))
        mock_inst.stop = AsyncMock()
        MockProducer.return_value = mock_inst
        pub3 = KafkaEventPublisher(bootstrap_servers="bad:9092", topic="application-events", enabled=True)
        await pub3.start()
        # after failure, producer disabled
        assert pub3._producer is None
        # publish after failed start is no-op
        await pub3.publish_event(evt)


@pytest.mark.asyncio
async def test_payload_never_written_to_logs(caplog):
    evt = _make_event(payload={"secret_payload": "DO_NOT_LOG_12345", "total": 999})
    pub = KafkaEventPublisher(bootstrap_servers="localhost:9092", topic="application-events", enabled=True)
    mock_producer = AsyncMock()
    mock_producer.send_and_wait = AsyncMock(side_effect=Exception("fail"))
    pub._producer = mock_producer
    caplog.set_level(logging.ERROR)
    # capture publisher logger
    with caplog.at_level(logging.ERROR, logger="app.services.kafka_publisher"):
        await pub.publish_event(evt)
        # also test direct publish failure log
        await pub.publish("mykey", b'{"payload":{"secret_payload":"DO_NOT_LOG_12345"}}')

    combined = " ".join(rec.message for rec in caplog.records) + " ".join(str(rec.args) for rec in caplog.records)
    # payload content must not appear
    assert "DO_NOT_LOG_12345" not in combined
    assert "secret_payload" not in combined
    # also check extra fields don't contain payload json
    for rec in caplog.records:
        # extra may contain topic/partition_key but not payload
        assert "DO_NOT_LOG" not in str(rec.__dict__)

    # success path also should not log payload (no error log, but ensure we didn't accidentally log value)
    mock_producer.send_and_wait = AsyncMock()
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app.services.kafka_publisher"):
        await pub.publish_event(evt)
    combined2 = " ".join(rec.message for rec in caplog.records)
    assert "DO_NOT_LOG_12345" not in combined2
