"""Best-effort persistence of terminal processing failures.

Called ONLY after terminal DLQ handling has succeeded (the message went to
dead-letter-events and the offset will be committed). Recording is therefore
pure auditing: any error here is logged and swallowed — it must never affect
worker commit semantics or event flow. Never logs payload content.
"""
from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from app.db.session import SessionFactory
from app.models.event_failure import EventFailure

logger = logging.getLogger(__name__)


def _safe_uuid(value: Any) -> UUID | None:
    try:
        return UUID(str(value))
    except Exception:
        return None


async def record_failure(
    event: dict[str, Any] | None,
    error: str,
    attempts: int,
    final_status: str,
) -> bool:
    """Insert one failure row. Returns True when persisted, False otherwise."""
    try:
        payload = event.get("payload") if isinstance(event, dict) else None
        row = EventFailure(
            event_id=_safe_uuid(event.get("event_id")) if isinstance(event, dict) else None,
            event_type=str(event.get("event_type"))[:255] if isinstance(event, dict) and event.get("event_type") else None,
            source=str(event.get("source"))[:255] if isinstance(event, dict) and event.get("source") else None,
            user_id=str(event.get("user_id"))[:255] if isinstance(event, dict) and event.get("user_id") else None,
            payload=payload if isinstance(payload, dict) else None,
            error=str(error)[:1024],
            attempts=max(0, int(attempts)),
            final_status=str(final_status)[:32],
        )
        # Attach the tenant when the failed message carried one; otherwise leave
        # the column unset so its server_default (reserved Demo org) applies.
        org_id = _safe_uuid(event.get("organization_id")) if isinstance(event, dict) else None
        if org_id is not None:
            row.organization_id = org_id
        async with SessionFactory() as session:
            session.add(row)
            await session.commit()
        logger.info(
            "failure recorded",
            extra={
                "final_status": final_status,
                "attempts": attempts,
                "event_id": str(row.event_id) if row.event_id else "unknown",
            },
        )
        return True
    except Exception as exc:
        logger.warning("failure recording skipped", extra={"reason": str(exc)[:200]})
        return False
