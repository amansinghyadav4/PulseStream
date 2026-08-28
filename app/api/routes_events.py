import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_ingest_api_key
from app.core.config import get_settings
from app.core.errors import DomainError
from app.core.tenant_context import resolve_read_organization
from app.db.session import get_db
from app.models.event import Event
from app.schemas.event import EventBatchIn, EventIn, EventOut
from app.services import event_service
from app.services.kafka_publisher import publisher

router = APIRouter(prefix="/events", tags=["events"])
settings = get_settings()


async def _publish_with_recovery(event) -> None:
    """Publish with one lazy producer re-start attempt after a wedged client."""
    from app.services.kafka_publisher import publisher as _p

    if _p._producer is None and _p._enabled:
        await _p.start()
    await _p.publish_event(event)


@router.post(
    "",
    response_model=EventOut,
    status_code=status.HTTP_201_CREATED,
)
async def ingest_event(
    body: EventIn,
    organization_id: uuid.UUID = Depends(require_ingest_api_key),
    session: AsyncSession = Depends(get_db),
) -> EventOut:
    try:
        event = await event_service.ingest_event(session, body, organization_id)
    except event_service.DuplicateEventError as exc:
        raise DomainError(
            status_code=status.HTTP_409_CONFLICT,
            code="duplicate_event",
            message="an event with this event_id already exists",
            details={"event_id": str(exc.event_id)},
        ) from None
    await _publish_with_recovery(event)
    return EventOut.model_validate(event)


@router.post(
    "/batch",
    response_model=list[EventOut],
    status_code=status.HTTP_201_CREATED,
)
async def ingest_batch(
    body: EventBatchIn,
    organization_id: uuid.UUID = Depends(require_ingest_api_key),
    session: AsyncSession = Depends(get_db),
):
    if len(body.events) > settings.max_batch_size:
        raise DomainError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="batch_too_large",
            message=f"batch exceeds maximum of {settings.max_batch_size} events",
            details={"max_batch_size": settings.max_batch_size},
        )

    # Resolve IDs exactly once per item (Phase 2F fix): EventIn.resolved_event_id() generates a fresh UUID
    # when event_id is None, so calling it twice would produce two different IDs (detection vs persistence).
    resolved_ids: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    duplicated_in_batch: set[uuid.UUID] = set()
    for item in body.events:
        event_id = item.resolved_event_id()
        resolved_ids.append(event_id)
        if event_id in seen:
            duplicated_in_batch.add(event_id)
        seen.add(event_id)
    if duplicated_in_batch:
        raise DomainError(
            status_code=status.HTTP_409_CONFLICT,
            code="duplicate_event",
            message="batch contains duplicate event_ids",
            details={"event_ids": sorted(str(e) for e in duplicated_in_batch)},
        )

    # Stabilize generated IDs so persistence uses the same UUIDs we checked for duplicates
    for item, rid in zip(body.events, resolved_ids):
        if item.event_id is None:
            item.event_id = rid  # type: ignore[assignment]

    existing = await event_service.find_existing_event_ids(session, sorted(seen), organization_id)
    if existing:
        raise DomainError(
            status_code=status.HTTP_409_CONFLICT,
            code="duplicate_event",
            message="one or more events already exist",
            details={"event_ids": sorted(str(e) for e in existing)},
        )

    try:
        events = await event_service.ingest_event_batch(session, body.events, organization_id)
    except IntegrityError:
        raise DomainError(
            status_code=status.HTTP_409_CONFLICT,
            code="duplicate_event",
            message="one or more events already exist (concurrent insert detected)",
        ) from None
    for event in events:
        await _publish_with_recovery(event)
    return [EventOut.model_validate(event) for event in events]


@router.get("", response_model=list[EventOut])
async def list_recent_events(
    limit: int = Query(20, ge=1, le=100, description="Number of recent events"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    organization_id: uuid.UUID = Depends(resolve_read_organization),
    session: AsyncSession = Depends(get_db),
) -> list[EventOut]:
    # PostgreSQL source of truth, scoped to the caller's tenant, ordered by
    # created_at desc (newest first), indexed on (organization_id, created_at).
    result = await session.execute(
        select(Event)
        .where(Event.organization_id == organization_id)
        .order_by(Event.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    events = result.scalars().all()
    return [EventOut.model_validate(e) for e in events]


@router.get("/{event_id}", response_model=EventOut)
async def get_event(
    event_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(resolve_read_organization),
    session: AsyncSession = Depends(get_db),
) -> EventOut:
    event = await event_service.get_event_by_id(session, event_id, organization_id)
    if event is None:
        raise DomainError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="not_found",
            message="event not found",
            details={"event_id": str(event_id)},
        )
    return EventOut.model_validate(event)


