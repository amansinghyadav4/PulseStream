"""In-process fixed-window rate limiting for authentication endpoints.

Scope note (honest limitation): this limiter keeps counters in a module-level
dict, so it is per-process. For the single-instance dev/demo deployment that is
sufficient and dependency-free (deterministic in tests, no Redis round-trip on
the hot auth path). A distributed, Redis-backed limiter is deferred to the
deployment/scaling increment — recorded in LEARNING.md so it is not forgotten.

The limiter guards brute-force / abuse on the auth endpoints (login, signup,
forgot/reset password). It is intentionally NOT applied to the API-key event
ingestion path, which is unchanged by this increment.
"""
from __future__ import annotations

import threading
import time

from fastapi import Request

from app.core.config import get_settings
from app.core.errors import DomainError

# key -> (window_start_monotonic, count)
_buckets: dict[str, tuple[float, int]] = {}
_lock = threading.Lock()


def reset_rate_limits() -> None:
    """Clear all counters. Used by tests to isolate cases."""
    with _lock:
        _buckets.clear()


def _client_ip(request: Request) -> str:
    client = request.client
    return client.host if client else "unknown"


def _check(key: str, limit: int, window_seconds: int) -> None:
    now = time.monotonic()
    with _lock:
        window_start, count = _buckets.get(key, (now, 0))
        if now - window_start >= window_seconds:
            # Window elapsed — start a fresh one.
            window_start, count = now, 0
        count += 1
        _buckets[key] = (window_start, count)
        if count > limit:
            retry_after = max(1, int(window_seconds - (now - window_start)))
            raise DomainError(
                status_code=429,
                code="rate_limited",
                message="too many requests, slow down and try again later",
                details={"retry_after_seconds": retry_after},
            )


def rate_limit(bucket: str):
    """Build a FastAPI dependency enforcing the auth rate limit for `bucket`.

    Limits come from settings at call time (so tests can tune them via env +
    cache_clear). The counter key is (bucket, client-ip)."""

    async def _dependency(request: Request) -> None:
        settings = get_settings()
        limit = settings.auth_rate_limit_max
        window = settings.auth_rate_limit_window_seconds
        _check(f"{bucket}:{_client_ip(request)}", limit, window)

    return _dependency
