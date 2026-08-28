# PulseStream

Real-time event processing & analytics platform — Phase 8 (production images & cloud path) complete through Phase 7 benchmarks; AWS execution pending operator runbook.

## Stack

- Python 3.12 / FastAPI / Pydantic v2
- SQLAlchemy 2 (async) + asyncpg on PostgreSQL 16
- Apache Kafka 3.9 (KRaft) + aiokafka
- Redis 7 + redis-py (asyncio) + fakeredis
- React 18 + TypeScript + Vite (dashboard), WebSocket live updates
- pytest / pytest-asyncio / httpx / vitest

## Quickstart

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt -r requirements-dev.txt
copy .env.example .env   # adjust if needed

docker compose up -d     # starts PostgreSQL 16 + Kafka 3.9 + Redis 7 + api + frontend
.\.venv\Scripts\uvicorn app.main:app --reload   # or use the compose `api` service on :8001
```

Dashboard: **http://localhost:3000** (nginx container, proxies /api and /ws to the API).

/metrics + structured JSON logs + dependency-aware /ready + containerized self-healing workers — see docs/reliability.md.
Real consumer lag is exported as `pulsestream_consumer_lag{group,partition}` on /metrics and
surfaced by `/api/v1/analytics` (`consumer_lag`, sampled from worker heartbeats every ~10s).
Tables are created automatically at startup outside production (`app_env != production`).

Kafka topics are auto-created: `application-events` (6 partitions, RF 1) and `dead-letter-events` (DLQ) — see `docs/kafka-topics.md`.
Redis analytics: `pulsestream:analytics:*` + `pulsestream:seen:*` (24h TTL) — see `docs/redis.md`.

## API

Canonical endpoints per spec §4.1 live under `/api/v1`; legacy routes without prefix are kept for compatibility and will be removed in a future major version.

| Method | Canonical (`/api/v1`) | Legacy | Description |
| ------ | --------------------- | ------ | ----------- |
| GET    | `/api/v1/health`      | `/health` | Liveness |
| GET    | `/api/v1/ready`       | `/ready` | Readiness (checks database; Redis down is degraded not 503) |
| POST   | `/api/v1/events`      | `/events` | Ingest a single event (201) |
| POST   | `/api/v1/events/batch` | `/events/batch` | Ingest up to 1000 events (201) |
| GET    | `/api/v1/events?limit=&offset=` | `/events?...` | Recent events, newest first (PostgreSQL) |
| GET    | `/api/v1/events/{id}` | `/events/{id}` | Fetch one event by UUID |
| GET    | `/api/v1/analytics`   | `/analytics` | Analytics metrics from Redis (fallback in-memory) |
| GET    | `/api/v1/failures`    | `/failures` | Terminal processing failures (DLQ audit), newest first |
| WS     | `/api/v1/ws`          | `/ws` | Live metrics broadcast (~1s), `{"type":"metrics","data":{...}}` |

Errors use a single envelope: `{"error": {"code", "message", "details"}}`.
Duplicate `event_id` returns 409 `duplicate_event`; bodies above
`MAX_BODY_BYTES` (default 1 MiB) return 413 `payload_too_large`.

### Authentication (event ingestion)

`POST /api/v1/events` and `POST /api/v1/events/batch` require an API key when
one or more keys are configured:

```powershell
# .env — comma-separated; EMPTY/UNSET disables auth entirely (local dev default)
PULSESTREAM_API_KEYS=ps_demo_key_local
curl -X POST http://localhost:8001/api/v1/events -H "X-API-Key: ps_demo_key_local" ...
```

- Missing key → `401 {"error":{"code":"missing_api_key"}}`
- Wrong key → `401 ... "invalid_api_key"` (constant-time compare; the presented
  key is never echoed or logged)
- Valid key + invalid payload → still `422 validation_error`
- In the compose stack the development key is injected **server-side** by each
  site's nginx (`X-API-Key` on `/api/` proxying), so browsers never hold even
  the dev key. Production: set real secrets via `PULSESTREAM_API_KEYS`;
  they stay server-side.

**Intentionally public** (no auth): `/health`, `/ready`, `/metrics`,
`/analytics`, `GET /events*` (dashboard reads), and WebSocket endpoints.
Rationale: operational visibility for the dashboard; only *writes from external
producers* cross the trust boundary today.


### Kafka pipeline (Phase 2)

- **Producer:** `POST /events` validates, commits to PostgreSQL (source of truth), then publishes to `application-events` with key `user_id → source → event_id` (at-least-once, `acks="all"` + idempotence, non-fatal on broker down).
- **Consumers:** Two independent groups on the same topic — `persistence-workers` (idempotent `INSERT ... ON CONFLICT DO NOTHING` on `event_id`, then commit) and `analytics-workers` (Redis `total/by_type/by_source/per_minute` with `seen:{event_id}` idempotency, fallback in-memory). Manual `enable_auto_commit=False`, commit only after successful handler or terminal DLQ.
- **DLQ:** `dead-letter-events` receives poison/malformed events after bounded retry (max 3, backoff 100ms→400ms→1600ms) or directly for permanent `ValueError` (no endless retry). Payload never logged, broker unavailable backoff 5s.
- See `docs/kafka-topics.md` for partition strategy (6 partitions, per-user ordering, hot-partition trade-off) and `docs/redis.md` for Redis key schema/TTLs.

### Real-time dashboard (Phase 5, redesigned UI)

- **UI:** dark observability-grade design system (token CSS, sidebar navigation,
  KPI cards, live SVG throughput chart of session-observed values, distribution
  bars, health tiles) — zero new runtime dependencies; all metrics remain
  strictly real (unavailable metrics render as "Unavailable", never invented).
- **WebSocket:** `/api/v1/ws` (+ legacy `/ws`) broadcasts `{"type":"metrics","data":{...}}` ~every 1s from the Redis analytics state (`app/services/broadcaster.py`). Browser never consumes Kafka.
- **Dashboard areas:** Overview, Event throughput, Event types, Event sources, Processing latency, Failure rate, Recent events, System health — all backed by real metrics.
- **Metric traceability** documented in `docs/dashboard.md`.
- **Degraded mode:** WS disconnect → exponential reconnect (1s→2s→4s) + REST polling fallback of `/api/v1/analytics` (polling resumes automatically on disconnect); recent events via REST polling every 2s with load-more paging.

## Tests

```powershell
.\.venv\Scripts\pytest -m "not integration"   # unit only, no DB needed
.\.venv\Scripts\pytest                        # full suite, needs PostgreSQL up
```

Integration tests skip automatically when PostgreSQL is unreachable.

## Load testing (Phase 7)

```powershell
docker compose up -d && docker compose restart api persistence-worker analytics-worker
.\.venv\Scripts\python.exe load-tests\benchmark.py            # full ladder, writes load-tests/results/
.\.venv\Scripts\python.exe load-tests\loadgen.py --url http://localhost:8001 --mode batch --rate 5000 --duration 20
```

Measured on the run-of-record machine (see `docs/load-testing.md` for methodology,
environment, and bottleneck analysis): batch ingest sustains ~4.8K events/s at p95 1.5s and
~7K events/s saturated; single-event ingest saturates ~50/s (per-request PG commit + Kafka ack);
persistence worker drains ~370 events/s idle (per-event commits — bursts convert to backlog).
Numbers are machine-specific; do not quote them as general performance claims.

## Production deployment (Phase 8)

Backend ships as a proper multi-stage image (`Dockerfile`): deps resolved in a
builder venv, non-root runtime user, baked-in liveness healthcheck — one image
for api and both workers (command differs per service).

```powershell
docker build -t pulsestream-backend:latest .
docker build -t pulsestream-frontend:latest ./frontend
```

`infra/docker-compose.prod.yml` runs the full topology from built images with
`APP_ENV=production`, required-var enforcement for credentials, log rotation,
and no source mounts. In production the app **skips auto table creation** and
**fails fast** if any endpoint (DATABASE_URL / KAFKA / REDIS) is still at its
development default (`app/core/config.py` validator).

For AWS: see `infra/aws/README.md` (EC2 + compose runbook, security groups,
upgrade/rollback, managed-services upgrade path).

## Documentation map

| Doc | Contents |
|---|---|
| `docs/architecture.md` | As-built topology diagram, component inventory, end-to-end event flow, guarantees |
| `docs/load-testing.md` | Benchmark methodology, ladder results, bottleneck analysis (measured numbers only) |
| `docs/kafka-topics.md` | Topic/partition/key design and trade-offs |
| `docs/redis.md` | Redis key schema, TTLs, idempotency gates |
| `docs/dashboard.md` | Metric traceability: source → calculation → transport → display |
| `docs/reliability.md` | Health/readiness semantics, metrics catalog, failure matrix results |
| `docs/event-simulator.md` | Built-in demo traffic generator (UI), safe limits, demo script |
| `docs/demo-store.md` | Demo e-commerce client — a simulated PulseStream customer |
| `PulseStream_LEARNING.md` | Engineering log: decisions, failures, interview prep |
| `infra/aws/README.md` | Cloud deployment runbook (operator-executed) |

## Configuration

See `.env.example`. All variables have safe development defaults;
`DATABASE_URL` must be provided in production.

| Variable | Default | Purpose |
|----------|---------|---------|
| `KAFKA_TOPIC` | `application-events` | Primary topic |
| `KAFKA_DLQ_TOPIC` | `dead-letter-events` | DLQ |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Broker |
| `KAFKA_GROUP_ID` | `persistence-workers` | Default consumer group (analytics uses `analytics-workers`) |
| `KAFKA_AUTO_OFFSET_RESET` | `earliest` | Consumer offset reset |
| `KAFKA_ENABLE_AUTO_COMMIT` | `false` | Manual commit |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis |
| `REDIS_ENABLED` | `true` | Redis toggle |
| `REDIS_KEY_PREFIX` | `pulsestream:` | Key prefix |
| `REDIS_IDEMPOTENCY_TTL` | `86400` | `seen:{event_id}` TTL 24h |
| `REDIS_PER_MINUTE_TTL` | `120` | `per_minute:{minute}` TTL 2m |


