from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from sqlalchemy.exc import SQLAlchemyError

logger = logging.getLogger(__name__)

# Bounded exponential backoff: 100ms → 400ms → 1600ms (factor 4) for max 3 attempts
BASE_BACKOFF_S = 0.1
MAX_ATTEMPTS = 3


def is_transient(exc: Exception) -> bool:
    """Distinguish transient vs permanent failures.

    Transient (retry): DB/network, timeout, OS errors, generic unknown (treated as transient for resilience).
    Permanent (no retry, DLQ directly): ValueError (validation, malformed event, missing fields).
    """
    if isinstance(exc, ValueError):
        return False
    if isinstance(exc, (SQLAlchemyError, ConnectionError, TimeoutError, OSError)):
        return True
    # Default: treat as transient to allow retry for unexpected transient issues;
    # permanent validation should explicitly raise ValueError.
    return True


def backoff_for_attempt(attempt: int, base: float = BASE_BACKOFF_S) -> float:
    """Attempt is 1-indexed: 1→0.1, 2→0.4, 3→1.6"""
    return base * (4 ** (attempt - 1))


async def with_retry_and_dlq(
    handler: Callable[[dict[str, Any]], Awaitable[None]],
    event: dict[str, Any],
    raw_value: bytes,
    dlq: Any | None,
    max_attempts: int = MAX_ATTEMPTS,
    base_backoff: float = BASE_BACKOFF_S,
) -> None:
    """Execute handler with bounded retry and DLQ fallback.

    - Transient failures: retry up to max_attempts with exponential backoff.
    - Permanent failures: no retry, go directly to DLQ.
    - After retry exhaustion or permanent failure: attempt DLQ send (raw + error).
      If DLQ succeeds, return normally (caller will commit offset — terminal handling).
      If DLQ fails, raise (caller will NOT commit, allowing redelivery).
    - Never logs payload.
    - On success, returns normally (commit).
    """
    last_exc: Exception | None = None
    attempt = 0
    invocations = 0  # actual handler invocations (for the failure audit record)

    while attempt < max_attempts:
        try:
            invocations += 1
            await handler(event)
            return  # success -> commit
        except Exception as exc:
            last_exc = exc
            if not is_transient(exc):
                # Permanent: break to DLQ without further retry
                logger.info(
                    "permanent failure - will DLQ without retry",
                    extra={
                        "event_id": str(event.get("event_id", "unknown")),
                        "event_type": event.get("event_type", "unknown"),
                    },
                )
                break

            attempt += 1
            if attempt >= max_attempts:
                logger.info(
                    "transient failure - retry exhausted, will DLQ",
                    extra={
                        "event_id": str(event.get("event_id", "unknown")),
                        "attempt": attempt,
                    },
                )
                break

            # Transient and retries remain: backoff then retry
            backoff = backoff_for_attempt(attempt, base_backoff)
            logger.info(
                "transient failure - retrying",
                extra={
                    "event_id": str(event.get("event_id", "unknown")),
                    "attempt": attempt,
                    "backoff_s": backoff,
                },
            )
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                raise

    # If we reach here, handler ultimately failed (permanent or exhausted)
    # Attempt DLQ
    if dlq is not None:
        try:
            # Send raw original with error metadata; dlq handles never-log-payload
            # Use event_id as key for DLQ partitioning
            key = str(event.get("event_id", "unknown")) if isinstance(event, dict) else "unknown"
            error_str = str(last_exc) if last_exc else "unknown error"
            # dlq has send(raw, error, key)
            await dlq.send(raw_value, error=error_str, key=key)
            logger.info(
                "sent to DLQ",
                extra={"event_id": key, "topic": getattr(dlq, "_topic", "dead-letter-events")},
            )
            # Increment failed counter for terminal DLQ (defensible: failed = DLQ)
            try:
                from app.services.analytics_service import record_failed

                await record_failed(event if isinstance(event, dict) else None)
            except Exception:
                pass
            # Audit the terminal failure (best-effort; never affects commit).
            try:
                from app.services.failure_recorder import record_failure

                final_status = (
                    "dlq_permanent"
                    if last_exc is not None and not is_transient(last_exc)
                    else "dlq_retry_exhausted"
                )
                await record_failure(
                    event if isinstance(event, dict) else None,
                    error=error_str,
                    attempts=invocations,
                    final_status=final_status,
                )
            except Exception:
                pass
            return  # DLQ success -> considered terminal success, caller will commit
        except Exception as dlq_exc:
            logger.exception(
                "failed to send to DLQ - not committing",
                extra={"event_id": str(event.get("event_id", "unknown")) if isinstance(event, dict) else "unknown"},
            )
            # Raise original handler exception to prevent commit; redelivery will retry later
            raise last_exc if last_exc else dlq_exc from dlq_exc

    # No DLQ available or DLQ disabled: raise to prevent commit (poison will redeliver, but bounded retries already exhausted)
    # For Phase 2G, if DLQ is None, we still want to avoid infinite loop, so we treat as terminal but not committed?
    # Spec says "Do not commit offsets for messages whose processing ultimately fails." and "Commit only after successful handling or successful terminal DLQ"
    # So without DLQ, we should NOT commit.
    if last_exc:
        raise last_exc
    raise RuntimeError("retry exhausted without DLQ")
