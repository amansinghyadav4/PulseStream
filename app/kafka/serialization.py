from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

from app.models.event import Event


def _isoformat(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


def serialize_event(event: Event) -> bytes:
    """Serialize an Event ORM row to canonical Kafka JSON bytes.

    Canonical fields:
    event_id, organization_id, event_type, source, timestamp, user_id,
    request_id, payload, schema_version, created_at
    - UUIDs as strings (organization_id may be None on a transient row that has
      not yet had its column default applied; consumers default it to Demo)
    - datetimes as ISO-8601 (always tz-aware, UTC)
    """
    payload: dict[str, Any] = {
        "event_id": str(event.event_id),
        "organization_id": str(event.organization_id) if event.organization_id is not None else None,
        "event_type": event.event_type,
        "source": event.source,
        "timestamp": event.timestamp.isoformat(),
        "user_id": event.user_id,
        "request_id": event.request_id,
        "payload": event.payload,
        "schema_version": event.schema_version,
        "created_at": _isoformat(event.created_at),
    }
    return json.dumps(payload).encode("utf-8")


def deserialize_event(data: bytes) -> dict[str, Any]:
    """Safely deserialize canonical Kafka message bytes.

    Returns dict with typed values:
      event_id: uuid.UUID
      timestamp: datetime (tz-aware)
      created_at: datetime | None
      other fields as stored

    Raises ValueError on malformed JSON or missing/invalid fields.
    Reuses validation intent of existing schemas without duplicating them.
    """
    if not isinstance(data, (bytes, bytearray)):
        raise ValueError("invalid kafka message: expected bytes")

    try:
        text = data.decode("utf-8")
    except Exception as exc:
        raise ValueError(f"invalid kafka message: not utf-8: {exc}") from exc

    try:
        obj = json.loads(text)
    except Exception as exc:
        raise ValueError(f"invalid kafka message: not valid JSON: {exc}") from exc

    if not isinstance(obj, dict):
        raise ValueError("invalid kafka message: expected JSON object")

    required = ["event_id", "event_type", "source", "timestamp", "payload", "schema_version"]
    for field in required:
        if field not in obj:
            raise ValueError(f"invalid kafka message: missing field {field}")

    # Validate / coerce event_id
    try:
        event_id = uuid.UUID(str(obj["event_id"]))
    except Exception as exc:
        raise ValueError(f"invalid kafka message: invalid event_id: {exc}") from exc

    # organization_id is OPTIONAL for backward-compatibility (messages published
    # before tenant threading omit it). Missing/None -> None; the consumer path
    # then falls back to the reserved Demo org via the column server_default.
    organization_id: uuid.UUID | None = None
    org_raw = obj.get("organization_id")
    if org_raw is not None:
        try:
            organization_id = uuid.UUID(str(org_raw))
        except Exception as exc:
            raise ValueError(f"invalid kafka message: invalid organization_id: {exc}") from exc

    # Validate timestamp
    ts_raw = obj["timestamp"]
    if not isinstance(ts_raw, str):
        raise ValueError("invalid kafka message: timestamp must be ISO-8601 string")
    try:
        timestamp = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
    except Exception as exc:
        raise ValueError(f"invalid kafka message: invalid timestamp: {exc}") from exc
    if timestamp.tzinfo is None:
        raise ValueError("invalid kafka message: timestamp must include timezone")

    # Validate created_at if present
    created_at: datetime | None = None
    if "created_at" in obj and obj["created_at"] is not None:
        ca_raw = obj["created_at"]
        if not isinstance(ca_raw, str):
            raise ValueError("invalid kafka message: created_at must be ISO-8601 string or null")
        try:
            created_at = datetime.fromisoformat(ca_raw.replace("Z", "+00:00"))
        except Exception as exc:
            raise ValueError(f"invalid kafka message: invalid created_at: {exc}") from exc
        if created_at.tzinfo is None:
            raise ValueError("invalid kafka message: created_at must include timezone")

    # Validate basic types for remaining required fields
    if not isinstance(obj["event_type"], str) or not obj["event_type"].strip():
        raise ValueError("invalid kafka message: event_type must be non-empty string")
    if not isinstance(obj["source"], str) or not obj["source"].strip():
        raise ValueError("invalid kafka message: source must be non-empty string")
    if not isinstance(obj["payload"], dict):
        raise ValueError("invalid kafka message: payload must be object")
    if not isinstance(obj["schema_version"], int) or obj["schema_version"] < 1:
        raise ValueError("invalid kafka message: schema_version must be int >=1")

    # Optional fields: allow missing -> None, allow blank -> None semantics? Keep as stored.
    user_id = obj.get("user_id")
    request_id = obj.get("request_id")
    # Normalize blank to None to match Pydantic behaviour
    if isinstance(user_id, str) and not user_id.strip():
        user_id = None
    if isinstance(request_id, str) and not request_id.strip():
        request_id = None
    if user_id is not None and not isinstance(user_id, str):
        raise ValueError("invalid kafka message: user_id must be string or null")
    if request_id is not None and not isinstance(request_id, str):
        raise ValueError("invalid kafka message: request_id must be string or null")

    return {
        "event_id": event_id,
        "organization_id": organization_id,
        "event_type": obj["event_type"],
        "source": obj["source"],
        "timestamp": timestamp,
        "user_id": user_id,
        "request_id": request_id,
        "payload": obj["payload"],
        "schema_version": obj["schema_version"],
        "created_at": created_at,
    }


def partition_key_for_event(event: Event) -> str:
    """Deterministic partition key: user_id -> source -> event_id.

    Rationale in docs/kafka-topics.md.
    """
    if event.user_id is not None and event.user_id.strip() != "":
        return event.user_id
    if event.source is not None and event.source.strip() != "":
        return event.source
    return str(event.event_id)
