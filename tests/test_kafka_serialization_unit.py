import json
import uuid
from datetime import datetime, timezone

import pytest

from app.kafka.serialization import deserialize_event, partition_key_for_event, serialize_event
from app.models.event import Event


def _make_event(**overrides):
    base = {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "checkout-service",
        "timestamp": datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        "user_id": "u-123",
        "request_id": "req-456",
        "payload": {"total": 42, "nested": {"a": 1}},
        "schema_version": 1,
        "created_at": datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    }
    base.update(overrides)
    evt = Event(
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
    return evt


def test_canonical_event_serializes_successfully():
    evt = _make_event()
    data = serialize_event(evt)
    assert isinstance(data, bytes)
    obj = json.loads(data)
    assert obj["event_id"] == str(evt.event_id)
    assert obj["event_type"] == "order.created"
    assert obj["source"] == "checkout-service"
    assert obj["payload"] == {"total": 42, "nested": {"a": 1}}
    assert obj["schema_version"] == 1
    # all canonical fields present
    for f in ["event_id", "event_type", "source", "timestamp", "user_id", "request_id", "payload", "schema_version", "created_at"]:
        assert f in obj


def test_uuids_serialize_correctly():
    eid = uuid.uuid4()
    evt = _make_event(event_id=eid)
    data = serialize_event(evt)
    obj = json.loads(data)
    # str(UUID) roundtrips
    assert uuid.UUID(obj["event_id"]) == eid
    assert obj["event_id"] == str(eid)


def test_timestamps_serialize_as_iso8601():
    ts = datetime(2026, 8, 24, 15, 30, 45, tzinfo=timezone.utc)
    created = datetime(2026, 8, 24, 15, 30, 50, tzinfo=timezone.utc)
    evt = _make_event(timestamp=ts, created_at=created)
    data = serialize_event(evt)
    obj = json.loads(data)
    # isoformat
    assert obj["timestamp"] == ts.isoformat()
    assert obj["created_at"] == created.isoformat()
    # also fromisoformat parses back
    assert datetime.fromisoformat(obj["timestamp"].replace("Z", "+00:00")).tzinfo is not None
    assert datetime.fromisoformat(obj["created_at"].replace("Z", "+00:00")).tzinfo is not None
    # offset normalization already done upstream; publisher just serializes what DB has
    # but deserialize must handle Z and offsets
    evt2 = _make_event(timestamp=datetime(2026, 8, 24, 15, 0, 0, tzinfo=timezone.utc))
    data2 = serialize_event(evt2)
    assert "+00:00" in json.loads(data2)["timestamp"] or "Z" in json.loads(data2)["timestamp"]


def test_nullable_fields_handled():
    evt = _make_event(user_id=None, request_id=None, created_at=None)
    data = serialize_event(evt)
    obj = json.loads(data)
    assert obj["user_id"] is None
    assert obj["request_id"] is None
    assert obj["created_at"] is None

    # deserialize preserves None
    out = deserialize_event(data)
    assert out["user_id"] is None
    assert out["request_id"] is None
    assert out["created_at"] is None

    # blank strings in original DB should be None (via Pydantic) but serialization treats blank as partition key fallback;
    # ensure serialize keeps whatever DB has — partition_key handles blank
    evt_blank = _make_event(user_id="", request_id="  ")
    # Even if DB had blank (shouldn't), serialize preserves it
    data_blank = serialize_event(evt_blank)
    assert json.loads(data_blank)["user_id"] == ""
    # deserialize normalizes blank to None per implementation
    out_blank = deserialize_event(data_blank)
    assert out_blank["user_id"] is None
    assert out_blank["request_id"] is None


def test_payload_survives_serialize_deserialize():
    payload = {"nested": {"list": [1, 2, 3]}, "flag": True, "none": None, "blob": {"x": "y"}}
    evt = _make_event(payload=payload, user_id="u-xyz", request_id="r-1")
    data = serialize_event(evt)
    out = deserialize_event(data)
    assert out["payload"] == payload
    assert out["event_id"] == evt.event_id
    assert out["event_type"] == evt.event_type
    assert out["source"] == evt.source
    assert out["user_id"] == "u-xyz"
    assert out["request_id"] == "r-1"
    assert out["schema_version"] == 1
    # timestamps roundtrip preserving instant
    assert out["timestamp"].isoformat() == evt.timestamp.isoformat()
    assert out["created_at"].isoformat() == evt.created_at.isoformat()


def test_partition_key_deterministic():
    eid = uuid.uuid4()
    evt_u = _make_event(event_id=eid, user_id="alice", source="svc-a")
    evt_s = _make_event(event_id=eid, user_id=None, source="svc-b")
    evt_e = _make_event(event_id=eid, user_id=None, source=None)  # type: ignore — defensive, source is required in DB but test fallback
    # need to bypass type checker for None source; set after construction
    evt_e.source = ""  # type: ignore
    # For empty source fallback, should use event_id
    # Adjust evt_e to have empty source to trigger final fallback
    assert partition_key_for_event(evt_u) == "alice"
    assert partition_key_for_event(evt_s) == "svc-b"
    assert partition_key_for_event(evt_e) == str(eid)
    # deterministic across calls
    assert partition_key_for_event(evt_u) == partition_key_for_event(evt_u)
    # blank user_id falls back to source
    evt_blank_user = _make_event(user_id="  ", source="svc-c")
    assert partition_key_for_event(evt_blank_user) == "svc-c"
    # blank source falls back to event_id
    evt_blank_both = _make_event(user_id="  ", source="  ")
    evt_blank_both.source = "  "
    assert partition_key_for_event(evt_blank_both) == str(evt_blank_both.event_id)


def test_deserialize_rejects_invalid_bytes():
    with pytest.raises(ValueError):
        deserialize_event(b"not json")
    with pytest.raises(ValueError):
        deserialize_event(b"")
    with pytest.raises(ValueError):
        deserialize_event(b"{")  # truncated
    with pytest.raises(ValueError):
        deserialize_event("not bytes")  # type: ignore — must be bytes


def test_deserialize_rejects_missing_fields():
    evt = _make_event()
    data = json.loads(serialize_event(evt))
    for field in ["event_id", "event_type", "source", "timestamp", "payload", "schema_version"]:
        bad = dict(data)
        bad.pop(field)
        with pytest.raises(ValueError, match=field):
            deserialize_event(json.dumps(bad).encode())

    # invalid uuid
    bad = dict(data)
    bad["event_id"] = "not-a-uuid"
    with pytest.raises(ValueError, match="event_id"):
        deserialize_event(json.dumps(bad).encode())

    # naive timestamp (no tz) should be rejected — but serialize always emits tz, so craft naive
    bad = dict(data)
    bad["timestamp"] = "2026-08-24T12:00:00"
    with pytest.raises(ValueError):
        deserialize_event(json.dumps(bad).encode())

    # invalid schema_version
    bad = dict(data)
    bad["schema_version"] = 0
    with pytest.raises(ValueError):
        deserialize_event(json.dumps(bad).encode())

    # payload not object
    bad = dict(data)
    bad["payload"] = "string"
    with pytest.raises(ValueError):
        deserialize_event(json.dumps(bad).encode())
