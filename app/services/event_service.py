import logging
import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.schemas.event import EventIn

logger = logging.getLogger(__name__)


class DuplicateEventError(Exception):
    def __init__(self, event_id: uuid.UUID) -> None:
        super().__init__(str(event_id))
        self.event_id = event_id


def _build_event(data: EventIn, organization_id: uuid.UUID) -> Event:
    return Event(
        organization_id=organization_id,
        event_id=data.resolved_event_id(),
        event_type=data.event_type,
        source=data.source,
        timestamp=data.resolved_timestamp(),
        user_id=data.user_id,
        request_id=data.request_id,
        payload=data.payload,
        schema_version=data.schema_version,
    )


async def find_existing_event_ids(
    session: AsyncSession, event_ids: list[uuid.UUID], organization_id: uuid.UUID
) -> set[uuid.UUID]:
    """Duplicate detection is per-tenant: uniqueness is (organization_id, event_id),
    so the same event_id may legitimately exist in two different organizations."""
    result = await session.execute(
        select(Event.event_id).where(
            Event.organization_id == organization_id, Event.event_id.in_(event_ids)
        )
    )
    return {row[0] for row in result.all()}


async def get_event_by_id(
    session: AsyncSession, event_id: uuid.UUID, organization_id: uuid.UUID
) -> Event | None:
    result = await session.execute(
        select(Event).where(
            Event.organization_id == organization_id, Event.event_id == event_id
        )
    )
    return result.scalar_one_or_none()


async def ingest_event(
    session: AsyncSession, data: EventIn, organization_id: uuid.UUID
) -> Event:
    event = _build_event(data, organization_id)
    session.add(event)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise DuplicateEventError(event.event_id) from None
    logger.info(
        "event ingested",
        extra={"event_id": str(event.event_id), "event_type": data.event_type},
    )
    return event


async def ingest_event_batch(
    session: AsyncSession, items: list[EventIn], organization_id: uuid.UUID
) -> list[Event]:
    events = [_build_event(item, organization_id) for item in items]
    session.add_all(events)
    await session.commit()
    logger.info("event batch ingested", extra={"count": len(events)})
    return events
