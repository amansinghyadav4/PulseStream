"""Read-only API for terminal processing failures (audit view of the DLQ)."""
import uuid
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tenant_context import resolve_read_organization
from app.db.session import get_db
from app.models.event_failure import EventFailure

router = APIRouter(prefix="/failures", tags=["failures"])


class FailureOut(BaseModel):
    id: int
    event_id: UUID | None = None
    event_type: str | None = None
    source: str | None = None
    user_id: str | None = None
    payload: dict | None = None
    error: str
    attempts: int
    final_status: str
    failed_at: datetime

    model_config = {"from_attributes": True}


@router.get("", response_model=list[FailureOut])
async def list_failures(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    organization_id: uuid.UUID = Depends(resolve_read_organization),
    session: AsyncSession = Depends(get_db),
) -> list[FailureOut]:
    """Newest-first terminal failures, scoped to the caller's tenant. Public like
    the other read endpoints (Demo tenant for unauthenticated callers)."""
    result = await session.execute(
        select(EventFailure)
        .where(EventFailure.organization_id == organization_id)
        .order_by(EventFailure.failed_at.desc(), EventFailure.id.desc())
        .offset(offset)
        .limit(limit)
    )
    return [FailureOut.model_validate(f) for f in result.scalars().all()]
