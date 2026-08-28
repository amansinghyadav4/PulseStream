import uuid

import pytest
from pydantic import ValidationError

from app.schemas.event import EventIn


def _valid(**overrides):
    base = {
        "event_type": "page.viewed",
        "source": "web-app",
        "timestamp": "2026-08-24T12:00:00+00:00",
        "payload": {"page": "/home"},
    }
    base.update(overrides)
    return base


def test_minimal_event_gets_defaults():
    data = EventIn(event_type="signup.completed", source="api")
    assert data.event_id is None
    assert data.timestamp is None
    assert data.payload == {}
    assert data.schema_version == 1

    resolved_id = data.resolved_event_id()
    assert isinstance(resolved_id, uuid.UUID)
    assert data.resolved_event_id() != resolved_id  # fresh uuid4 each call when unset
    ts = data.resolved_timestamp()
    assert ts.tzinfo is not None
    assert ts.utcoffset().total_seconds() == 0


def test_explicit_event_id_preserved():
    eid = str(uuid.uuid4())
    data = EventIn(event_type="x", source="y", event_id=eid)
    assert str(data.resolved_event_id()) == eid


def test_naive_timestamp_rejected():
    with pytest.raises(ValidationError):
        EventIn(event_type="x", source="y", timestamp="2026-08-24T12:00:00")


def test_offset_timestamp_normalized_to_utc():
    data = EventIn(event_type="x", source="y", timestamp="2026-08-24T15:00:00+03:00")
    assert data.resolved_timestamp().hour == 12


def test_invalid_event_type_format_rejected():
    for bad in ["PageViewed", "1starts-digit", "has-dash", "has space"]:
        with pytest.raises(ValidationError):
            EventIn(event_type=bad, source="web")


def test_blank_source_rejected():
    with pytest.raises(ValidationError):
        EventIn(event_type="x.y", source="   ")


def test_blank_user_id_becomes_none():
    data = EventIn(event_type="x.y", source="web", user_id="  ")
    assert data.user_id is None


def test_schema_version_must_be_positive():
    with pytest.raises(ValidationError):
        EventIn(event_type="x.y", source="web", schema_version=0)


def test_payload_accepts_arbitrary_json():
    payload = {"nested": {"list": [1, 2, 3]}, "flag": True, "none": None}
    data = EventIn(event_type="x.y", source="web", payload=payload)
    assert data.payload == payload
