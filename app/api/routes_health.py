from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.config import get_settings
from app.redis.client import get_redis
from app.services.heartbeat import read_heartbeat

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])

# Liveness: is this API process alive? Checks nothing external on purpose.
@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


async def _check_postgres(session: AsyncSession) -> dict[str, Any]:
    start = time.monotonic()
    try:
        await session.execute(text("SELECT 1"))
        return {"status": "healthy", "latency_ms": round((time.monotonic() - start) * 1000, 2)}
    except Exception as exc:
        return {"status": "unhealthy", "error": str(exc)[:120]}


async def _check_redis() -> dict[str, Any]:
    try:
        redis = await get_redis()
        if redis is None:
            return {"status": "unavailable", "detail": "disabled or unreachable (soft dependency)"}
        await redis.ping()
        return {"status": "healthy"}
    except Exception as exc:
        return {"status": "unavailable", "detail": str(exc)[:120]}


async def _check_kafka() -> dict[str, Any]:
    # Honest check: is the ingest producer initialized? Broker liveness itself is
    # managed by aiokafka reconnect; we do not claim more than we can verify.
    from app.services.kafka_publisher import publisher

    if not get_settings().kafka_enabled:
        return {"status": "disabled"}
    if publisher._producer is not None:
        return {"status": "healthy", "detail": "producer started"}
    return {"status": "degraded", "detail": "producer not started (ingest still persists to postgres)"}


async def _check_workers() -> dict[str, Any]:
    persistence = await read_heartbeat("persistence")
    analytics = await read_heartbeat("analytics")
    return {
        "persistence_worker": persistence,
        "analytics_worker": analytics,
        # Heartbeats live in Redis: if Redis itself is down we cannot observe workers.
        "note": "heartbeat via redis; redis unavailable => worker status unknown",
    }


def _broadcaster_status() -> dict[str, Any]:
    from app.api.ws import manager
    from app.services.broadcaster import _task

    return {
        "status": "running" if _task is not None and not _task.done() else "stopped",
        "websocket_clients": len(manager.active_connections),
    }


@router.get("/ready")
async def readiness(session: AsyncSession = Depends(get_db)):
    dependencies: dict[str, Any] = {}
    dependencies["postgres"] = await _check_postgres(session)
    dependencies["redis"] = await _check_redis()
    dependencies["kafka"] = await _check_kafka()
    dependencies["workers"] = await _check_workers()
    dependencies["broadcaster"] = _broadcaster_status()

    # Semantics preserved: PostgreSQL is the ONLY hard gate (source of truth).
    pg_ok = dependencies["postgres"]["status"] == "healthy"

    def soft_down(name: str) -> bool:
        d = dependencies[name]
        return d.get("status") in ("unavailable", "degraded", "unhealthy", "stopped")

    if not pg_ok:
        status = "not_ready"
        code = 503
    elif soft_down("redis") or soft_down("kafka") or soft_down("broadcaster"):
        status = "degraded"
        code = 200
    else:
        status = "ready"
        code = 200

    return JSONResponse(status_code=code, content={"status": status, "dependencies": dependencies})
