from __future__ import annotations

import logging
import time
from typing import Any

from app.core.config import get_settings

logger = logging.getLogger(__name__)

HEARTBEAT_TTL_S = 30  # heartbeat key lifetime; worker refreshes every HEARTBEAT_INTERVAL
HEARTBEAT_INTERVAL_S = 10


def heartbeat_key(name: str) -> str:
    return f"{get_settings().redis_key_prefix}worker_heartbeat:{name}"


async def beat(name: str, extra: dict[str, Any] | None = None) -> bool:
    """Write a worker heartbeat (SET key EX TTL).

    `extra` may carry safe operational metadata (e.g. consumer lag snapshot);
    it is stored as JSON. Legacy readers only check key freshness (TTL).
    Returns True on success, False on any failure. Never raises.
    """
    try:
        import json

        from app.redis.client import get_redis

        redis = await get_redis()
        if redis is not None:
            payload: dict[str, Any] = {"ts": int(time.time())}
            if extra:
                payload.update(extra)
            await redis.set(heartbeat_key(name), json.dumps(payload), ex=HEARTBEAT_TTL_S)
            return True
    except Exception as exc:
        logger.warning("heartbeat write failed", extra={"worker": name, "error": str(exc)[:200]})
    return False


async def read_heartbeat(name: str) -> dict[str, Any]:
    """Read a worker heartbeat honestly. Returns status dict, never invents healthy."""
    try:
        import json

        from app.redis.client import get_redis

        redis = await get_redis()
        if redis is None:
            return {"status": "unknown", "detail": "redis unavailable - cannot check heartbeat"}
        ttl = await redis.ttl(heartbeat_key(name))
        if ttl is not None and ttl > 0:
            result: dict[str, Any] = {"status": "healthy", "heartbeat_ttl_s": ttl}
            # Attach structured metadata (e.g. consumer lag) when present.
            try:
                raw = await redis.get(heartbeat_key(name))
                value = json.loads(raw) if isinstance(raw, (bytes, str)) else None
                if isinstance(value, dict):
                    for field in ("lag", "group"):
                        if field in value:
                            result[field] = value[field]
            except Exception:
                pass
            return result
        return {"status": "unhealthy", "detail": "no fresh heartbeat"}
    except Exception as exc:
        return {"status": "unknown", "detail": f"heartbeat check error: {str(exc)[:120]}"}
