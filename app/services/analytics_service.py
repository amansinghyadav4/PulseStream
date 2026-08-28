from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from app.core.config import get_settings
from app.models.organization import DEMO_ORGANIZATION_ID

logger = logging.getLogger(__name__)

# Fallback in-memory (used when Redis unavailable, graceful degradation)
_lock = asyncio.Lock()
_total: int = 0
_failed: int = 0
_by_type: Counter[str] = Counter()
_by_source: Counter[str] = Counter()
_latency_sum: float = 0.0
_latency_count: int = 0


def _prefix() -> str:
    return get_settings().redis_key_prefix


def _org_segment(organization_id: Any) -> str:
    """Redis key namespace segment for a tenant.

    The reserved **Demo** org (and a missing/None org) uses the LEGACY,
    un-namespaced keys (`{prefix}analytics:total`, `{prefix}seen:{id}`, …). This
    keeps the shared/Demo pipeline — the public dashboard's data — byte-for-byte
    compatible with pre-tenant behavior. Every other organization gets an
    isolated `org:{id}:` segment, so no tenant can read or clobber another's
    counters, dedup set, or per-minute buckets.
    """
    if organization_id is None:
        return ""
    if str(organization_id) == str(DEMO_ORGANIZATION_ID):
        return ""
    return f"org:{organization_id}:"


def _minute_bucket(ts: Any) -> str:
    try:
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            else:
                ts = ts.astimezone(timezone.utc)
            return ts.strftime("%Y-%m-%dT%H:%M")
        return "unknown"
    except Exception:
        return "unknown"


async def record_event(event: dict[str, Any]) -> None:
    """Record one deserialized event for analytics.

    Redis primary with idempotency (seen:{event_id} NX EX 24h) before increments.
    Falls back to in-memory Counter if Redis unavailable.
    Never logs payload.

    Processing latency: measured SERVER-SIDE with a monotonic clock from this
    function's entry until the counter pipeline is built. The sample is written
    in the SAME atomic pipeline as the counters and therefore only exists for
    events that pass the seen-key gate — duplicate deliveries never skew it.
    Client-supplied event timestamps are deliberately NOT used: an old event
    timestamp says nothing about processing speed (the previous implementation
    produced astronomically large values for exactly that reason).
    """
    started = time.monotonic()

    try:
        from app.redis.client import get_redis

        redis = await get_redis()
        if redis is not None:
            settings = get_settings()
            prefix = _prefix()
            seg = _org_segment(event.get("organization_id"))
            event_id = str(event.get("event_id", "unknown"))
            seen_key = f"{prefix}{seg}seen:{event_id}"

            try:
                was_set = await redis.set(seen_key, "1", nx=True, ex=settings.redis_idempotency_ttl)
            except Exception as exc:
                logger.warning("redis seen check failed - falling back to in-memory", extra={"error": str(exc)[:200]})
                raise

            if not was_set:
                logger.info(
                    "analytics duplicate seen - skipping",
                    extra={
                        "event_id": event_id,
                        "event_type": event.get("event_type", "unknown"),
                        "source": event.get("source", "unknown"),
                    },
                )
                return

            minute = _minute_bucket(event.get("timestamp"))
            total_key = f"{prefix}{seg}analytics:total"
            by_type_key = f"{prefix}{seg}analytics:by_type"
            by_source_key = f"{prefix}{seg}analytics:by_source"
            per_minute_key = f"{prefix}{seg}analytics:per_minute:{minute}"
            # Latency keys
            latency_sum_key = f"{prefix}{seg}analytics:latency:sum"
            latency_count_key = f"{prefix}{seg}analytics:latency:count"

            try:
                pipe = redis.pipeline()
                pipe.incr(total_key)
                pipe.hincrby(by_type_key, event.get("event_type", "unknown"), 1)
                pipe.hincrby(by_source_key, event.get("source", "unknown"), 1)
                pipe.incr(per_minute_key)
                pipe.expire(per_minute_key, settings.redis_per_minute_ttl)
                # Server-measured processing latency for THIS event, into the
                # same atomic pipeline (idempotent via the seen gate above).
                elapsed_ms = (time.monotonic() - started) * 1000.0
                if elapsed_ms >= 0:
                    pipe.incrbyfloat(latency_sum_key, elapsed_ms)
                    pipe.incr(latency_count_key)
                await pipe.execute()
            except Exception as exc:
                logger.warning("redis pipeline failed - will fallback", extra={"error": str(exc)[:200]})
                raise

            logger.info(
                "analytics recorded (redis)",
                extra={
                    "event_id": event_id,
                    "event_type": event.get("event_type", "unknown"),
                    "source": event.get("source", "unknown"),
                },
            )
            return
    except Exception as exc:
        logger.warning("redis analytics failed, falling back to in-memory", extra={"error": str(exc)[:200]})

    # Fallback in-memory
    global _total, _failed, _latency_sum, _latency_count
    elapsed_ms = (time.monotonic() - started) * 1000.0
    async with _lock:
        _total += 1
        _by_type[event.get("event_type", "unknown")] += 1  # type: ignore[arg-type]
        _by_source[event.get("source", "unknown")] += 1  # type: ignore[arg-type]
        if elapsed_ms >= 0:
            _latency_sum += elapsed_ms
            _latency_count += 1

    logger.info(
        "analytics recorded (in-memory fallback)",
        extra={
            "event_id": str(event.get("event_id", "unknown")),
            "event_type": event.get("event_type", "unknown"),
            "source": event.get("source", "unknown"),
        },
    )


