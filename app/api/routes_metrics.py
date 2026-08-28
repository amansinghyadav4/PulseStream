from fastapi import APIRouter, Response

from app.core.metrics import refresh_worker_gauges, scrape

router = APIRouter(tags=["metrics"])


@router.get("/metrics")
async def metrics() -> Response:
    await refresh_worker_gauges()
    body, content_type = scrape()
    return Response(content=body, media_type=content_type)
