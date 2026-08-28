# PulseStream — Reliability & Operations (Phase 6)

## Health model

| Endpoint | Type | Checks | Failure semantics |
|---|---|---|---|
| `GET /health` (+`/api/v1`) | **Liveness** | none — answers "is this process alive" | always 200 while process serves |
| `GET /ready` (+`/api/v1`) | **Readiness** | per-dependency probes (below) | PG down → **503 not_ready**; any soft dep down → **200 degraded** |

Readiness payload:

```json
{"status": "ready|degraded|not_ready", "dependencies": {
  "postgres":  {"status": "healthy|unhealthy", "latency_ms": 2.3},
  "redis":     {"status": "healthy|unavailable"},
  "kafka":     {"status": "healthy|degraded|disabled"},
  "workers":   {"persistence_worker": {...}, "analytics_worker": {...},
                "note": "heartbeat via redis; redis unavailable => worker status unknown"},
  "broadcaster": {"status": "running|stopped", "websocket_clients": N}
}}
```

Semantics preserved from earlier phases: PostgreSQL is the only hard gate; Redis/Kafka remain soft (ingest stays 201 during outages).

### Worker heartbeat

Workers write `pulsestream:worker_heartbeat:{persistence|analytics}` every 10s with TTL 30s
(`app/services/heartbeat.py`) as a JSON payload `{ts, group, lag:{partition:int}}` (Phase 7).
Readiness reports `healthy` only if a fresh key exists — never fabricated.
If the heartbeat write fails 3× consecutively, the worker force-restarts its Kafka consumer
(self-heal against wedged aiokafka sessions). Compose healthchecks run
`scripts/worker_healthcheck.py <name>` inside each worker container.

## Structured logging

All services emit one JSON object per line (`app/core/logging.py`):

```json
{"timestamp":"2026-08-24T20:41:19.587469+00:00","level":"INFO","logger":"app.api.ws","message":"broadcasting","type":"metrics","clients":0}
```

Standard fields: `timestamp` (ISO-8601 UTC), `level`, `logger`, `message`. Any safe `extra={...}`
metadata (event_id/event_type/source/counts) passes through verbatim. Payload-free contract unchanged
and enforced by existing caplog tests plus formatter test.

## Metrics (`/metrics`, `/api/v1/metrics`)

Prometheus text format (`prometheus-client`). Traceability: SOURCE → CALCULATION → TRANSPORT → DISPLAY.

| Metric | Source / hook |
|---|---|
| `pulsestream_http_requests_total{method,path,status}` | ASGI middleware on real responses |
| `pulsestream_http_request_latency_seconds{method,path}` | same, histogram |
| `pulsestream_events_processed_total` | incremented in worker persist success path (`event_consumer_service.persist_event`, incl. idempotent duplicates) |
| `pulsestream_events_failed_total` | terminal DLQ hook (`record_failed`, called by retry/consumer DLQ success paths) |
| `pulsestream_websocket_connections` | `ConnectionManager` active count on connect/disconnect |
| `pulsestream_worker_heartbeat{worker=persistence\|analytics}` | gauge refreshed at scrape from real Redis heartbeat freshness (1 fresh / 0 stale) |
| `pulsestream_consumer_lag{group,partition}` | Phase 7: real lag (broker highwatermark − consumer position) written by each worker into its heartbeat payload every 10s, refreshed at scrape (`KafkaEventConsumer.lag_snapshot`) |

Not exposed (honest gaps): exact per-second throughput,
end-to-end latency. See `docs/dashboard.md` for definitions and limitations.

## Docker topology

`postgres`, `kafka`, `redis` (unchanged, healthy) + `api` (:8001→8000), `frontend` (:3000→80),
`persistence-worker`, `analytics-worker`. Workers share the app image/code and run their existing
module commands — no topic/group/partition changes. All app services use `restart: unless-stopped`
and real healthchecks (api liveness URL, frontend HTTP fetch, workers = Redis heartbeat script).

## Verified failure matrix (tests/test_failure_matrix_integration.py)

| Scenario | Verified behavior |
|---|---|
| stop/start Redis | POST still 201 (in-memory fallback); ready degraded(200) → ready after recovery |
| stop/start PostgreSQL | ready 503 not_ready → recovers to 200 |
| stop/start Kafka | POST bounded (~≤5s publish cap) still 201; broker recovers healthy |
| kill persistence-worker | event published during downtime NOT lost; redelivered & persisted after recovery (at-least-once) |
| malformed message | terminal DLQ + commit; no poison loop; both workers stay up |
| duplicate event_id | API 409; Redis `seen:{event_id}` present → analytics counted once |
| WS disconnect/reconnect | broadcast received on first connection and after reconnect |

Reliability fixes made during verification:
1. Producer publish now hard-bounded (`asyncio.wait_for(...,5)`); wedged producer is discarded and lazily re-bootstrapped so broker restarts recover publishing automatically.
2. Redis client retries reconnects every 5s instead of latching unavailable forever.
3. Analytics worker gained DLQ parity (malformed/poison no longer blocks partition commits).
4. Workers self-restart their consumer after repeated heartbeat failures.

## Known limitations / deferred

- Exact per-second rate and end-to-end latency: unavailable by design (documented, not faked).
  Consumer lag became available in Phase 7 via worker heartbeats + `/metrics` gauges.
- Rate limiting, authentication: deferred (not Phase 6 scope).
- Alembic, AWS: later phases. Load testing completed in Phase 7 — see `docs/load-testing.md`.