async def record_failed(event: dict[str, Any] | None = None) -> None:
    """Increment failed counter (called when DLQ terminal). Never logs payload."""
    try:
        from app.core.metrics import events_failed_total

        events_failed_total.inc()
    except Exception:
        pass
    try:
        from app.redis.client import get_redis

        redis = await get_redis()
        if redis is not None:
            prefix = _prefix()
            seg = _org_segment(event.get("organization_id") if isinstance(event, dict) else None)
            try:
                await redis.incr(f"{prefix}{seg}analytics:failed")
                return
            except Exception as exc:
                logger.warning("redis failed increment failed", extra={"error": str(exc)[:200]})
                raise
    except Exception:
        pass
    global _failed
    async with _lock:
        _failed += 1
    # Log without payload
    event_id = str(event.get("event_id", "unknown")) if isinstance(event, dict) else "unknown"
    logger.info("analytics failed recorded", extra={"event_id": event_id})


async def _total_consumer_lag() -> int | None:
    """Sum of per-partition lags across worker groups from fresh heartbeats.

    Returns None when no fresh heartbeat carries a lag snapshot (redis down,
    workers never assigned) — honest absence, never zero-by-default.
    """
    try:
        from app.services.heartbeat import read_heartbeat

        total: int | None = None
        for name in ("persistence", "analytics"):
            status = await read_heartbeat(name)
            lag = status.get("lag")
            if isinstance(lag, dict):
                total = (total or 0) + sum(v for v in lag.values() if isinstance(v, (int, float)))
        return total
    except Exception:
        return None


