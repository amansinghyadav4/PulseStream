# PulseStream — Redis Analytics (Phase 4)

## Purpose

Redis provides **low-latency counters and short-lived aggregation** for real-time analytics. PostgreSQL remains the **source of truth** (`events` table `app/models/event.py:14` `event_id UNIQUE`); Redis is cache/counter only, never primary store. If Redis is unavailable, analytics gracefully degrades to in-memory `Counter` (`app/services/analytics_service.py:12` fallback) and ingestion still succeeds (201).

## Key schema

All keys prefixed with `redis_key_prefix` (`pulsestream:` `app/core/config.py:34` / `.env.example:17` `REDIS_KEY_PREFIX`).

| Key | Type | Operation | TTL | Purpose |
|-----|------|-----------|-----|---------|
| `pulsestream:analytics:total` | String (int) | `INCR` | none | `events_processed_total` |
| `pulsestream:analytics:by_type` | Hash | `HINCRBY field event_type 1` | none | `events_by_type` (e.g., `order.created: 5`) |
| `pulsestream:analytics:by_source` | Hash | `HINCRBY field source 1` | none | `events_by_source` |
| `pulsestream:analytics:per_minute:{YYYY-MM-DDTHH:MM}` | String (int) | `INCR` + `EXPIRE 120` | 120s (`redis_per_minute_ttl` `app/core/config.py:36`) | `events_per_minute` — minute-bucket, expires after 2 minutes to bound memory |
| `pulsestream:seen:{event_id}` | String `1` | `SET NX EX 86400` | 86400s (24h) (`redis_idempotency_ttl` `app/core/config.py:35`) | Idempotency metadata — prevents double-counting duplicate `event_id` deliveries (at-least-once) |

### Atomicity

`record_event` `app/services/analytics_service.py:28` does:

```
SET seen:{event_id} NX EX 86400  → if not set (0), skip (duplicate)
PIPELINE:
  INCR total
  HINCRBY by_type
  HINCRBY by_source
  INCR per_minute:{minute}
  EXPIRE per_minute 120
EXEC
```

Pipeline makes counters atomic per event; `SET NX` ensures exactly-once counting per `event_id` within TTL window.

## Idempotency and duplicate handling

- **PostgreSQL** remains idempotency boundary for persistence (`ON CONFLICT DO NOTHING` `app/services/event_consumer_service.py:42`), but analytics counters would double-count on redelivery if not for Redis `seen` check.
- **Redis `seen:{event_id}`** with `NX` + `EX 86400` ensures second delivery of same `event_id` (at-least-once) does **not** increment `total/by_type/by_source/per_minute` (`tests/test_analytics_redis_unit.py:30` `test_duplicate_event_id_does_not_double_count`).
- **TTL trade-off:** 24h bounds memory (e.g., 1M `seen` keys × ~50B ≈ 50MB). After TTL expiry, an old `event_id` redelivered after 24h would be recounted — acceptable for real-time analytics (dashboard focuses on recent, PG remains truth). Shorter TTL saves memory but increases double-count risk for late redeliveries; 24h balances. Documented `app/core/config.py:35` `REDIS_IDEMPOTENCY_TTL=86400`.

## `events_per_minute` — minute-bucket + TTL (simpler, no ZSET)

- Bucket key `per_minute:{minute}` where `minute = timestamp.strftime("%Y-%m-%dT%H:%M")` `app/services/analytics_service.py:15` truncated to minute in UTC.
- `INCR` per event in that minute, `EXPIRE 120` ensures bucket auto-deletes after 2 minutes (covers current + previous minute for dashboard).
- **Why not ZSET:** `ZADD` + `ZREMRANGEBYSCORE` + `ZCARD` with scores = timestamps would give exact sliding 60s window, but requires `ZREMRANGE` on each read and more complexity. Minute-bucket + TTL is simpler, O(1) `INCR`/`GET`, and sufficient for dashboard `events per minute` (approx, per-minute granularity). Documented trade-off: not per-second precise, but dashboard shows per-minute and spec §11 allows `events per minute`.

## Graceful degradation

- `app/redis/client.py:14` `get_redis()` lazy, `ping` check, returns `None` if `REDIS_ENABLED=false` or `redis-cli ping` fails (like `Kafka` graceful `app/kafka/consumer.py:41`).
- `record_event` `app/services/analytics_service.py:28` `try: redis = await get_redis(); if redis is not None: ...` else `except: fallback` → in-memory `Counter` `_total/_by_type/_by_source` `app/services/analytics_service.py:12` with `asyncio.Lock`. So `POST /events` still 201 even if Redis down, and `GET /api/v1/analytics` falls back to in-memory `get_metrics()` `app/services/analytics_service.py:62`.
- `GET /health` always 200; `GET /ready` checks PG only (`app/api/routes_health.py:16`), Redis down does **not** make `ready` 503 (soft dependency, documented).

## API

| Method | Canonical | Legacy | Description |
|--------|-----------|--------|-------------|
| `GET` | `/api/v1/analytics` | `/analytics` | `{total, events_by_type, events_by_source, events_per_minute}` from `analytics_service.get_metrics()` (Redis or fallback) `app/api/routes_analytics.py:10` |

No rate limiting in Phase 4 — explicitly deferred (`README.md:44` style for `/metrics`), documented here.

## Verification

```bash
docker compose up -d postgres kafka redis
docker exec pulsestream-redis redis-cli ping  # PONG
docker exec pulsestream-redis redis-cli INFO | grep connected_clients
# After POST
docker exec pulsestream-redis redis-cli GET pulsestream:analytics:total
docker exec pulsestream-redis redis-cli HGETALL pulsestream:analytics:by_type
docker exec pulsestream-redis redis-cli TTL pulsestream:seen:{event_id}  # 86400
docker exec pulsestream-redis redis-cli TTL pulsestream:analytics:per_minute:2026-08-24T12:00  # 120
# Fallback
docker compose stop redis && curl -X POST http://localhost:8000/api/v1/events -d '{...}' # still 201
```

Unit: `tests/test_analytics_redis_unit.py` 6 tests with `fakeredis` `FakeAsyncRedis` (`pip install fakeredis`), `tests/test_analytics_api.py` 3 tests. Live: `live_redis_verify.py` POST 2 events → `GET /api/v1/analytics` `total=2`, duplicate `POST` same `event_id` → 409 and `total` stays 2, `TTL` checks, `redis-cli ping` healthy, fallback when `docker stop redis` still 201.

## What is NOT Phase 4

- No `dashboard cache` beyond analytics endpoint, no `events_failed_total` yet (will be Phase 6 with `retry.py` `events_failed_total` increment on DLQ), no `api_clients` table, no WebSockets/React.
