import uuid

from fastapi import APIRouter, Depends

from app.core.tenant_context import resolve_read_organization
from app.services.analytics_service import get_metrics

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("", summary="Get analytics metrics")
async def analytics_metrics(
    organization_id: uuid.UUID = Depends(resolve_read_organization),
):
    # get_metrics is async (Redis or in-memory fallback) — returns traceable metrics
    # scoped to the caller's tenant (Demo for unauthenticated dashboard reads).
    # See docs/redis.md for source → calculation → transport → display
    metrics = await get_metrics(organization_id=organization_id)
    return metrics