async def get_metrics(organization_id: Any = None) -> dict[str, Any]:
    """Snapshot of analytics counters for one tenant. Tries Redis first, falls
    back to in-memory.

    organization_id defaults to None → the reserved Demo / legacy (un-namespaced)
    keyspace, which is what the public dashboard and the existing unit tests read.
    Any other organization reads only its isolated `org:{id}:` keyspace.

    Returns: {
      total, events_processed_total, events_failed_total,
      events_by_type, events_by_source,
      events_per_minute, events_per_second,
      processing_latency_avg_ms, active_producers,
      consumer_lag (if available else None)
    }

    processing_latency_avg_ms = mean server-side processing duration per unique
    counted event (analytics worker: handler entry -> counter pipeline,
    monotonic clock). NOT derived from client event timestamps; NOT end-to-end
    pipeline latency.
    """
    try:
        from app.redis.client import get_redis

        redis = await get_redis()
        if redis is not None:
            prefix = _prefix()
            seg = _org_segment(organization_id)
            total_key = f"{prefix}{seg}analytics:total"
            failed_key = f"{prefix}{seg}analytics:failed"
            by_type_key = f"{prefix}{seg}analytics:by_type"
            by_source_key = f"{prefix}{seg}analytics:by_source"
            latency_sum_key = f"{prefix}{seg}analytics:latency:sum"
            latency_count_key = f"{prefix}{seg}analytics:latency:count"

            now_minute = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
            per_minute_key = f"{prefix}{seg}analytics:per_minute:{now_minute}"

            total_raw = await redis.get(total_key)
            failed_raw = await redis.get(failed_key)
            by_type_raw = await redis.hgetall(by_type_key)
            by_source_raw = await redis.hgetall(by_source_key)
            per_minute_raw = await redis.get(per_minute_key)
            latency_sum_raw = await redis.get(latency_sum_key)
            latency_count_raw = await redis.get(latency_count_key)

            total = int(total_raw) if total_raw is not None else 0
            failed = int(failed_raw) if failed_raw is not None else 0
            events_by_type = {k: int(v) for k, v in (by_type_raw or {}).items()}
            events_by_source = {k: int(v) for k, v in (by_source_raw or {}).items()}
            events_per_minute = int(per_minute_raw) if per_minute_raw is not None else 0
            events_per_second = round(events_per_minute / 60, 2) if events_per_minute else 0.0

            latency_sum = float(latency_sum_raw) if latency_sum_raw is not None else 0.0
            latency_count = int(latency_count_raw) if latency_count_raw is not None else 0
            latency_avg = round(latency_sum / latency_count, 2) if latency_count else None

            active_producers = len(events_by_source) if events_by_source else 0

            # Consumer lag: sampled from the workers' heartbeat payloads
            # (real broker highwatermark - position, refreshed every 10s).
            consumer_lag = await _total_consumer_lag()

            return {
                "total": total,
                "events_processed_total": total,
                "events_failed_total": failed,
                "events_by_type": events_by_type,
                "events_by_source": events_by_source,
                "events_per_minute": events_per_minute,
                "events_per_second": events_per_second,
                "processing_latency_avg_ms": latency_avg,
                "active_producers": active_producers,
                "consumer_lag": consumer_lag,
            }
    except Exception as exc:
        logger.warning("redis get_metrics failed, fallback to in-memory", extra={"error": str(exc)[:200]})

    # Fallback in-memory (only meaningful for the Demo/legacy keyspace: the
    # process-local counters are not tenant-partitioned, so a specific non-Demo
    # org cannot be attributed here — return an empty snapshot for it rather than
    # leaking the global counts across tenants).
    if _org_segment(organization_id) != "":
        return {
            "total": 0,
            "events_processed_total": 0,
            "events_failed_total": 0,
            "events_by_type": {},
            "events_by_source": {},
            "events_per_minute": 0,
            "events_per_second": 0.0,
            "processing_latency_avg_ms": None,
            "active_producers": 0,
            "consumer_lag": None,
        }
    async with _lock:
        total = _total
        failed = _failed
        events_by_type = dict(_by_type)
        events_by_source = dict(_by_source)
        # per_minute fallback 0
        per_minute = 0
        per_second = 0.0
        latency_avg = round(_latency_sum / _latency_count, 2) if _latency_count else None
        active_producers = len(events_by_source)

        return {
            "total": total,
            "events_processed_total": total,
            "events_failed_total": failed,
            "events_by_type": events_by_type,
            "events_by_source": events_by_source,
            "events_per_minute": per_minute,
            "events_per_second": per_second,
            "processing_latency_avg_ms": latency_avg,
            "active_producers": active_producers,
            "consumer_lag": None,
        }


async def reset_metrics() -> None:
    """Reset counters — for tests. Clears both Redis and in-memory."""
    try:
        from app.redis.client import get_redis

        redis = await get_redis()
        if redis is not None:
            prefix = _prefix()
            await redis.delete(f"{prefix}analytics:total")
            await redis.delete(f"{prefix}analytics:failed")
            await redis.delete(f"{prefix}analytics:by_type")
            await redis.delete(f"{prefix}analytics:by_source")
            await redis.delete(f"{prefix}analytics:latency:sum")
            await redis.delete(f"{prefix}analytics:latency:count")
            # Legacy/Demo keyspace scans, plus every per-tenant `org:{id}:*`
            # namespace (analytics counters, dedup set, per-minute buckets).
            for pattern in [
                f"{prefix}analytics:per_minute:*",
                f"{prefix}seen:*",
                f"{prefix}org:*",
            ]:
                cursor = 0
                while True:
                    cursor, keys = await redis.scan(cursor=cursor, match=pattern, count=100)
                    if keys:
                        await redis.delete(*keys)
                    if cursor == 0:
                        break
    except Exception:
        pass

    global _total, _failed, _latency_sum, _latency_count
    async with _lock:
        _total = 0
        _failed = 0
        _by_type.clear()
        _by_source.clear()
        _latency_sum = 0.0
        _latency_count = 0
