from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.api.ws import manager
from app.services.analytics_service import get_metrics

logger = logging.getLogger(__name__)

_task: asyncio.Task | None = None
_interval: float = 1.0


async def broadcast_once() -> None:
    """Compute and dispatch one metrics snapshot per connected organization.

    A snapshot is calculated ONLY for organizations that currently have a
    connected client, and each snapshot is derived from *that* organization's
    own analytics keyspace (``get_metrics(organization_id=...)``). Each snapshot
    is then sent only to that organization's room, so a tenant can neither see
    another tenant's numbers nor pay for the cost of computing them.
    """
    for organization_id in manager.organizations():
        metrics = await get_metrics(organization_id=organization_id)
        payload: dict[str, Any] = {"type": "metrics", "data": metrics}
        await manager.broadcast_to_org(organization_id, payload)


async def _broadcast_loop() -> None:
    while True:
        try:
            await broadcast_once()
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("broadcaster loop failed")
        try:
            await asyncio.sleep(_interval)
        except asyncio.CancelledError:
            break


async def start_broadcaster(interval: float = 1.0) -> None:
    global _task, _interval
    _interval = interval
    if _task is not None and not _task.done():
        return
    _task = asyncio.create_task(_broadcast_loop())
    logger.info("broadcaster started", extra={"interval": interval})


async def stop_broadcaster() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
        logger.info("broadcaster stopped")
