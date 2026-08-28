from __future__ import annotations

import logging
import time
from typing import Any

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_redis: Any | None = None
_redis_available: bool | None = None
_last_attempt: float = 0.0
_RETRY_INTERVAL_S = 5.0  # bounded retry so recovery after redis restart works


def _get_real_redis():
    try:
        from redis.asyncio import Redis

        settings = get_settings()
        # Explicit bounded sockets: without these a ping against a dead
        # endpoint waits for the OS TCP timeout (>10s via Docker proxy),
        # which stacks across sequential callers (/ready does several) and
        # makes readiness itself slow exactly when it must be fast.
        return Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=2.0,
            socket_timeout=2.0,
        )
    except Exception as exc:
        logger.warning("redis import/init failed - degraded to no-redis", extra={"error": str(exc)[:200]})
        return None


async def get_redis() -> Any | None:
    """Get global Redis client: lazy, graceful, with bounded reconnect retries.

    Returns None if REDIS_ENABLED=false or Redis is unreachable.
    After a failure it retries at most once every _RETRY_INTERVAL_S so a
    restarted Redis is picked up without hot-looping. Never raises.
    """
    global _redis, _redis_available, _last_attempt

    settings = get_settings()
    if not settings.redis_enabled:
        return None

    now = time.monotonic()
    if _redis_available is False and (now - _last_attempt) < _RETRY_INTERVAL_S:
        return None  # recent attempt failed; back off

    if _redis is not None:
        try:
            await _redis.ping()
            _redis_available = True
            return _redis
        except Exception:
            logger.warning("redis ping failed - will retry", extra={"redis_url": settings.redis_url})
            try:
                await _redis.aclose()
            except Exception:
                pass
            _redis = None
            _redis_available = False
            _last_attempt = now
            return None

    if _redis_available is False:
        _last_attempt = now  # reconnect attempt below

    client = _get_real_redis()
    if client is None:
        _redis_available = False
        _last_attempt = now
        return None

    try:
        await client.ping()
        _redis = client
        _redis_available = True
        logger.info("redis connected", extra={"redis_url": settings.redis_url})
        return _redis
    except Exception as exc:
        logger.warning("redis ping failed on connect - degraded", extra={"error": str(exc)[:200]})
        _redis_available = False
        _last_attempt = now
        try:
            await client.aclose()
        except Exception:
            pass
        return None


async def close_redis() -> None:
    global _redis, _redis_available, _last_attempt
    if _redis is not None:
        try:
            await _redis.aclose()
        except Exception:
            pass
        _redis = None
        _redis_available = None
        _last_attempt = 0.0


def _reset_for_tests() -> None:
    """Reset global state for tests."""
    global _redis, _redis_available, _last_attempt
    _redis = None
    _redis_available = None
    _last_attempt = 0.0


def _set_redis_for_tests(client: Any | None) -> None:
    global _redis, _redis_available
    _redis = client
    _redis_available = True if client is not None else False
