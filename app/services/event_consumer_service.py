from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event

logger = logging.getLogger(__name__)


async def persist_event(session: AsyncSession, event_data: dict[str, Any]) -> bool:
    """Idempotent persistence for consumer path.

    Uses PostgreSQL INSERT ... ON CONFLICT DO NOTHING on the composite
    (organization_id, event_id) unique key. organization_id is taken from the
    deserialized message (threaded through Kafka); when absent (legacy messages
    published before tenant threading) the column's server default — the reserved
    Demo org — fills it.
    Returns True if row was inserted, False if already existed (idempotent success).
    Raises on transient DB failure so caller (consumer) will NOT commit offset.
    Never logs payload.
    """
    # Build values from deserialized dict (typed UUID/datetime)
    values = {
        "event_id": event_data["event_id"],
        "event_type": event_data["event_type"],
        "source": event_data["source"],
        "timestamp": event_data["timestamp"],
        "user_id": event_data.get("user_id"),
        "request_id": event_data.get("request_id"),
        "payload": event_data["payload"],
        "schema_version": event_data["schema_version"],
        # created_at may be None if original API insert hadn't refreshed; use event timestamp as fallback?
        # But DB server_default will handle NULL -> now(); we pass through if present.
        "created_at": event_data.get("created_at"),
    }
    # Attach the resolved tenant when present; otherwise omit so the column's
    # server_default (reserved Demo org) applies (legacy messages / open dev path).
    organization_id = event_data.get("organization_id")
    if organization_id is not None:
        values["organization_id"] = organization_id
    # If created_at is None, let server_default handle it by omitting key or passing None with default
    # SQLAlchemy will insert NULL which triggers server_default? Actually server_default only applies when column not included.
    # We include created_at only if not None to let server set it; if None, omit.
    if values["created_at"] is None:
        values.pop("created_at")

    stmt = (
        pg_insert(Event)
        .values(**values)
        .on_conflict_do_nothing(index_elements=["organization_id", "event_id"])
    )
    try:
        result = await session.execute(stmt)
        await session.commit()
    except Exception:
        try:
            await session.rollback()
        except Exception:
            pass
        logger.exception(
            "persistence failed - not committing offset",
            extra={
                "event_id": str(event_data.get("event_id", "unknown")),
                "event_type": event_data.get("event_type", "unknown"),
                "source": event_data.get("source", "unknown"),
            },
        )
        raise

    # result.rowcount is 1 if inserted, 0 if conflict (duplicate)
    inserted = result.rowcount is not None and result.rowcount > 0
    try:
        from app.core.metrics import events_processed_total

        events_processed_total.inc()
    except Exception:
        pass
    if inserted:
        logger.info(
            "event persisted via consumer",
            extra={
                "event_id": str(event_data["event_id"]),
                "event_type": event_data["event_type"],
                "source": event_data["source"],
            },
        )
    else:
        logger.info(
            "event already exists - idempotent skip",
            extra={
                "event_id": str(event_data["event_id"]),
                "event_type": event_data["event_type"],
                "source": event_data["source"],
            },
        )
    return inserted
