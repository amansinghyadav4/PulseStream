# PulseStream — LEARNING.md

> This file is a living engineering notebook.
>
> **Purpose:** Help Aman understand the project deeply enough to explain every architectural decision in interviews and technical discussions.
>
> **Rule:** Do not turn this into generic documentation. Explain what WE built, why we built it, what alternatives existed, what failed, and what was learned.

---

# 1. Project Overview

## What problem does this project solve?

Modern applications emit a continuous storm of events (orders, payments, page
views, service telemetry). Writing each one synchronously to a database couples
the frontend's latency to storage and falls over under bursts. PulseStream is an
infrastructure-style pipeline that **ingests events over HTTP, buffers them in
Kafka, processes them asynchronously with idempotent workers, and serves
real-time analytics** — so ingestion stays fast even when processing falls
behind, and nothing is lost or double-counted.

## What does the system do from end to end?

A client POSTs a JSON event → FastAPI validates it and commits it to PostgreSQL
(the contract; duplicate `event_id` → 409) → publishes to Kafka (`acks="all"`,
bounded 5s, non-fatal) → two independent consumer groups process the stream:
persistence-workers write idempotently into PG, analytics-workers update Redis
counters behind a dedup gate → a broadcaster pushes metric snapshots to
dashboards over WebSocket every second → the React dashboard shows live totals,
throughput, types/sources, latency, failure rate, recent events, health.
Failures at any stage follow explicit rules: retry transient errors with backoff,
dead-letter poison, never commit offsets until terminal success.

## Why was this architecture chosen?

- **Kafka between ingest and processing** absorbs bursts (measured: ingest
  accepts 7K ev/s while persistence drains ~368/s — the backlog is safe).
- **At-least-once + idempotency** instead of exactly-once: simpler brokers,
  correctness restored at the edges via PG unique constraint and Redis `seen`
  keys. Honest about semantics rather than claiming magic.
- **Two consumer groups on one topic** demonstrates decoupled scaling of
  storage vs analytics concerns from the same stream.
- **Redis for hot counters, PostgreSQL for truth**: sub-millisecond dashboards
  without weakening durability.
- **Everything env-driven and gracefully degrading** so the same code runs on a
  laptop, in compose, and on a cloud host unchanged.

---

# 2. Architecture

See `docs/architecture.md` for the authoritative diagram + component table +
end-to-end flow. Summary of the implemented topology:

producers → FastAPI api → PostgreSQL (truth) + Kafka `application-events`
(6 partitions) → persistence-workers + analytics-workers (independent groups)
→ PG rows / Redis counters → WebSocket broadcaster → React dashboard.
Poison messages end in `dead-letter-events`. Workers heartbeat (with real
consumer lag) through Redis every 10s; `/ready`, `/metrics`, and `/analytics`
all read that state. Production packaging: multi-stage non-root image,
prod compose with required-var secrets, EC2 runbook under `infra/aws/`.

Component-by-component details (role, inputs, outputs, failure behavior,
technology choice) live in the component inventory table of
`docs/architecture.md`; they are kept there to avoid two copies drifting.

---

# 3. Data Flow

One event, beginning to end (numbers reference docs/architecture.md):

```text
client JSON
   ↓ (1) Pydantic validation/normalization      ← bad shape → 422 envelope
   ↓ (2) body-size middleware                    ← >1 MiB → 413 before handler
   ↓ (3) PG INSERT (event_id UNIQUE)             ← duplicate → 409 envelope
   ↓ (4) Kafka produce acks=all ≤5s              ← broker down → log + continue
   ↓ (5) HTTP 201 to client                      ← DB row IS the acknowledgement
   ↓ (6) fan-out: both consumer groups read independently
   ├─→ (7a) persistence: INSERT … ON CONFLICT DO NOTHING → commit offset
   └─→ (7b) analytics: SET seen:{id} NX gate → INCR pipeline → commit offset
   ↓ (8) failures branch: transient→retry×3 backoff→DLQ; malformed→DLQ now;
         offset commits ONLY after terminal success (else redelivery)
   ↓ (9) broadcaster snapshots metrics → WS frames → dashboard ~1s later
```

Every arrow exists in code and is exercised by a test: arrows 1–5 by API
integration tests, arrow 6 by independent-groups tests, arrow 7a idempotency by
duplicate-delivery tests, arrow 7b by fakeredis unit tests, arrow 8 by
retry/DLQ unit tests AND the live failure matrix, arrow 9 by WS tests.

---

# 4. Technology Deep Dive

## FastAPI (+ Pydantic v2, uvicorn)

### Why we use it
Async-native Python framework with automatic request validation — the ingestion
path is I/O-bound (PG + Kafka round trips per event), exactly what asyncio is for.

### What problem it solves
High-concurrency HTTP ingestion without thread pools; schema validation at the
boundary so route handlers stay thin.

### How we use it in this project
`POST /events` single+batch (all-or-nothing ≤1000), GET by id / recent,
`/health` `/ready` `/analytics` `/metrics`, native WebSocket endpoint. Custom
exception handlers render one error envelope everywhere. Lifespan owns
producer/broadcaster/redis/engine startup-shutdown.

### Alternatives
Flask (sync, would need gunicorn threads), Django (ORM/admin weight irrelevant),
Go (faster per-core but slower to iterate; team language is Python).

### Why we did not choose the alternatives
Validation duplication in Flask; Django's batteries unneeded; staying in one
language across api/workers/tests outweighs raw per-request speed at this scale
(bottleneck measured as storage latency, not framework overhead).

### Interview questions
- Why async for an ingest API? → I/O-bound waits (commit+produce) dominate; one
  process serves thousands of concurrent slow requests without threads.
- Where does validation live and why? → Pydantic schemas at the boundary; the
  422 envelope is generated from real pydantic errors.

## PostgreSQL 16 + SQLAlchemy 2 async (asyncpg)

### Why we use it
The durable source of truth; the UNIQUE constraint on `event_id` is not just a
storage rule — it IS the idempotency mechanism for both API and worker writes.

### How we use it in this project
`Mapped`/`mapped_column` models, `created_at` indexed for newest-first queries,
`INSERT … ON CONFLICT DO NOTHING` in the persistence worker, rowcount-based
duplicate detection. `create_all` only outside production (Alembic deferred).

### Alternatives
MongoDB (no cheap unique-constraint idempotency story for this shape),
MySQL (equivalent, no advantage), Cassandra (wrong access patterns).

### Interview questions
- Why is ON CONFLICT DO NOTHING central here? → duplicate Kafka delivery and
  API-originated rows collapse into one insert attempt; commit still happens.
- Why index created_at? → dashboard "recent events" query pattern.

## Apache Kafka 3.9 (KRaft) + aiokafka

### Why we use it
Burst absorption, durable replayable log, consumer-group fan-out — the backbone
that decouples a 50/s-capable storage writer from a 7K/s-capable ingester.

### How we use it in this project
One primary topic (`application-events`, 6 partitions, key
user_id→source→event_id for per-user ordering) + DLQ topic. Producer: `acks=all`
+ idempotence, lazy init, publish capped at 5s with wedged-producer discard.
Consumers: manual commits, commit only after terminal success, per-worker lag
via `highwater() − position()` exported through heartbeats.

### Alternatives
RabbitMQ (queue semantics, weaker replay/partition model), Redis Streams
(fine for small scale, weaker ordering/durability guarantees story), Kinesis
(cloud lock-in during local dev).

### Interview questions
- Why partition by user_id? → per-user ordering guarantee; fallback chain keeps
  service events flowing; trade-off = hot partitions (documented).
- Manual vs auto commits? → auto-commit could mark work done before it is;
  manual + commit-after-success is what makes redelivery safe.
- Producer idempotence ≠ pipeline exactly-once — explain. → it dedups broker
  retries per producer session; end-to-end needs consumer-side idempotency too.

## Redis 7 (redis-py async, fakeredis in tests)

### Why we use it
Sub-ms counters for dashboards and a TTL-bounded dedup set — hot state that
would be wasted PG load.

### How we use it in this project
`SET seen:{event_id} NX EX 86400` gate, then atomic pipeline
(INCR total / HINCRBY type / HINCRBY source / INCR per-minute EXPIRE 120).
Heartbeats `{ts,group,lag}` every 10s power readiness + lag metrics. Client:
lazy connect, ping-guarded, bounded socket timeouts, 5s reconnect backoff.

### Alternatives
In-process dicts (don't survive restarts, don't share across replicas),
Memcached (no rich types/pipeline semantics needed here).

### Trade-off recorded
If `seen` SET succeeds but the counter pipeline fails, we keep `seen`
(at-most-once counting) — analytics may under-count rather than double-count;
PG remains truth. Chosen deliberately, documented in Phase 4.

### Interview questions
- Why TTL on seen keys? → bounds memory (~24h window); late duplicates after
  TTL are accepted risk for real-time analytics.
- What breaks if Redis dies? → honest fallback to in-memory counters;
  ingestion unaffected; heartbeats unknown (never faked healthy).

## WebSockets (native FastAPI) + React/Vite dashboard

### Why we use it
Push-based live dashboards without polling storms; browser never sees Kafka.

### How we use it in this project
ConnectionManager broadcasts ~1s metric snapshots read from analytics state;
exponential client reconnect (1→2→4s) with REST polling fallback. Eight spec'd
dashboard areas render "Unavailable" honestly when data is absent.

### Interview questions
- How would this scale past one api replica? → sticky sessions or a pub/sub fan-out
  (Redis pub/sub) between broadcaster and pods — noted as follow-up, single-node now.

## Docker / docker compose

### Why we use it
Reproducible topology (PG+Kafka+Redis+api+frontend+2 workers) locally AND as the
production deployment unit (prod compose from prebuilt images; EC2 runbook).

### How we use it in this project
Dev compose mounts code for iteration; prod image is multi-stage, non-root,
healthchecked; prod compose enforces required env vars and log rotation.

### Interview questions
- Why multi-stage? → toolchain (pip cache, build deps) never ships in the
  runtime layer; smaller attack surface.
- Healthchecks differ per service — how? → same image, compose overrides:
  HTTP liveness for api, Redis-heartbeat script for workers.

## pytest / pytest-asyncio / vitest / prometheus-client

### How we use them
146 backend tests (unit always run; integration/failure-matrix skip cleanly
without Docker), frontend component tests via vitest. prometheus-client gauges
refreshed at scrape time from live state (WS count, heartbeat freshness, lag).

---

# 5. Core Concepts I Need to Understand

Checklist state after Phases 1–8:

- [x] REST APIs (envelope errors, versioning /api/v1, batch semantics)
- [x] HTTP status discipline (409 vs 413 vs 422 vs 503)
- [ ] Authentication (deferred — documented non-feature)
- [x] PostgreSQL (async SQLAlchemy, ON CONFLICT idempotency, index-by-query-pattern)
- [x] Redis (NX gates, pipelines, TTL design, bounded reconnection)
- [x] Docker (multi-stage images, healthchecks, prod compose, EC2 path)
- [x] WebSockets (manager, broadcast resilience, reconnect strategy)
- [x] Kafka / event-driven architecture (partitions, groups, offsets, DLQ)
- [x] Distributed systems (at-least-once, idempotency, graceful degradation)
- [x] Observability (structured JSON logs, Prometheus, readiness vs liveness, real lag)
- [ ] Cloud deployment (runbook ready; actual AWS execution pending operator)
- [x] Load testing (open-loop generator, percentile methodology, bottleneck analysis)
- [x] Failure handling (retry/DLQ, kill-and-redeliver proven live)
- [x] Idempotency (constraint-based and gate-based implementations)
- [~] Scalability (consumer-group scaling demonstrated; multi-replica api not)

---

# 6. Important Engineering Decisions

## Error envelope everywhere

**Context:** inconsistent error shapes make clients brittle.
**Options:** per-route ad-hoc JSON / RFC problem-details / single envelope.
**Chosen:** `{"error": {code, message, details}}` via exception handlers.
**Why:** one contract, testable once. **Trade-off:** not a standard shape.
**Validated:** envelope asserted across integration tests.

## All-or-nothing batches (≤1000)

**Context:** partial batches corrupt counting semantics.
**Chosen:** validate+duplicate-check whole batch, single transaction, reject entirely.
**Trade-off:** one bad event blocks 999 good ones (client can retry).
**Validated:** batch tests incl. over-limit and in-batch duplicates.

## Partition key user_id→source→event_id

**Context:** ordering needs vs load distribution.
**Chosen:** per-user ordering with deterministic fallbacks.
**Trade-off:** hot partitions if one user dominates (documented in kafka-topics.md).

## At-least-once + edge idempotency (no exactly-once claims)

**Chosen:** manual commits after terminal success; PG unique constraint +
Redis seen-gate absorb duplicates. **Why:** honest, verifiable semantics.
**Validated:** live kill/redelivery failure-matrix test.

## Bounded retry then DLQ

**Chosen:** transient → 3 attempts (100ms→1.6s); permanent/malformed → DLQ
directly; DLQ success = terminal commit; DLQ failure = no commit (redelivery).
**Why:** poison messages must never block partitions forever.
**Validated:** retry/DLQ unit tests + malformed-message live test.

## WS broadcaster reads analytics state (not Kafka)

**Context:** browser must never consume Kafka; broadcaster needs decoupling.
**Chosen:** poll Redis-derived state at 1s. **Trade-off:** ≤1s staleness,
no per-event push granularity. **Validated:** dashboard verify script.

## Consumer lag via worker self-report (no Admin client)

**Context:** lag observability without new dependencies.
**Chosen:** aiokafka highwater−position inside each worker → heartbeat JSON →
/metrics gauges + /analytics field; honest absence when stale.
**Alternative rejected:** confluent-kafka AdminClient (heavy binary dep for one number).

## Open-loop load generation

**Context:** closed-loop tools self-throttle and hide saturation.
**Chosen:** fixed time-grid scheduling + completion-tail reporting.
**Validated:** single_1000 step exposed p99=14s collapse that closed-loop would have masked.

## Production fail-fast settings gate

**Context:** graceful degradation masks misconfiguration at boot in prod.
**Chosen:** validator rejects dev-default endpoints when APP_ENV=production.
**Trade-off:** explicit loopback requires 127.0.0.1 spelling (documented escape hatch).

## EC2 + compose as default cloud shape

**Chosen:** reproduces the exact tested topology on one host; managed-service
upgrade path documented (RDS/ElastiCache/MSK/Fargate = env-var changes).
**Rejected for now:** ECS/Fargate-first (many more moving parts before value).

---

# 7. Failures and Debugging

Full narratives live in each phase's "What confused me" below; this is the
consolidated index of real problems hit during the build (nothing here is
theoretical):

| # | Symptom | Root cause | Fix | Lesson |
|---|---|---|---|---|
| 1 | Producer `ModuleNotFoundError`/`RuntimeError` after adding aiokafka | `AIOKafkaProducer` needs a running loop; was created in `__init__` | lazy init inside async `start()` | async clients must be born where the loop lives |
| 2 | `insert(...)` lacks on_conflict_do_nothing | generic SQLAlchemy insert vs dialect-specific | `sqlalchemy.dialects.postgresql.insert` (`pg_insert`) | dialect features need dialect imports |
| 3 | Batch duplicates detected against wrong UUIDs | `resolved_event_id()` generated a fresh UUID per call | resolve once into `resolved_ids`, stabilize items (Phase 2F) | generate nondeterministic values exactly once |
| 4 | `ModuleNotFoundError: fakeredis.asyncio` | import path changed across fakeredis versions | `from fakeredis import FakeAsyncRedis` | pin + verify test-dep APIs, don't assume |
| 5 | Existing worker tests broke when get_metrics went async | Phase 4 made Redis path async | tests updated to `await` | changing sync→async ripples through every caller |
| 6 | vitest component crashed on unmocked fetch returning object | jsdom has no network | `Array.isArray(data)` guard + mock fetch in tests | defensive rendering is also correct in prod |
| 7 | Ingestion hung indefinitely during Kafka outage | unbounded `send_and_wait` | hard 5s cap + wedged-producer discard/re-bootstrap | every external call needs a deadline AND a recovery path (Phase 6) |
| 8 | Redis client stayed dead after outage recovery | availability latched False forever | bounded 5s reconnect retries | latching state machines need retry exits |
| 9 | One poison message blocked partition commits (analytics worker) | analytics lacked DLQ parity with persistence | wired dlq into analytics consumer too | parity across consumers sharing a contract must be explicit |
| 10 | Failure-matrix flake: /ready ReadTimeout during Redis outage | sequential dependency probes each waited OS TCP timeout (>10s via Docker proxy); no socket timeouts | explicit socket_connect/timeout=2s on client creation | health endpoints must be fast precisely when dependencies are down |
| 11 | lag_snapshot returned `{}` everywhere | Python 3.13 removed `asyncio.iscoroutine`; call raised AttributeError swallowed by except | `inspect.isawaitable()`; also aiokafka names it `highwater()` not `highwatermark()` | don't bury capability checks in broad excepts; verify library API names |
| 12 | Loadgen sent 8 requests instead of 800 | single mode still divided rate by default batch-size=100 | batch_size pinned to 1 for single mode | smoke-test the harness before trusting its numbers |
| 13 | Batch step returned 100% 422 | endpoint expects `{"events":[...]}` wrapper, generator posted bare array | fixed body shape; counted events correctly | read the actual contract, then assert status codes loudly |

Never hide failed approaches — items 7–13 were all found BY tests/benchmarks,
which is the testing strategy working as intended.

---

# 8. Performance

Record real benchmark results only.

| Test | Result | Environment | Notes |
|---|---:|---|---|
| Single ingest sustained | ~50 ev/s (p50 150ms client / 50.6ms server avg) | Win11 i5-12500H, Docker Desktop WSL2, single uvicorn | bounded by per-request PG commit + Kafka ack |
| Batch ingest (100/batch) @1K offered | 1,002 ev/s achieved, p99 146ms | same | one commit per batch amortizes cost |
| Batch ingest @5K offered | 4,809 ev/s achieved, p95 1.53s | same | API publish loop becomes visible |
| Batch ingest @10K offered | 7,016 ev/s achieved (saturated) | same | sequential per-event Kafka publish dominates (~1.22s server per request) |
| Persistence worker drain | ~368 ev/s idle system | same | one PG transaction per event; bursts → durable backlog |
| Analytics worker drain | keeps up (lag 0 after ladder) | same | Redis pipeline per event ≫ PG commit per event |

Full methodology, ladder table incl. error rates and lag spikes, bottleneck analysis:
`docs/load-testing.md`. Raw JSON: `load-tests/results/`.

Do not enter invented results.

---

# 9. Testing

Run of record: **146 passed, 0 failed** (2026-08-25, live stack). Unit-only mode:
`pytest -m "not integration"` needs no services; integration/failure-matrix
tests skip cleanly when Docker/Postgres is unreachable.

## Unit tests (~110)

**What:** schemas/validation, serialization round-trips, producer/consumer
contracts (acks, manual commit), retry/DLQ state machine, idempotent persist
(rowcount semantics), Redis counters with fakeredis incl. concurrent dedup,
heartbeat JSON payloads, lag math, percentile math, production settings gate.
**Why:** all pure logic must be provable without infrastructure.
**How:** fakes/mocks at process boundaries (FakeAsyncRedis, fake consumers).
**Result:** green in seconds; run on every change.

## Integration tests

**What:** API↔Postgres (ingest/fetch/duplicate/409/413/batch limits),
persistence worker↔PG redelivery, API versioning, Prometheus exposition.
**Why:** real SQL and real HTTP behavior differ from mocks.
**How:** httpx ASGI transport + Dockerized PG; skip cleanly if unreachable.

## End-to-end / failure matrix (`tests/test_failure_matrix_integration.py`, 7)

**What:** LIVE compose stop/start cycles — Redis down (fallback+recovery),
PG down (503→recover), Kafka down (bounded publish, recovery), worker kill
(at-least-once redelivery proven), malformed poison (terminal DLQ, no loop),
duplicate id (counted once), WS disconnect/reconnect.
**Why:** these are the promises the architecture makes; only a live broker can prove them.
**How:** pytest orchestrating `docker compose stop/start` + HTTP assertions.
**Found & fixed real bugs:** unbounded publish hang, redis reconnect latch, DLQ parity, self-heal restarts.

## Load tests (`load-tests/`)

**What:** open-loop ladder 100→10K ev/s with percentiles, error rates, consumer-lag sampling, resource snapshots, offset-based drain rates.
**Why:** resume metrics must come from somewhere real.
**Result:** docs/load-testing.md — machine-specific numbers, honest bottlenecks.

## Frontend (vitest + RTL)

3 component tests: renders 8 areas from mocked metrics, degraded/loading states,
no direct Kafka client. `npm run build` gates type errors too.

---

# 10. Security

Honest status after Phase 8. Authentication/rate-limiting/TLS remain deferred
non-features (documented in spec scope) — the list below is what EXISTS.

| Threat | Mitigation | Implementation | Limitation |
|---|---|---|---|
| Malformed/hostile payloads | strict schema validation at boundary | Pydantic v2 EventIn/EventBatchIn; 422 envelope leaks no internals | payload contents not deeply validated per event_type (spec: "where practical") |
| Oversized bodies DoS | request-size cap before handlers | BodySizeLimitMiddleware, default 1 MiB → 413 | per-event count cap ≤1000 also enforced |
| Sensitive data in logs | structured allowlist logging | only event_id/event_type/source (+safe extras); asserted by caplog tests | relies on discipline; formatter passes safe extras |
| Secrets in source/repo | env-only configuration | pydantic-settings + .env (gitignored), `.env.example` template; prod compose `${VAR:?}` required vars | .env on host is plaintext (chmod 600 in runbook) |
| Silent prod misconfiguration | fail-fast gate | validator rejects dev-default DB/Kafka/Redis URLs when APP_ENV=production | exact-string matching (127.0.0.1 escape hatch documented) |
| Unauthenticated write access | NONE YET | — | **known gap**: anyone with network reach can POST events; auth explicitly deferred |
| Abuse volume | NONE YET | body/count caps only, no rate limiting | **known gap**, deferred |
| Transport interception | NONE YET (dev/LAN posture) | TLS termination listed as ALB/Caddy follow-up in AWS runbook | **known gap** for public serving |
| Container privilege escape | non-root runtime user | Dockerfile `USER pulsestream`; no source mounts in prod compose | single-host topology still shares kernel |
| CORS abuse | explicit origin allowlist | CORS_ORIGINS setting → CORSMiddleware | dashboard origin must be kept current in prod env |

---

# 11. Deployment

```text
developer machine ──▶ docker compose (dev: code mounts, auto create_all)
        │
        ├─▶ docker build  → pulsestream-backend / -frontend images (multi-stage, non-root)
        ▼
docker compose -f infra/docker-compose.prod.yml   (APP_ENV=production,
        │                                          required-var secrets, log rotation)
        ▼
any Docker host — documented target: one EC2 instance via infra/aws/runbook
                   (user-data installs Docker + clones; secrets added over SSH)
```

- Environment variables: every dependency endpoint/config is env-driven
  (`.env.example` documents all); nothing hardcoded. Production REQUIRES real
  endpoints (fail-fast gate).
- Networking: only api (:8000) + frontend (:80) publish host ports in prod;
  PG/Kafka/Redis are compose-network-only. Kafka PLAINTEXT never exposed.
- Data: pgdata named volume; Redis intentionally ephemeral (analytics only).
- Observability in deployment: /health liveness, /ready dependencies,
  /metrics scrape endpoint, JSON logs rotated by docker json-file driver.
- Deploy = rebuild image + `up -d`; rollback = retag previous SHA image
  (discipline described in infra/aws/README.md). Alembic needed before any
  multi-version schema rollout (tracked gap).
- NOT done: actual cloud execution (operator-run), HA/TLS/managed services —
  upgrade path documented, not claimed.

---

# 12. Interview Preparation

## Explain the project in 30 seconds

"PulseStream is a real-time event-processing platform I built end-to-end.
Services POST events to FastAPI, which validates them and commits to PostgreSQL,
then publishes to Kafka. Two independent consumer groups process the stream —
one persists idempotently into Postgres, one maintains Redis counters that feed
a WebSocket-driven React dashboard. It's at-least-once by design with
idempotency at the edges, has retry plus dead-letter handling for poison
messages, exposes Prometheus metrics including real consumer lag, and ships as
production Docker images with a documented AWS deployment path. I load-tested
it with an open-loop generator and found the actual bottlenecks."

## Explain the project in 2 minutes

Cover, in order: the problem (bursty event storms; sync writes couple frontend
latency to storage) → ingest path (validation, PG commit is the client contract,
duplicate → 409 via unique constraint; Kafka publish acks=all but bounded and
non-fatal so broker outages never fail clients) → processing (two consumer
groups on one 6-partition topic, manual commits only after terminal success;
transient failures retried with bounded backoff then DLQ; malformed messages
straight to DLQ; offsets committed after DLQ too, so partitions never wedge)
→ idempotency story (at-least-once delivery absorbed by ON CONFLICT DO NOTHING
and a Redis seen-key gate with TTL) → analytics serving (Redis counters read by
/analytics and pushed over WS ~1s; REST fallback polling) → observability
(structured JSON logs with ids only, /ready dependency ladder where only PG is
a hard gate, Prometheus counters/gauges incl. consumer lag self-reported by
workers through heartbeats — no Admin client needed) → testing (146 tests;
live failure matrix stops containers and proves redelivery/recovery) →
performance (open-loop load generator; measured single-host numbers; identified
per-request-commit bound and persistence drain rate as bottlenecks) → packaging
(multi-stage non-root image, prod compose with fail-fast settings gate, EC2 runbook).

## Explain the architecture

Walk docs/architecture.md top to bottom: topology diagram → component inventory
(what enters/leaves/fails per component) → the numbered end-to-end event flow →
behavioral guarantees (at-least-once, degradation ladder) → measured performance
→ deliberate non-features.

## Most likely interviewer questions (22)

1. **Why Kafka instead of writing straight to Postgres?**
   *Short:* burst absorption + decoupling ingest speed from storage speed.
   *Deep:* measured ingest accepts ~7K ev/s batched while persistence drains
   ~368/s; Kafka holds the difference safely and replays it. Also fan-out:
   two groups consume independently without double work at the producer.
   *Example:* `single_1000` step — clients stayed fast while backlog grew.
2. **At-least-once vs exactly-once — what does PulseStream actually guarantee?**
   *Short:* at-least-once, made safe by edge idempotency.
   *Deep:* aiokafka manual commits after handler success mean crashes redeliver;
     exactly-once would need transactional consumers/producer or idempotent store
     semantics everywhere. We get equivalent observable behavior cheaper.
   *Example:* worker-kill failure test: event published during downtime persisted exactly once after restart.
3. **Where is idempotency implemented?**
   *Short:* two places — PG unique constraint, Redis seen-gate.
   *Deep:* persistence uses INSERT…ON CONFLICT DO NOTHING (rowcount 0 = dup =
     success); analytics SETs `seen:{event_id} NX EX 86400` before counting.
   *Example:* duplicate-delivery unit tests + live duplicate test.
4. **Why manual Kafka commits?**
   *Short:* auto-commit could mark unprocessed work as done.
   *Deep:* enable_auto_commit=False + commit-after-terminal-success means any
     crash before commit = redelivery = no loss; combined with idempotency = no duplicates either.
   *Example:* app/kafka/consumer.py handle_raw flow.
5. **How do you avoid poison-message loops?**
   *Short:* bounded retries, then DLQ with terminal commit.
   *Deep:* ValueError-classified permanent errors skip retries entirely;
     transient retry ×3 (0.1→0.4→1.6s); after DLQ send succeeds the offset
     commits; if DLQ itself fails we DON'T commit (prefer redelivery).
   *Example:* tests/test_kafka_retry_unit.py malformed/exhaustion cases.
6. **How did you choose partition count/key?**
   *Short:* key user_id→source→event_id; 6 partitions dev default.
   *Deep:* key gives per-user ordering; fallback chain avoids null-key
     round-robin surprises for service events; hot-partition trade-off documented.
   *Example:* docs/kafka-topics.md.
7. **What happens when Redis dies mid-flight?**
   *Short:* analytics falls back to in-memory; ingestion unaffected; nothing fakes healthy.
   *Deep:* get_redis() ping-guarded with bounded socket timeouts + 5s reconnect
     backoff; record_event catches and falls back; /ready reports redis degraded/unknown honestly.
   *Example:* live redis stop/start failure-matrix test.
8. **And when PostgreSQL dies?**
   *Short:* hard failure — readiness 503, ingestion fails.
   *Deep:* PG is source of truth so it's the ONLY hard gate; workers stop
     committing and redeliver after recovery.
   *Example:* postgres stop/start test asserting 503 then recovery.
9. **Liveness vs readiness in your API?**
   *Short:* /health checks nothing (always 200 once up); /ready checks deps.
   *Deep:* only PG gates ready→503; Redis/Kafka soft-degrade with 200 +
     honest status fields; worker health comes from real heartbeat TTLs, never invented.
   *Example:* routes_health + failure-matrix assertions.
10. **How do you measure consumer lag without Kafka Admin?**
    *Short:* each worker computes highwater−position for its own assignment and
      heartbeats it to Redis every 10s.
    *Deep:* /metrics refreshes pulsestream_consumer_lag gauges from those
      payloads at scrape time; /analytics sums them; unknown partitions omitted
      rather than reported zero.
    *Example:* lag_snapshot() + heartbeat JSON payload.
11. **Why is your dashboard fed from Redis state instead of Kafka directly?**
    *Short:* browser must never see Kafka; decouples UI scale from stream scale.
    *Deep:* broadcaster polls analytics snapshot ~1s; N dashboards cost O(1) extra reads.
    *Example:* broadcaster.py + useWebSocket reconnect/fallback logic.
12. **Tell me about your load-test methodology.**
    *Short:* open-loop pacing, warmup windows, completion-based throughput, percentiles, tail reporting.
    *Deep:* closed-loop generators self-throttle and hide queueing collapse;
      scheduling on a fixed time grid exposed p99=14s at offered 1K/s single-mode
      while error rate stayed 0%.
    *Example:* loadgen.py behind_schedule/completion_tail_seconds fields.
13. **What bottlenecks did the benchmarks find?**
    *Short:* per-request commit latency caps single ingest ~50/s; persistence
      drains ~368/s; batch endpoint amortizes commits → 4.8K ev/s @ p95 1.5s.
    *Deep:* server-side histogram showed 50.6ms avg inside the app vs ~150ms
      client-side (Docker proxy overhead); batch request server time dominated
      by sequential per-event publish loop.
    *Example:* docs/load-testing.md bottleneck analysis.
14. **If you had one week to improve throughput, what would you do first?**
    *Short:* micro-batch persistence commits.
    *Deep:* accumulate N messages → one transaction → one commit; raises the
      368/s drain by orders of magnitude; requires rethinking commit granularity
      and failure atomicity — designed, deliberately not yet implemented.
    *Example:* Phase 7 recommendations list.
15. **Why does batch ingestion succeed where single fails?**
    *Short:* one commit amortized across N events; fewer round trips.
    *Deep:* same PG, same Kafka — the difference is per-event fixed costs
      (fsync, produce RTT) divided by 100.
    *Example:* batch100_1000 vs single_100 ladder rows.
16. **How are secrets handled?**
    *Short:* environment-only; .env gitignored; required vars in prod compose.
    *Deep:* pydantic-settings; fail-fast validator blocks dev defaults in prod;
      user-data script deliberately contains no secrets (instance metadata readable).
    *Example:* infra/aws/env.production.template + chmod 600 runbook step.
17. **What's NOT secure about this system today?**
    *Short:* no auth, no rate limiting, no TLS — all documented deferrals.
    *Deep:* anyone network-adjacent can POST events; body/count caps exist but
      no quotas; TLS termination expected from ALB/Caddy layer.
   *Example:* LEARNING.md security table "known gap" rows.
18. **Describe your Docker image strategy.**
    *Short:* multi-stage non-root backend image shared by api+workers; separate nginx frontend image.
    *Deep:* builder stage installs deps into isolated venv; runtime copies venv+code;
      healthchecks overridden per service (HTTP vs heartbeat script).
    *Example:* root Dockerfile + prod compose service commands.
19. **How would you scale this past one host?**
    *Short:* api replicas behind LB (WS needs sticky/pub-sub), more workers join groups automatically, managed PG/Redis/Kafka.
    *Deep:* consumer-group protocol already scales workers horizontally; the
      parts needing design are WS fan-out across replicas and DB write scaling.
    *Example:* infra/aws/README upgrade-path table.
20. **What happens to WebSocket clients when an api replica dies?**
    *Short:* clients reconnect with exponential backoff and fall back to REST polling.
    *Deep:* 1→2→4s capped backoff; polling keeps data flowing while reconnecting;
      broken sockets removed server-side without crashing other clients.
    *Example:* useWebSocket.ts + ConnectionManager broadcast try/except.
21. **How do you keep logs useful but safe?**
    *Short:* structured JSON lines with allowlisted identifiers only.
    *Deep:* stdlib JsonFormatter passes only safe extras (event_id/type/source);
      caplog tests assert payloads never appear anywhere including metrics output.
    *Example:* tests/test_structured_logging.py, test_no_payload_in_metrics_output.
22. **What would you add next and why?**
    *Short:* auth+rate limiting (real exposure), Alembic (safe schema evolution), persistence micro-batching (throughput).
    *Deep:* ordered by risk: public deployment blocked by auth/TLS; schema
      changes currently rely on create_all being dev-only; batching is pure perf.
    *Example:* LEARNING.md knowledge gaps list.

---

# 13. Resume Claims

Every claim below is backed by an artifact in this repo. Machine-specific
numbers must always be quoted WITH their environment (Win11 i5-12500H laptop,
Docker Desktop/WSL2, single uvicorn process, one worker per group).

| Resume claim | Evidence | Verified? |
|---|---|---|
| Batch ingestion sustains ~4.8K events/s at p95 1.5s (single host) | Phase 7 ladder, docs/load-testing.md, load-tests/results/*.json | Yes (machine-specific) |
| Saturated batch ingestion ~7K events/s with zero errors | same | Yes (machine-specific) |
| At-least-once processing with idempotent persistence demonstrated live | tests/test_failure_matrix_integration.py (worker-kill redelivery) | Yes |
| Retry + dead-letter handling for poison messages | test_kafka_retry_unit.py + malformed live test | Yes |
| Real consumer-lag observability without Admin client | lag_snapshot() → heartbeats → /metrics gauges; /analytics field | Yes |
| Dependency-aware readiness with graceful degradation ladder | /ready semantics + redis/pg/kafka failure-matrix tests | Yes |
| WebSocket dashboard with reconnect + REST fallback | ws tests + live_dashboard_verify.py record | Yes |
| Production-grade packaging: multi-stage non-root image, fail-fast prod config | Dockerfile, config validator tests, infra/aws runbook | Yes (deployment itself operator-run) |
| 146 automated backend tests incl. 7 live failure scenarios | pytest run of record 2026-08-25 | Yes |

Claims NOT supportable today — do not use:
- any multi-node/cluster throughput or HA claim
- authentication/rate-limiting capabilities
- "cloud-deployed" (runbook exists; no deployment executed)
- latency numbers quoted without the machine qualifier

---

# 14. What I Learned This Week

Add dated entries.

## 2026-08-24

### Concept

Phase 1: an event ingestion service end-to-end (ingest → validate → store → fetch).

### What I learned

**Phase 1 implementation**
- FastAPI service backed by PostgreSQL via SQLAlchemy 2.x async (`Mapped` / `mapped_column`).
- `POST /events` single + batch (all-or-nothing, max 1000 per batch), `GET` by `event_id`, plus `/health` and `/ready`.
- Duplicate `event_id` returns HTTP 409; oversized bodies return HTTP 413; every error uses the structured `{ "error": { "code": "...", "message": "...", "details": ... } }` envelope.
- Server generates `event_id`/timestamp when omitted; schemas reject naive timestamps and normalize offsets to UTC; logging records only `event_id`, `event_type`, `source`.
- Configuration via pydantic-settings from environment / `.env`; credentials never hardcoded.
- Docker Compose file and README written; API manually exercised against live Dockerized Postgres (health, ready, ingest, fetch).

**Architectural decisions**
- One structured error envelope everywhere; status codes distinguish causes (409 conflict, 413 size, 422 validation, 404 missing).
- Batch ingestion is all-or-nothing so partial batches never persist.
- Validation centralized in Pydantic v2 schemas at the boundary; route handlers stay thin.
- Secrets only via `.env`; logging restricted to non-sensitive identifiers.

### What confused me

The suite's lone warning comes from FastAPI internals (`fastapi/routing.py`): `HTTP_422_UNPROCESSABLE_ENTITY` is deprecated in favor of `HTTP_422_UNPROCESSABLE_CONTENT`. Framework-side, not our code; harmless for now.

### How the project demonstrated it

Test run of record (actual pytest output): **19 passed, 1 warning in 0.18s** — Python 3.13.15, pytest 8.4.2, project `.venv`, Windows.
- Integration — 10 tests (`tests/test_api_integration.py`): health; ingest→fetch roundtrip; generated id/timestamp; single duplicate → 409; in-batch duplicates; conflict with persisted event; validation error envelope; missing → 404; batch over limit rejected; payload too large.
- Schema/unit — 9 tests (`tests/test_schemas_unit.py`): minimal-event defaults; explicit id preserved; naive timestamp rejected; offset → UTC; invalid `event_type` format; blank source; blank `user_id` → null; non-positive `schema_version`; arbitrary JSON payload.

Docker/WSL2 lesson: `docker compose up -d postgres` must be running before integration tests; integration tests skip cleanly when Postgres is unreachable. Environment recovery required installing WSL2 and restoring the Docker engine before containers would start.

### What I should revisit

Remaining learning gaps:
- Load testing — no throughput/latency numbers exist yet, so performance claims stay unverified until benchmarked.
- End-to-end and failure-injection tests not yet written.
- Authentication, rate limiting, CORS hardening deferred to later phases.
- Redis, WebSockets, Kafka, observability, cloud deployment — later phases.

## 2026-08-24 (Phase 2)

### Concept

Phase 2: Kafka event pipeline (producer → topic → consumer groups → persistence + analytics) with at-least-once, manual commits, idempotency, retry/DLQ, and versioned API.

### What I learned

**Kafka infrastructure (2A)**
- Canonical topics: `application-events` (primary, 6 partitions RF 1 dev, `KAFKA_NUM_PARTITIONS=6` `docker-compose.yml:42` / `app/core/config.py:22`) and `dead-letter-events` (DLQ). Legacy `events.raw` retired (`app/core/config.py:19` comment). `docs/kafka-topics.md` documents topic purpose, partition count, replication, and `KAFKA_AUTO_CREATE_TOPICS_ENABLE=true`.

**Producer contract (2B)**
- Shared serialization `app/kafka/serialization.py:15` `serialize_event(Event)->bytes` and `deserialize_event(bytes)->dict` with ISO-8601, UUID str, nullable handling, payload preserved, malformed raises `ValueError`. Reused by both producer and consumers (no duplicate schema).
- Partition key `user_id → source → event_id` `app/kafka/serialization.py:137` / `app/services/kafka_publisher.py:73` deterministic, gives per-user ordering (Kafka partition guarantee) with `source` fallback for service events and `event_id` final fallback. Trade-off: hot partition if single user/source dominates (documented `docs/kafka-topics.md:54`).
- Producer `KafkaEventPublisher` `app/services/kafka_publisher.py:17` `acks="all"` `enable_idempotence=True` `app/services/kafka_publisher.py:33`, lazy `AIOKafkaProducer` in `start()`, graceful failure → `_producer=None` (DB source of truth, `POST` still 201), `publish` log-only `partition_key`, never payload, `publish_event` after DB commit `app/api/routes_events.py:29`.

**Consumer foundation (2C)**
- Generic `KafkaEventConsumer` `app/kafka/consumer.py:15` `AIOKafkaConsumer(topic, group_id, auto_offset_reset="earliest", enable_auto_commit=False, value_deserializer=lambda v: v)` reuses `deserialize_event`, `handle_raw(raw, handler)` → `commit()` only on success, never on handler/deserialize failure, never log payload, `start()`/`stop()` graceful, `run(handler)` loop, factory `create_consumer` `app/kafka/consumer.py:147`.

**Persistence worker (2D)**
- `worker/persistence_worker.py:15` group `persistence-workers` on `application-events`, `handle_event` → `persist_event` `app/services/event_consumer_service.py:14` `pg_insert(Event).on_conflict_do_nothing(index_elements=["event_id"])` `app/services/event_consumer_service.py:42` — first delivery inserts `rowcount=1`, second duplicate `rowcount=0` treated as success (idempotent, still commits). API-originated rows already in DB are skipped the same way. One event at a time, `SessionFactory` per event, graceful 5s backoff when `_consumer is None`.

**Analytics worker (2E)**
- `worker/analytics_worker.py:13` group `analytics-workers` same topic, `app/services/analytics_service.py:12` in-memory `total`, `Counter` `events_by_type`/`events_by_source`, `asyncio.Lock`, `record_event` never logs payload, success commits, failure no commit. Independent groups demonstrate both receive all `application-events` (verified `tests/test_analytics_worker_unit.py:88`).

**Partitioning/idempotency hardening (2F)**
- Batch UUID fix `app/api/routes_events.py:43` resolve `event_id` once per item (`resolved_ids`) and stabilize `item.event_id = rid` so duplicate detection and `ingest_event_batch` use identical IDs (previously two different UUIDs for `None` case).
- Idempotency docs `docs/kafka-topics.md:62` producer idempotence != consumer idempotency (DB constraint `events.event_id UNIQUE` `app/models/event.py:15`).

**Retry + DLQ (2G)**
- `app/kafka/retry.py:11` `is_transient` (`ValueError` permanent, `SQLAlchemyError`/network transient), `backoff 0.1→0.4→1.6s` `app/kafka/retry.py:19`, `MAX_ATTEMPTS=3`, `with_retry_and_dlq` `app/kafka/retry.py:30` retries transient with `asyncio.sleep`, permanent → DLQ directly without retry, after exhaustion → `dlq.send(raw, error, key)` `app/kafka/dlq.py:49` envelope `{"original":..., "error":...}` never log payload, DLQ success → terminal commit, DLQ failure → raise (no commit, redelivery). `KafkaEventConsumer.handle_raw` `app/kafka/consumer.py:76` now integrates `with_retry_and_dlq` and malformed → DLQ → commit if DLQ succeeds.

**API versioning (2H)**
- Canonical `/api/v1/events`, `/batch`, `/{id}`, `/health`, `/ready` plus legacy `/events` etc for compatibility `app/main.py:74` `include_router(..., prefix="/api/v1")`. `/metrics` intentionally deferred to Phase 6 (no useless endpoint, documented `README.md:44`).

### What confused me

- `AIOKafkaProducer` must be created inside async `start()` not `__init__` (needs running loop) — early `ModuleNotFoundError`/`RuntimeError` after adding `aiokafka` exposed lazy-init requirement (`app/services/kafka_publisher.py:30` fix).
- Generic `insert` vs `pg_insert` — `sqlalchemy.insert` lacks `on_conflict_do_nothing`, must use `sqlalchemy.dialects.postgresql.insert` for idempotent worker.
- `KafkaEventConsumer.handle_raw` originally did single attempt with no DLQ; adding retry+DLQ without breaking 2C tests required `asyncio.sleep` patching in tests to avoid 2s delays.

### How the project demonstrated it

Test run of record (actual `pytest -v`): **66 passed, 17 skipped, 0 failed in 24.57s** — Python 3.13.15, pytest 8.4.2, Windows, Docker unavailable (SKIPPED honestly):
- `test_kafka_serialization_unit` 8 PASS (canonical serialize, UUID, ISO-8601, nullable, payload roundtrip, partition key deterministic, malformed rejects)
- `test_kafka_publisher_unit` 7 PASS (partition key user→source→event_id, producer `acks="all"` + idempotence, Kafka-down non-fatal, payload never logged)
- `test_kafka_consumer_unit` 11 PASS (group/topic config, `auto_offset_reset`/`enable_auto_commit=False`, deserialize via shared serializer, success→commit, failure→no commit, graceful start/stop, Kafka unavailable, malformed no commit, payload not logged)
- `test_kafka_retry_unit` 12 PASS (transient retry→success, exhaustion→DLQ, permanent→DLQ no retry, DLQ failure raises, malformed→DLQ+commit, payload not logged)
- `test_persistence_worker_unit` 10 PASS (new persist, idempotent duplicate, duplicate delivery, success→commit, DB failure→no commit, group/topic, payload not logged, graceful start/stop)
- `test_analytics_worker_unit` 7 PASS (group/topic, counting `total/by_type/by_source`, success→commit, failure→no commit, payload not logged, independent groups)
- `test_schemas_unit` 9 PASS (same as Phase 1)
- `test_api_versioning` 2 PASS (`/health` + `/api/v1/health` both 200 without DB), 4 SKIPPED (versioned ingest/batch require PG)
- `test_api_integration` 10 SKIPPED (PG unavailable) + `test_persistence_integration` 3 SKIPPED (PG unavailable) — existing pattern, not claimed.

Live verification after Docker start: `docker compose up -d` both `pulsestream-postgres` and `pulsestream-kafka` `healthy` (10–14s), `kafka-topics.sh --describe` PartitionCount 6 RF1 for both `application-events`/`dead-letter-events`, `kafka-consumer-groups.sh` both `persistence-workers` and `analytics-workers` LAG 0 on same partition (independent), `POST /api/v1/events` → `GET` 200 payload preserved, duplicate `POST` 409 count stays 1, batch auto-IDs distinct. Full live `pytest -v` later with Redis also live: **83 passed, 0 skipped, 1 warning** (was 66/17 when Docker down).

### What I should revisit

- Alembic migrations (currently `create_all` outside production `app/main.py:28`).
- Load testing still TBD — no throughput/latency numbers, resume claims stay unverified.
- Redis now Phase 4 complete, WebSockets/React to Phase 5, observability to Phase 6.

---

## 2026-08-24 (Phase 4)

### Concept

Phase 4: Redis analytics — distributed counters with idempotency and TTL, analytics API, graceful degradation.

### What I learned

**Redis infrastructure (4A)**
- `docker-compose.yml:46` `redis:7-alpine` `healthcheck: redis-cli ping`, `requirements.txt:8` `redis>=5.0,<7.0` + `fakeredis` `requirements-dev.txt:5`, `app/core/config.py:32` `redis_url/enabled/key_prefix/idempotency_ttl=86400/per_minute_ttl=120` / `.env.example:16`, `app/redis/client.py:14` `get_redis()` lazy `Redis.from_url` + `ping` graceful `None` if `REDIS_ENABLED=false` or ping fails, never raises, never logs payload, `close_redis()` in `lifespan` `app/main.py:32`.

**Analytics counters (4B)**
- Replaced `app/services/analytics_service.py:12` in-memory `Counter` with Redis primary: `record_event` `app/services/analytics_service.py:28` `SET seen:{event_id} NX EX 86400` → if not set (duplicate) skip; else `PIPELINE INCR total / HINCRBY by_type / HINCRBY by_source / INCR per_minute:{minute} + EXPIRE 120` atomic. `get_metrics` `app/services/analytics_service.py:62` tries `GET total` / `HGETALL` / `GET per_minute:{now}` from Redis, fallback to in-memory `Counter` if `get_redis() is None`. `reset_metrics` `app/services/analytics_service.py:85` `DEL` `analytics:*` + `SCAN` `seen:*` / `per_minute:*`. TTL trade-off: 24h `seen` bounds memory (~50B per key) vs late redelivery after 24h could double-count (acceptable for real-time, PG remains truth); 120s `per_minute` keeps only current+previous bucket.

**Analytics API (4C)**
- `app/api/routes_analytics.py:10` `GET /analytics` + `/api/v1/analytics` `app/main.py:74` `include_router(analytics_router)` + `prefix="/api/v1"` returns `{total, events_by_type, events_by_source, events_per_minute}` from `await get_metrics()` (async now), no DB, no payload logging. Keeps worker contract `await record_event(event)` unchanged `worker/analytics_worker.py:46`.

**Graceful degradation (4D)**
- Redis unavailable → `record_event` fallback in-memory `Counter` `app/services/analytics_service.py:12` `except: fallback`, `GET /api/v1/analytics` fallback, `POST /events` still 201 (analytics not blocking ingestion, PG remains source), `GET /health` 200, `GET /ready` checks PG only (Redis down not 503, soft `degraded` documented `docs/redis.md:62`). `app/redis/client.py:14` `get_redis()` ping failure → `None`, `POST` still succeeds.

**Tests (4E)**
- `tests/test_analytics_redis_unit.py:8` 6 tests with `FakeAsyncRedis` (`fakeredis` `FakeAsyncRedis`): basic counters, duplicate `seen` no double count + TTL `86397` ≤86400, `per_minute` bucket `INCR` + `TTL` ≤120, `redis_unavailable_fallback` (`patch get_redis→None` → in-memory still 2), `payload_never_logged` caplog, `atomic_idempotency` concurrent `gather` same `event_id` → total 1.
- `tests/test_analytics_api.py:8` 3 tests with `FakeAsyncRedis` + `client` fixture: `GET /analytics` + `/api/v1/analytics` returns `total/by_type/by_source/per_minute`, empty initially, graceful when `get_redis→None`.
- Existing `tests/test_analytics_worker_unit.py` 7 updated to `await get_metrics()` (async now) still PASS via fallback when Redis not injected (fallback in-memory).

### What confused me

- `fakeredis` import path changed: `fakeredis.asyncio` (new) vs `fakeredis` `FakeAsyncRedis` / `fakeredis.aioredis` (2.37.1) — `ModuleNotFoundError: No module named 'fakeredis.asyncio'` fixed by `from fakeredis import FakeAsyncRedis`.
- `get_metrics` was sync in Phase 2E, now async for Redis; existing `test_analytics_worker_unit.py` called sync `get_metrics()["total"]` → must `await get_metrics()`.
- Redis `seen` + `pipeline` race: if `SET NX` succeeds but pipeline fails after, we keep `seen` (avoid double-count on retry) vs delete `seen` to allow retry — chose keep `seen` (at-most-once counting for analytics, acceptable approximate).

### How the project demonstrated it

Live Docker `postgres`+`kafka`+`redis` all `healthy` (`pg_isready`, `kafka-broker-api-versions.sh`, `redis-cli ping` `PONG`), `docker exec redis-cli GET pulsestream:analytics:total` etc. Full live `pytest -v`: **92 passed, 0 skipped, 1 warning in 33.76s** (was 83 live before Redis, 66/17 when Docker down):
- New `test_analytics_redis_unit` 6 PASS, `test_analytics_api` 3 PASS (all with `FakeAsyncRedis`, no live Redis needed)
- Existing `test_analytics_worker_unit` 7 PASS (now async `get_metrics`, fallback in-memory when no injected redis)
- Live `live_redis_verify.py` with real `redis:7-alpine` `flushall` → `POST /api/v1/events` 2× → `GET /api/v1/analytics` `total=2` `by_type` `order.created:1 page.viewed:1`, duplicate `POST` same `event_id` 409 `total` stays 2, `seen TTL 86397` ≤86400, `per_minute:2026-08-24T12:00` TTL 117 ≤120, `docker stop redis` then `POST` still 201 fallback in-memory.

### What I should revisit

- Rate limiting (explicitly deferred `README.md:44` style, `app/redis/client.py` not used for token bucket yet — Phase 6).
- `events_failed_total` counter for DLQ (could `HINCRBY` on `dlq.send` in `app/kafka/retry.py` but deferred).
- Dashboard cache `GET /api/v1/analytics` currently hits Redis each call, no additional `CACHE_TTL` — Phase 5 React will add.

---

## 2026-08-24 (Phase 5)

### Concept

Phase 5: Real-time dashboard — FastAPI native WebSocket broadcaster + React/TS/Vite frontend, 8 operational areas, REST fallback, metric traceability.

### What I learned

**WebSocket foundation (5A)**
- `app/api/ws.py` `ConnectionManager` (set + `asyncio.Lock`, `connect/disconnect/broadcast/broadcast_all`); broken client removed inside `broadcast()` try/except so one dead socket never crashes others. Routes `/ws` and `/api/v1/ws` via same router included twice (`app/main.py`). `app/services/broadcaster.py` periodic task (~1s) reads existing Redis analytics state via `get_metrics()` and broadcasts `{"type":"metrics","data":{…}}`; started/stopped in lifespan. No new Kafka topic; browser never sees Kafka.

**Analytics + recent events (5B)**
- Extended Phase 4 keys without breaking them: added `analytics:failed` (INCR only at terminal DLQ in `retry.py` + malformed path in `consumer.py`) and `analytics:latency:sum|count` (`INCRBYFLOAT/INCR` per unique event, idempotency preserved by `seen:{event_id}` so duplicates don't skew latency or totals).
- `get_metrics()` now returns spec §11 fields: total/processed/failed/by_type/by_source/per_minute/**per_second (derived per_minute/60, documented approximation)**/**latency avg (now − event.timestamp, clamped ≥0)**/**active_producers = len(by_source) distinct observed sources**; `consumer_lag: null` explicitly unavailable (needs Kafka Admin, Phase 6) — not fabricated.
- Recent events: `GET /events?limit=&offset=` newest-first from PG `ORDER BY created_at DESC` with `created_at index=True` added to model (only schema touch; justified by the query). Limit 1..100 validated → 422.

**React dashboard (5C)**
- `frontend/` Vite + React 18 + TypeScript, no Next.js. 8 components for the 8 spec areas; honest "Unavailable"/"No data" states; zero fake data. Vitest + RTL: renders all 8 areas, degraded/loading states, no-Kafka-client check.

**Real-time wiring (5D)**
- `useWebSocket.ts`: parse-safe (`type==="metrics"` guard), exponential reconnect 1s→2s→4s capped, cleanup on unmount, payload-free console (no console.log of messages). App falls back to REST polling `/api/v1/analytics` every 1s when WS down; RecentEvents polls `/api/v1/events?limit=20` every 2s.
- Docker: `frontend` service (node build → nginx, SPA fallback + `/api` & `/ws` proxy to `api` service), plus dev-style `api` compose service. Compose now postgres+kafka+redis+api+frontend, all healthy; dashboard served at :3000.

**Verification (5E)**
- Backend: **99 passed, 2 warnings** (7 new WS tests incl. payload-free caplog; recent-events covered in live script; baseline 92 intact + 7). Frontend vitest: **3 passed**; `npm run build` green (147KB gzip 47KB), also built successfully inside Docker image.
- Live `live_dashboard_verify.py` against running stack: POST→201, WS received ≥3 metrics broadcasts with incremented total (Redis-backed), REST analytics OK, recent-events contains posted id and is newest-first, limit>100→422, duplicate POST→409 leaves analytics unchanged, second WS session (reconnect) receives broadcasts, Redis-down patched `get_metrics` falls back in-memory. Frontend container serves HTML at :3000 and nginx proxies `/health` to api (`{"status":"ok"}`).

### What confused me

- `vitest` jsdom has no real network: unmocked `fetch("/api/v1/events")` returned an HTML-ish object and crashed `events.map` — fixed by guarding `Array.isArray(data)` in the component (defensive, also correct in prod) and mocking fetch in tests.
- `tsc --noEmit` on test file flagged Node's `global` — switched to `globalThis` then simplified the test; keep test typing environment-compatible with `tsc && vite build`.
- FastAPI WebSocket routes are not affected by `include_router(prefix=...)` duplication pitfalls here since each route path is explicit; mounted `/ws` and `/api/v1/ws` both verified.

### How the project demonstrated it

pytest: **99 passed, 2 warnings** (Starlette deprecation ×1 + httpx/testclient deprecation ×1, framework-side). vitest: 3 passed. Build: vite production OK. Live: all checks above PASS with docker compose ps showing postgres/kafka/redis healthy + api + frontend up.

### What I should revisit

- Consumer lag via Kafka Admin (Phase 6), exact per-second throughput (needs finer buckets), end-to-end latency definition (needs consumer-receive timestamp persisted), rate limiting/auth still deferred, Alembic deferred.

---

## 2026-08-24 (Phase 6)

### Concept

Phase 6: Reliability — dependency-aware readiness, JSON structured logs, Prometheus /metrics, containerized self-healing workers, and a live §18 failure matrix.

### What I learned

**6A Health/readiness**
- `/health` = pure liveness (checks nothing, always 200). `/ready` now returns `{status: ready|degraded|not_ready, dependencies:{postgres,redis,kafka,workers,broadcaster}}`. PostgreSQL remains the ONLY 503 gate; Redis/Kafka soft-degrade with 200 — frozen semantics preserved.
- Worker health is real, not invented: heartbeat keys `pulsestream:worker_heartbeat:{name}` written every 10s/TTL 30s (`app/services/heartbeat.py`), read by readiness. If Redis is down, worker status is honestly `unknown`, never "healthy".

**6B Structured logs**
- Replaced plaintext `basicConfig` with a stdlib `JsonFormatter`: one JSON object/line with timestamp/level/logger/message + pass-through of safe `extra` metadata + `exception` field on errors. No new dependency; call sites untouched; payload-free contract intact (formatter test + prior caplog tests).

**6C Metrics**
- Added `prometheus-client`; pure-ASGI middleware records request count+latency per route template. Counters hook real paths: processed → persist success (`persist_event`), failed → terminal DLQ (`record_failed`). Gauges: WS connections from ConnectionManager, worker heartbeat freshness refreshed at scrape. `/metrics` + `/api/v1/metrics` return correct content-type. Consumer lag still honestly absent (needs Kafka Admin).

**6D Ops/Docker**
- Compose now runs api, frontend, persistence-worker, analytics-worker (+postgres/kafka/redis untouched) all with `restart: unless-stopped` and REAL healthchecks (api liveness URL; frontend HTTP fetch; workers execute the Redis-heartbeat script). Workers reuse existing module commands — zero Kafka contract changes.

**6E Failure matrix (live)**
- 7 integration tests drive actual compose stop/start cycles and assert behavior, not just process state: Redis down→POST 201 via fallback + degraded ready→recovery; PG down→ready 503→recovery; Kafka down→bounded publish, ingest stays 201, broker recovers; killed persistence-worker→event published during downtime redelivered & persisted after restart (at-least-once proven); malformed poison→terminal DLQ+commit, no loop; duplicate id→409 + single analytics count via seen key; WS disconnect/reconnect receives metrics broadcasts.
- Failures found & fixed while verifying: (1) unbounded `send_and_wait` hung ingestion during broker outage → hard 5s cap + wedged-producer discard/lazy re-bootstrap so broker restarts recover publishing automatically; (2) Redis client latched unavailable forever after an outage → bounded 5s reconnect retries; (3) analytics worker lacked DLQ parity so a poison message blocked partition commits → wired dlq like persistence; (4) workers now force-restart their consumer after repeated heartbeat failures (wedged-session self-heal).

**6F Verification of record**
- Backend: **124 passed, 0 failed, 2 framework warnings** (Starlette constant deprecation, TestClient/httpx deprecation). Frontend: vitest 3 passed, vite build OK. Docker: 7 services, all healthy. Live: /metrics exposition verified (counters/gauges present, correct content-type); API logs confirmed valid JSON lines in docker logs.

### What confused me

- aiokafka caches bootstrapped broker addresses; after the kafka container is recreated the old producer can keep dialing a dead IP forever — hence the discard-and-rebootstrap recovery.
- pytest-asyncio session-loop + Windows Proactor: sync tests calling `asyncio.run()` poison later async tests' loop resolution; fixed by making those tests proper async tests (or last-in-suite sync).
- A recreated redis container wipes keys — heartbeats/analytics counters are ephemeral by design, which is exactly why readiness treats them as observable-but-soft state.

### What I should revisit

- Consumer lag via Kafka Admin client; Grafana dashboards; alerting — natural Phase 7+/observability follow-ups but not required by §16 line items implemented here.

---

## 2026-08-25 (Phase 7)

### Concept

Phase 7: Performance — open-loop load generator, benchmark ladder 100→10K ev/s, real consumer
lag via worker heartbeats, bottleneck analysis with measured numbers only.

### What I learned

**Consumer lag without Kafka Admin (7A)**
- aiokafka 0.14 exposes `highwater(tp)` + `position(tp)` for assigned partitions, so each
  WORKER can compute its own lag — no Admin client, no new dependency
  (`KafkaEventConsumer.lag_snapshot()`, app/kafka/consumer.py). Unknown offsets are omitted
  honestly (never reported as zero); the method never raises.
- Transport piggybacks on the Phase 6 heartbeat: payload is now JSON
  `{ts, group, lag:{partition:int}}` (app/services/heartbeat.py), backward compatible since
  healthcheck/readiness only need key freshness. `/ready` shows per-worker lag;
  `refresh_worker_gauges()` sets Prometheus `pulsestream_consumer_lag{group,partition}`;
  `_total_consumer_lag()` feeds `GET /analytics` `consumer_lag` (was hardcoded null since 5B).
- Python 3.13 removed `asyncio.iscoroutine()` — first version used it inside try/except, so
  every partition silently hit the except and returned {}. Correct tool: `inspect.isawaitable()`.
- aiokafka naming trap: kafka-python says `highwatermark()`, aiokafka says `highwater()` —
  first live run produced empty snapshots for exactly this reason.

**Load generator (7B)**
- load-tests/loadgen.py: open-loop pacing — requests scheduled on a fixed time grid independent
  of response latency, fixed worker pool bounds in-flight requests. Open-loop matters:
  closed-loop self-throttles and hides queueing collapse.
- Reports offered vs completion-based throughput plus completion_tail_seconds so saturation is
  visible as tail growth rather than hidden.
- Two harness bugs caught by smoke tests BEFORE any numbers were recorded: single mode divided
  event rate by default batch-size=100; batch mode posted a bare array but the endpoint expects
  {"events":[...]} (all 422).

**Benchmark ladder (7C) — run of record 2026-08-25**
- load-tests/benchmark.py: runs steps, samples /metrics lag ~2s + docker stats ~6s off the event
  loop, snapshots DB rows/size, waits for persistence-lag drain after each step.
- Results (Win11 i5-12500H, Docker Desktop/WSL2, ONE uvicorn process, one worker/group):
  single_100 → 49 ev/s achieved, p50 150ms; single_1000 → collapse to 33 ev/s, p99 14s, err 0%;
  batch100_1000 → 1,002 ev/s p99 146ms; batch100_5000 → 4,809 ev/s p95 1.5s;
  batch500_10000 → 7,016 ev/s saturated, persist-lag spike >50K.
- Drain measured from Kafka OFFSETS (kafka-consumer-groups deltas), not row counts:
  persistence ≈368 ev/s (per-event PG commit); analytics caught up fully (Redis pipelines).
- KEY INSIGHT: `events` row counts track INGESTION (the API commits synchronously per request),
  so "persisted rows delta" during a run is NOT persistence-worker progress. First benchmark
  draft mislabeled this; offset math is the honest measure of consumer progress.

**Bottleneck findings (7D)**
- Single POST: server-side avg 50.6ms (Prometheus histogram sum/count) vs client p50 ~150ms —
  two thirds of perceived latency is Docker Desktop port-proxy overhead, one third is real work
  (PG commit + acks="all" round trip).
- Batch endpoint at high rates: ~1.22s server per request dominated by the SEQUENTIAL
  per-event publish loop in routes_events.py (one broker RTT per event).
- Persistence worker one-event-at-a-time = deliberate at-least-once/idempotency design, but it
  converts bursts into minutes-long backlog. Documented recommendation (NOT implemented):
  micro-batching consumer commits would raise drain rate by orders of magnitude.

### What confused me

- Full-suite run failed once in test_redis_stop_restart_fallback_and_recovery (ReadTimeout on
  /ready during redis outage) but passed in isolation: /ready stacks several sequential Redis
  attempts, and redis-py clients had NO socket timeouts, so one ping against the dead port
  waited for the OS TCP timeout (>10s via Docker proxy). Fix with real operational value:
  explicit socket_connect_timeout=2 + socket_timeout=2 on client creation (app/redis/client.py)
  so health endpoints answer fast exactly when dependencies are down. Test re-run: full failure
  matrix module 7/7 green.
- PowerShell/Kafka CLI column parsing for offset deltas is error-prone (negative "rates" from
  misaligned columns); replaced with a small Python parser splitting on whitespace and matching
  group/topic explicitly.

### How the project demonstrated it

- Unit tests: tests/test_consumer_lag_unit.py (5), test_heartbeat_lag_unit.py (8), 
  test_loadgen_unit.py (4) — lag math incl. async-position variant, heartbeat JSON payload,
  gauge wiring, percentile interpolation, metrics exposition parsing.
- Live: workers restarted on compose, /ready shows lag:{}, /metrics exports
  pulsestream_consumer_lag series, /api/v1/analytics returned consumer_lag=86117 while the
  post-ladder backlog drained (real nonzero proof).
- Ladder JSON artifacts in load-tests/results/ (2026-08-25 runs).

### What I should revisit

- Persistence micro-batching (commit granularity design needed) — biggest end-to-end lever.
- Parallelize/producer-batch the batch-ingest publish loop.
- Explicit SQLAlchemy pool sizing; uvicorn --workers>1; Linux deployment removes proxy overhead.
- Alembic migrations; AWS deployment (Phase 8).

---

## 2026-08-25 (Phase 8)

### Concept

Phase 8: Cloud — production Docker images, production-safe configuration, and a
ready-to-execute AWS deployment path (EC2 + compose). No cloud resources were
provisioned; deployment execution belongs to the operator (repo rule).

### What I learned

**Production image (8A)**
- Multi-stage `Dockerfile`: builder resolves requirements.txt into an isolated
  venv, runtime copies only /opt/venv + app/worker/scripts code. One image for
  api AND both workers — command differs per compose service. Non-root user,
  PYTHONUNBUFFERED, baked-in HTTP liveness HEALTHCHECK (workers override with
  the Redis-heartbeat script via compose).
- Root `.dockerignore` matters as much as the Dockerfile: build context used to
  include .venv/node_modules/results; excluding it shrinks context transfer and
  keeps images clean.
- Verified by running containers from the image: imports OK, 14 routes, runs as
  `pulsestream` user.

**Production settings gate (8B)**
- Subtle trap: every dependency client degrades gracefully (POST stays 201 with
  Kafka down) — great at runtime, DANGEROUS at boot in prod. A typo'd
  KAFKA_BOOTSTRAP_SERVERS would silently run a pipeline that never publishes.
  Fix: pydantic model_validator rejects APP_ENV=production when DATABASE_URL /
  KAFKA_BOOTSTRAP_SERVERS / REDIS_URL equal their exact development default
  strings. Fail fast on forgotten config, not opinions: genuinely-intended
  loopback uses 127.0.0.1 (tested escape hatch).
- create_all already skipped when APP_ENV=production (Phase 1 decision) — now
  documented alongside the gate.

**Prod topology (8C)**
- infra/docker-compose.prod.yml: built images only (no runtime pip install, no
  source mounts), ${VAR:?} required-var enforcement for credentials, json-file
  log rotation everywhere, restart policies, Redis persistence disabled
  deliberately (counters are ephemeral by design, PG is truth).
- Compose ${VAR:?} hard-errors naming the missing variable (exit 1) — verified.

**AWS path (8D)** — EC2 single-host + prod compose (infra/aws/)
- user-data.sh installs Docker + clones repo ONLY; no secrets in user-data
  because instance metadata is readable by anything on the box. Secrets created
  over SSH afterwards (chmod 600 env file).
- Security posture: only ports 22/80 (+8000 optional for load tests) published;
  PG/Redis/Kafka have no host ports in prod compose.
- Honest limitation recorded: a REAL deployment but NOT HA. Upgrade-path table
  maps each self-hosted piece to RDS/ElastiCache/MSK/Fargate — every swap is an
  env-var change, which is exactly why all endpoints are environment-driven.

### What confused me

- First validator test expected "explicit localhost passes" — not cleanly
  implementable (pydantic doesn't expose whether a value came from env vs
  default). Resolved by choosing the SAFER semantic (reject exact defaults,
  period) and updating the test + docstring rather than the implementation.
- PowerShell session env vars leaked between compose validation calls; needed
  Remove-Item env: before testing missing-variable behavior.

### How the project demonstrated it

- tests/test_production_settings_unit.py: 5 PASS (prod passes with real
  endpoints; rejects each dev default; 127.0.0.1 escape hatch; dev unaffected).
- docker build → container import smoke test OK; non-root confirmed via whoami.
- compose config valid with env present; exit 1 naming missing vars without.
- Full pytest run of record after Phase 8 changes: **146 passed, 0 failed**.

### What I should revisit

- Actual AWS execution (operator account required): follow infra/aws/README.md.
- Alembic migrations BEFORE any real multi-version prod deployment.
- Image tagging by git SHA + retag-rollback discipline (described, not scripted).
- TLS termination (ALB/CloudFront/Caddy) if serving publicly.

---

## 2026-08-25 (Phase 9)

### Concept

Phase 9: Documentation — consolidate everything the project knows into
interview-ready form. No production code changed.

### What I learned

- docs/architecture.md now documents the system AS BUILT (topology diagram,
  component inventory with in/out/failure columns, numbered end-to-end flow,
  guarantees, deliberate non-features) and supersedes the spec's target sketch
  where reality evolved.
- LEARNING.md template sections (§1–§7, §9–§13, §18) filled with real content:
  technology deep-dives with alternatives + interview questions, consolidated
  failure index (13 real debugging stories), verified-only resume claims table
  with explicit "do not claim" list, 22 Q&A interview bank, honest checklist.
- Writing the claims table was a forcing function: every line needed an artifact
  pointer; anything without one moved to the not-claimable list.

### How the project demonstrated it

- README gained a documentation map; all referenced docs exist in repo.

---

## 2026-08-26 (Frontend UI/UX redesign)

### Concept

Full visual redesign of the React dashboard (dark observability-grade UI) with
ZERO backend/contract changes: same WS protocol, same REST endpoints, same
honest-metrics rules, no new runtime dependencies.

### What I learned

**Design system approach**
- Token-based CSS (`styles.css` custom properties): surfaces/borders/text tiers,
  one restrained accent (blue), semantic status colors used only for real status.
- Reusable primitives: `Card`, `Badge` (status→tone mapping incl. "unknown"),
  `Skeleton`, inline-SVG icon set — no icon/chart libraries added; the live
  throughput chart is hand-built SVG (gradient fill, auto-scaled y-ticks).
- Layout: sticky sidebar (scroll-spy nav via IntersectionObserver, graceful
  degradation where the API is missing — jsdom!), header with truthful feed
  pill (Live·WebSocket / Polling·REST / Offline derived from REAL state),
  responsive: sidebar → horizontal chips ≤900px, grids stack ≤1100px.

**Honesty preserved in UI**
- Consumer lag null → "Unavailable / workers not reporting yet" (never 0).
- Failure rate with zero processed events → "No data" (the old prototype showed 0.0% — quietly fake; fixed).
- Throughput chart plots ONLY session-observed values (rolling buffer of real updates, labeled as such); no fabricated history.
- Latency panel states its true definition (timestamp→analytics-record delay, NOT end-to-end).
- Recent events table shows only EventOut fields — no invented status column.

**Bugs found & fixed while redesigning**
1. REST fallback never resumed after a WS disconnect (stale last snapshot shown forever): polling now keyed on `connected && metrics !== null`.
2. nginx `/ws` location never matched `/api/v1/ws` — versioned WS path fell into the plain `/api/` proxy WITHOUT Upgrade headers, so the dashboard's live feed through :3000 was silently dead (masked by REST fallback since Phase 5!). Fixed with an explicit regex location; verified via raw handshake (101) + real metrics frame read.
3. nginx cached the api container IP across restarts (502s until frontend restart): added Docker DNS resolver + variable proxy_pass so upstream re-resolves every 10s.
4. Old CSS file was never imported by main.tsx — styles were accidental defaults.

**Verification**
- vitest: 11 passed (3 original kept verbatim + 8 new honesty tests: lag unavailable/value, failure-rate no-data & ratio, latency definition, distribution math).
- vite build OK (~54KB gzip). Docker image rebuilt; dashboard served at :3000;
  /api and /ws proxied correctly including after api restarts.
- Backend pytest run of record after redesign: **146 passed, 0 failed**.

### What confused me

- preserveAspectRatio="none" on SVG stretches text glyphs — removed in favor of proportional scaling.
- IntersectionObserver doesn't exist in jsdom: feature-detect instead of polyfilling test infra.
- `display:contents` wrappers break scrollIntoView/IntersectionObserver targeting — anchors must live on real layout boxes.

### How the project demonstrated it

See "Verification" inside the entry above (vitest 11, vite build, Docker serve,
WS-through-nginx handshake, backend 146 passed).

---

## 2026-08-26 (Latency measurement fix)

### Concept

Replace the broken `processing_latency_avg_ms` (was: `now(utc) − client event.timestamp`,
producing values like 115,358,393 ms for events with old timestamps) with a
server-side measured analytics-worker processing duration.

### What I learned

**Root cause**: the old sample was really "event age" — client timestamps carry
producer-clock semantics, not processing-time semantics. No clamp can fix a
semantically wrong measurement.

**New definition**: per unique counted event, the monotonic-clock duration from
`record_event()` entry until the counter pipeline is built, written into the
SAME Redis pipeline as the counters (`INCRBYFLOAT sum / INCR count`). Three
properties fall out of this placement:
1. atomic + idempotent — samples only exist for events that pass `seen:{id}`,
   so duplicate deliveries never skew the average;
2. zero-event state stays honest (`count=0 → avg=null → UI "Unavailable"`);
3. no signature/contract change — `record_event(event)` unchanged, worker
   unchanged, API/WS field name unchanged; only the meaning became correct.

**Design alternative rejected**: caller-measured duration passed as a parameter
— duplicates return early past the gate, so samples recorded outside would
double-count. Inside-the-pipeline placement solves it structurally.

### How the project demonstrated it

- tests/test_latency_measurement.py (6): sensible latency on normal events;
  2020-dated timestamps CANNOT inflate latency (<1000ms asserted); missing/None
  timestamp handled; zero events → null; 5 duplicate deliveries → exactly 1
  latency sample; in-memory fallback path records server-side latency too.
- Full suite after change: **152 passed, 0 failed**. Frontend 11/11, build clean.
- Live verification: fresh GitHub-style events show realistic ms-scale values;
  deliberately ancient-timestamped event leaves the average unchanged.

### What I should revisit

True end-to-end latency (API receive → publish → consume → persist) requires
stage timestamps carried in the message envelope — an architecture change,
deliberately NOT faked. Documented in docs/dashboard.md.

---

## 2026-08-26 (Event Simulator)

### Concept

Frontend-only demo traffic generator using the EXISTING public API — no backend
changes, no new dependencies, no direct DB/Redis/Kafka access.

### What I learned

- Engine design: open-loop pacing (fixed send schedule at rate) with a BOUNDED
  worker pool (min(max(2, rate), 24) workers); stop() flips a flag checked before
  each scheduled fire, so in-flight requests settle and count — clean stop.
- Safety limits live in ONE module (`eventFactory.LIMITS`) and are enforced in
  both engine clamps and the UI (visible hints + input min/max + disabled states).
  Continuous mode is bounded by the absolute 5,000-event cap.
- Rolling actual-rate = acks in trailing 2s window, emitted at 5Hz so the UI
  never re-renders per request.
- Simulator counters are deliberately separate from analytics metrics — they
  describe simulator activity only (honest-metrics philosophy extended to tooling).
- jsdom/vitest has no jest-dom matchers registered here → assert native
  `.disabled` properties instead of `toBeDisabled()`.

### How the project demonstrated it

- 15 new frontend tests (payload validity incl. UUIDv4/tz/type regex, clamps,
  success/failure counting, pacing bounds, stop cleanliness, cap enforcement,
  UI wiring). Totals: frontend 26 passed; backend untouched **152 passed**.
- Live through nginx: 30 events @ ~10/s → all 201, total delta exactly +30,
  order.created=30, latency_avg 1.14ms, consumer lag 0 on all partitions.

---

## 2026-08-26 (Demo Store — simulated customer application)

### Concept

A separate mini e-commerce app (`demo-store/`, own container :3001) that makes
the "who produces these events?" story visible: every storefront action becomes
a real event via the public API only.

### What I learned

- Separation by REPO LAYOUT, not just naming: the store cannot import backend
  code or dashboard code even by accident; its entire transport is one fetch in
  one file (`lib/pulsestream.ts`). "External client" enforced structurally.
- Same-origin proxy pattern reused from the dashboard: the store's nginx
  forwards /api/ to the api service, so no CORS changes were needed anywhere.
- Rest-parameter footgun caught by my own tests before any real traffic:
  `fire(...events)` called as `fire([a,b])` POSTed a JSON ARRAY as one event.
  jsdom test asserted body shape → fixed signature to accept an array. This is
  exactly why payload-shape assertions belong in client tests.
- StrictMode double-mount means mount-effects fire twice in dev/tests — the
  page.viewed-on-mount design tolerates it naturally (two page views on reload
  is realistic behavior anyway).

### How the project demonstrated it

- demo-store suite: 14 tests (journey contract conformance incl. UUID/tz/type
  regex, ordering of funnel events, honest failure counting for HTTP + network
  errors, transport-isolation assertion).
- Live integration: journey driven through the container's nginx proxy → all
  events accepted; dashboard analytics/recent-events reflected them.

---

## 2026-08-26 (API-key authentication)

### Concept

Lightweight API-key security boundary around event ingestion — dependency-based
(`Security(APIKeyHeader)`), config-driven, disabled-by-default for backwards
compatibility.

### What I learned

- **Empty-config = auth-off** was the pivotal design choice: all 152 pre-existing
  tests pass unchanged because the default configuration has no keys. Auth-on
  behavior is opt-in via env (`PULSESTREAM_API_KEYS`), matching how
  `CORS_ORIGINS` already works.
- Error-envelope consistency: FastAPI's `HTTPException` would emit bare
  `{"detail"}`; our `DomainError` handler renders the project envelope. Auth
  rejections therefore raise DomainError(401) with codes
  missing_api_key/invalid_api_key/malformed_api_key. No WWW-Authenticate header
  (DomainError carries no headers; envelope uniformity wins).
- Constant-time comparison via `secrets.compare_digest` across configured keys;
  whitespace-padded matches are rejected as malformed rather than accepted.
- Test-infrastructure lesson (recurring): sync TestClient creates a NEW portal
  loop per instance while the global async engine holds connections from the
  first loop → cross-loop "Event loop is closed"/unraisable asyncpg errors that
  get attributed to LATER tests. Solution: use the shared async httpx ASGI
  fixture like the rest of the suite. Also: httpx cannot send non-latin1 header
  values (emoji key test crashed client-side).
- Key injection at the PROXY layer (nginx envsubst template) keeps secrets out
  of browser JS entirely — even the dev key never reaches frontend source.
  `${VAR-default}` (dash) vs `${VAR:-default}` distinction matters in compose:
  dash form lets an explicitly EMPTY host value disable auth live for testing.

### How the project demonstrated it

- tests/test_auth.py: 11 tests — valid/missing/invalid/malformed keys; batch
  protected; valid-key+bad-payload still 422; rejection reaches NEITHER Kafka
  (publish spy) NOR database (public list diff) NOR analytics (fakeredis total=0);
  key never echoed/logged; public endpoints usable while auth on; disabled-mode
  compatibility.
- Live A/B/C toggle verified against real compose stack (see final report).

---

## 2026-08-26 (Failed-event visibility + productized frontend)

### Concept

Track 1: make individual failures investigable — `event_failures` audit table
(written only AFTER terminal DLQ succeeds) + `GET /api/v1/failures` + a
Failures page. Track 2: routed multi-page dashboard (hash router, zero deps).

### What I learned

- The old system only had COUNTS (Redis counter + Prometheus gauge); the DLQ
  topic held envelopes nobody could query. Smallest correct addition: persist
  an audit row at the exact terminal-success point in retry.py/consumer.py.
  Placement guarantees: attempts are real handler invocations (3=two retries,
  1=permanent, 0=malformed), and recording can never alter commit semantics.
- Malformed messages honestly get NULL event fields + NULL payload — "Not
  available" in UI instead of fabricated context.
- Graceful degradation HIDES would-be failures: with Redis down, the analytics
  worker falls back to in-memory and SUCCEEDS — no DLQ, no failure record.
  Failure drills must use permanent errors (malformed message injection, the
  sanctioned failure-matrix mechanism), not dependency outages.
- Debugging lesson: "handler runs but drawer never appears" was simply a
  missing `{selected ? <Drawer/> : null}` render line — instrumentation first,
  archaeology second. Also: RTL getByText matches `<option>` elements and
  duplicated nav buttons — scope queries (within(table) / getAllByRole()[0]).

### How the project demonstrated it

- tests/test_failures.py (6): recorder persistence/context/malformed-NULLs/
  never-raises; retry-hook accurate attempts+status for both exhausted and
  permanent paths; API list + limit validation. Full suite **169 passed**.
- Live drill: one malformed Kafka message injected → audit row appeared with
  attempts=0/dlq_malformed/NULL fields; successful traffic continued (201);
  consumer lag returned to 0; latency stayed ~0.8ms.

---

## 2026-08-26 (Product-level frontend redesign)

### Concept

One cohesive observability application: AppShell (TopBar + collapsible sidebar +
command palette), investigation loop (list → side panel → context), hero
PipelineGraph, incident-style Failures view. Graphite/dense visual system.

### What I learned

- Cohesion comes from SHARED SURFACES: one TopBar (breadcrumbs/search/live/
  health/⌘K), one PipelineGraph reused on Overview+Pipeline+Health contexts,
  one Drawer pattern for events AND failures — not from more pages.
- Investigation loop implemented via cross-links: Failed KPI → Failures;
  lag/producers → Pipeline; ev/s → Analytics; distribution row → Events
  pre-filtered (`#/events?type=…`). Router v2 parses hash query params.
- Honest search: the top bar delegates to the Events explorer (the only
  server-searchable dataset via paging); no fake global search.
- Failure timeline is derived ONLY from `attempts` + failed_at; per-attempt
  timestamps explicitly marked "not retained".
- CSS rewrite strategy: full-file replacement with a class contract (every
  component-referenced class carried over) beats incremental patching for
  systematic density/radius/typography changes.

### How the project demonstrated it

- 41 dashboard tests (App shell: routing/palette/collapse/search; explorer
  table+stream/filters/drawer; failures banner/tabs/timeline/honest N/A;
  simulator/demo-store preserved). Backend untouched **169 passed**.
- Live: rebuilt frontend serving; stack 8/8 healthy.

---

## 2026-08-26 (Cockpit pass — workspace tabs, activity feed, status bar, traffic lab)

### Concept

Second product pass over the v2 shell: turn the event drawer into a tabbed
investigation WORKSPACE (Overview/Payload/Processing/Context), add a Live
Activity feed with entrance highlighting, a persistent bottom status bar
(ENV/WS/API/last-update), Traffic-Lab modes with elapsed time, palette
Refresh + clearly-disabled future actions, and live ev/s labels on pipeline
nodes.

### What I learned

- Honest UX under missing data: the PROCESSING tab states that per-event
  processing details are not retained and points at the aggregate metric — the
  journey timeline marks only storage with a real timestamp.
- "ENVIRONMENT: LOCAL/REMOTE" is derived truthfully from hostname; no fake
  prod env claims. Peak ev/s is labeled *session data only*.
- Disabled future actions in the palette ("Replay event… soon") communicate
  roadmap without pretending functionality exists.
- ps:refresh custom event lets one palette action refresh health polling +
  explorer without prop-drilling refresh functions.

### How the project demonstrated it

- 43 dashboard tests incl. workspace tabs, status bar, activity feed, traffic
  lab mode UI; backend untouched **169 passed**; build clean; stack healthy.

---

## 2026-08-26 (Product-design overhaul — cohesion pass)

### Concept

Close the remaining "dashboard pages in a shell" gaps: unboxed sections,
compact metric strip, dimmed receding sidebar, health as expandable service
rows, severity failure rows with error snippets, grouped command palette with
real search action, relative topbar clock.

### What I learned

- Linear's own redesign writeup validated the two biggest moves made here:
  (1) the navigation chrome must DIM so the working area takes precedence;
  (2) density is managed with white-opacity gradations, not color. Applied:
  sidebar darkened below canvas level, group labels shrunk to eyebrows.
- Replaced the last card-grid (KPI cards) with a borderless hairline-divided
  MetricStrip — cards are now reserved for genuinely distinct modules.
- Health converted from tile grid to expandable service ROWS (name | status |
  key metric | chevron → inline detail rows), matching control-plane patterns.
- Failure rows gained severity dots + error snippet previews for scannability.
- Palette restructured into grouped Navigation / Actions / Soon with a REAL
  "Search events" action (deep-links explorer with q param) and honestly
  disabled future items.
- Explorer timestamps now show milliseconds when present; empty state CTA
  routes to Traffic Lab; error copy states auto-retry behavior truthfully.

### How the project demonstrated it

- Dashboard suite **43 passed** (adapted assertions for intentional IA/visual
  changes; honesty assertions preserved and migrated). Backend **169 passed**.
  Build clean; Docker frontend rebuilt; stack healthy; :3000 serving.

---

## 2026-08-26 (REGRESSION FIX — stylesheet truncation)

### What happened

A PowerShell `-replace` cleanup of "legacy kpi styles" used a lazy regex whose
lookahead ended in `|$`. With no later alternative present, it matched to END
OF STRING and deleted ~60% of styles.css (everything after `.kpi-grid`):
buttons, badges, segmented control, tables, stream rows, pipeline
nodes/connectors, drawers, payload/timeline, cmdk, statusbar, progress,
launch card. Tests still passed (they assert DOM/behavior), but the app
rendered as unstyled concatenated text — the exact failure mode warned about:
"tests can pass while CSS is broken."

### Root cause & guardrails

- Regex alternation `(?=a|b|$)` + singleline `.*?` is a footgun for block
  deletion. Safer: delete by explicit line ranges or use structured tooling.
- Detection method that worked: selector-presence audit (grep each class the
  components emit vs selectors defined) + built-CSS size drop (28KB → 11KB).
- Fix: appended a consolidated RESTORED block with every missing section;
  verified via served-asset grep on :3000 (all selectors present, 27.8KB).

### Verification

43 dashboard tests · 169 backend · build clean · Docker healthy · served CSS
contains .pipe-node/.pipe-connector.active/.stream-row/.statusbar/.btn/
.badge.ok/.metric-strip.

---

## 2026-08-26 (RESTORE — dense analytics dashboard per reference baseline)

### What was restored vs polished

RESTORED: the dense KPI card grid (KpiCards) as the top of BOTH Overview and
Analytics ("Key metrics" card), the full Analytics composition (KPI grid →
throughput → type/source distributions → latency/failure-rate), and
Card-wrapped overview sections (Key metrics / Live pipeline / Throughput /
Live activity). Removed the unboxed Sections + MetricStrip experiment.

POLISHED (kept from newer passes): clickable KPI drill-down, pipeline node
side-panels with live ev/s, explorer ms-timestamps/stream mode/copy buttons,
failure severity rows + timeline drawer, Traffic Lab modes + progress,
grouped palette with search action, status bar, dimmed sidebar, health
expandable service rows.

### Verification

43 dashboard tests · 169 backend · build clean (27.75KB CSS) · dead
.metric-* styles pruned · Docker frontend rebuilt & healthy.

---

## 2026-08-26 (Final visual polish pass — append-only override layer)

### Approach

After two destructive-lesson cycles, all polish was applied as an APPEND-ONLY
override layer at the end of styles.css (clearly labeled), plus one invalid
property fix (`border-right-radius` → removed) and chart hover markers.
Zero structural/JSX redesign; zero backend contact.

### Polish contents

Uniform KPI card height/baseline/hover-focus; panel padding normalization;
throughput promoted to primary anchor (190px, mono axis labels, per-sample
hover tooltips via transparent SVG circles — capped at last 40 samples);
pipeline node/connector spacing + accent hover on node titles; distribution
row gap; table/stream row airiness; sidebar active left-indicator (expanded
only); topbar/statusbar rhythm; drawer tab spacing.

### Verification

43 dashboard tests · build clean · Docker frontend rebuilt & healthy ·
served CSS contains every polish selector · WS handshake through nginx still
101 with live metrics frames.

---

## 2026-08-26 (Reference restoration — horizontal pipeline + right rail)

### Restored per reference screenshot

- Overview recomposed: 7-card KPI strip (Consumer Lag moved to a persistent
  RIGHT RAIL) → LIVE PIPELINE (horizontal) → EVENT THROUGHPUT → trio row
  (Types | Sources | Latency/FailureRate/Lag stacked) → LATEST EVENTS
  (ms-timestamp table) → SYSTEM HEALTH chip strip → status bar.
- Pipeline rewritten HORIZONTAL: flex row of node cards, edge-to-edge
  connectors with junction dots, curved SVG branch split/merge around the two
  workers, flow animation only when ev/s > 0. Node click opens the inspector
  IN THE RAIL (no overlay drawer).
- KPI cards: metric-family icons + colored accent underline (blue/green/red/
  purple), bolder values (23px/700).
- Latest events table: HH:MM:SS.mmm timestamps, ✓ delivered dots, fresh-row
  highlight, click → event workspace.
- Chart x-axis: real clock labels sampled across the session window.
- TopBar "Last updated: HH:MM:SS"; sidebar brand subtitle EVENT ANALYTICS;
  collapse button "« Collapse".

### Verification

43 dashboard + 15 demo-store + **169 backend** tests · build clean · Docker
8/8 healthy · served CSS 33.6KB contains all new selectors · WS frame live.

---

## 2026-08-26 (Reference fix — KPI single row + measured-SVG topology)

### Fixed against the reference

1. KPI strip wrapped → `.kpi-grid` now `repeat(7, minmax(0,1fr))` on desktop
   (4-col ≤1450px, 2-col ≤860px); Consumer Lag lives only in the right rail.
2. Pipeline clipped/oversized → replaced flex `pipe-h` with a CSS-grid
   topology (`.pipe-topo`, 11 tracks incl. gap tracks, workers share a
   two-row area) + a MEASURED absolutely-positioned SVG connector layer:
   node edges are read from getBoundingClientRect on layout/resize, so
   paths start/end exactly at card edges; curved branch split after Kafka
   and merge before PostgreSQL; junction dots; dashed blue flow only when
   ev/s > 0; hidden + wrapped grid below 1100px.
3. Typography scale raised to reference values (body 13.5, h1 26/700,
   kpi-value 25/700, node names 13.5/700, labels 11).
4. Density: stack gap 10, rail 308px, content padding 14/20.

### Guardrails applied

- Old pipeline CSS removed by exact line-range cuts (headers mapped first),
  never by open-ended regex.
- ResizeObserver feature-detected for jsdom.

### Verification

43 dashboard · **169 backend** · build clean · Docker healthy · served CSS
contains .pipe-topo/.pt-node/.pt-conn-path/.kpi-grid/.ov-rail.

---

## Template (copy me)

### Concept

### What I learned

### What confused me

### How the project demonstrated it

### What I should revisit


---

# 15. Current Knowledge Gaps

Keep this list honest.

- [x] ~~Load testing~~ — DONE 2026-08-25 (Phase 7): real ladder + bottleneck analysis, `docs/load-testing.md`
- [x] ~~Consumer lag~~ — DONE 2026-08-25 (Phase 7): worker-heartbeat lag on /ready, /metrics gauges, /analytics
- [ ] Persistence-worker micro-batching (drain rate ~368 ev/s is the end-to-end bottleneck under burst)
- [x] ~~Production images + AWS deployment path~~ — DONE 2026-08-25 (Phase 8, local parts); actual cloud execution awaits operator (`infra/aws/README.md`)
- [ ] Rate limiting (deferred, `redis` available but not used for token bucket yet)
- [ ] `events_per_minute` precise sliding window (currently minute-bucket, `ZSET` alternative deferred)
- [ ] Alembic migrations for production (currently auto `create_all` `app/main.py:28`)

When a gap is resolved, move it to the completed section.

---

# 16. Completed Learning

- [x] 2026-08-24 Phase 1: FastAPI + PostgreSQL ingest, validation, batch all-or-nothing, duplicate 409, error envelope, body limit, Docker PG
- [x] 2026-08-24 Phase 2A: Kafka infrastructure, topics `application-events`/`dead-letter-events`, 6 partitions RF1, `KAFKA_AUTO_CREATE_TOPICS_ENABLE`, `docs/kafka-topics.md`
- [x] 2026-08-24 Phase 2B: Shared serialization `serialize_event`/`deserialize_event`, partition key `user_id→source→event_id`, producer `acks="all"` idempotence, lazy init, graceful down, non-fatal publish
- [x] 2026-08-24 Phase 2C: Generic `KafkaEventConsumer` manual commit, `auto_offset_reset="earliest"`, `enable_auto_commit=False`, `handle_raw` → commit only on success, payload-free logs
- [x] 2026-08-24 Phase 2D: Persistence worker `persistence-workers` idempotent `ON CONFLICT DO NOTHING` on `event_id`, duplicate delivery no duplicate row, API-originated idempotent
- [x] 2026-08-24 Phase 2E: Analytics worker `analytics-workers` in-memory `total/by_type/by_source`, independent groups same topic
- [x] 2026-08-24 Phase 2F: Batch UUID stabilization (`resolved_ids` fix), idempotency docs, at-least-once flow
- [x] 2026-08-24 Phase 2G: Retry `is_transient` + bounded backoff 0.1→0.4→1.6s max 3, DLQ `dead-letter-events` envelope, malformed→DLQ→commit, transient exhaustion→DLQ→commit, DLQ failure→no commit
- [x] 2026-08-24 Phase 2H: Canonical `/api/v1/*` plus legacy compatibility, `/metrics` deferred deliberately
- [x] 2026-08-24 Phase 4A: Redis `7-alpine` `docker-compose.yml:46` healthcheck `redis-cli ping`, `redis`/`fakeredis` deps, `app/redis/client.py` graceful `get_redis()`
- [x] 2026-08-24 Phase 4B: Redis analytics `seen:{event_id} NX EX 86400` idempotency + `PIPELINE INCR total/HINCRBY by_type/by_source/INCR per_minute EXPIRE 120` `app/services/analytics_service.py:28`, `get_metrics` Redis→fallback, TTL trade-offs `docs/redis.md`
- [x] 2026-08-24 Phase 4C: `GET /api/v1/analytics` + `/analytics` `app/api/routes_analytics.py:10` versioned, payload-free, `app/main.py:74` registered
- [x] 2026-08-24 Phase 4D: Graceful Redis down → in-memory `Counter` fallback, `POST` still 201, `GET /health` 200 `GET /ready` not 503 on Redis alone
- [x] 2026-08-24 Phase 4E: `FakeAsyncRedis` unit 6 + API 3 tests, live `redis:7-alpine` `PONG` + `POST 2 → total 2` + duplicate `seen` no double + `TTL` + fallback live verified, `92 passed` live
- [x] 2026-08-24 Phase 5A: WebSocket `/ws` + `/api/v1/ws`, `ConnectionManager`, ~1s metrics broadcaster from Redis state, broken-client cleanup, payload-free
- [x] 2026-08-24 Phase 5B: `analytics:failed` (terminal DLQ), latency sum/count, per_second derived, active_producers from by_source, consumer_lag=null (honest), `GET /events?limit&offset` newest-first PG + `created_at index`
- [x] 2026-08-24 Phase 5C: `frontend/` Vite+React18+TS, 8 areas, honest unavailable states, vitest 3 passed, production build OK
- [x] 2026-08-24 Phase 5D: `useWebSocket` reconnect 1s→2s→4s + REST polling fallback; compose adds api + frontend(nginx) services; dashboard :3000
- [x] 2026-08-24 Phase 5E: backend 99 passed/2 warnings, frontend 3 passed, live dashboard verification all PASS (`live_dashboard_verify.py`)
- [x] 2026-08-25 Phase 7A: real consumer lag via worker heartbeats — `lag_snapshot()` highwater−position, JSON heartbeat `{ts,group,lag}`, `/ready` + `/metrics` gauge + `/analytics.consumer_lag`, no new deps
- [x] 2026-08-25 Phase 7B: open-loop load generator `load-tests/loadgen.py` (offered vs completion throughput, tail visibility, percentiles, JSON results)
- [x] 2026-08-25 Phase 7C: benchmark ladder + orchestrator `load-tests/benchmark.py` (lag/docker-stats/db sampling, offset-based drain) — run of record in `docs/load-testing.md`
- [x] 2026-08-25 Phase 7D: bottleneck analysis with measured numbers only; Redis client socket timeouts so /ready stays fast during outages
- [x] 2026-08-25 Phase 8A: production multi-stage backend image (non-root, healthcheck, one image for api+workers) + root .dockerignore
- [x] 2026-08-25 Phase 8B: production settings gate — fail-fast on dev-default DATABASE_URL/KAFKA/REDIS when APP_ENV=production
- [x] 2026-08-25 Phase 8C: infra/docker-compose.prod.yml (built images, required-var credentials, log rotation)
- [x] 2026-08-25 Phase 8D: infra/aws/ EC2 runbook + user-data bootstrap (operator-executed deployment path)

---

# 17. Project Evolution

Record major architecture changes.

| Date | Change | Reason | Result |
|---|---|---|---|
| 2026-08-24 | Kafka topics `application-events`/`dead-letter-events`, `KAFKA_NUM_PARTITIONS=6` | Spec §6 small meaningful topics, parallelism | Infra ready for 2 workers |
| 2026-08-24 | Shared `app/kafka/serialization.py` + partition key `user_id→source→event_id` | Reuse, per-user ordering, deterministic | Producer/consumer share canonical format |
| 2026-08-24 | `KafkaEventConsumer` generic, manual commit | At-least-once, reusable for 2 groups | Foundation for persistence/analytics |
| 2026-08-24 | `persist_event` ON CONFLICT DO NOTHING | Consumer idempotency, API already inserted | Duplicate delivery no duplicate row |
| 2026-08-24 | Analytics in-memory `Counter` | No Redis yet, Phase 4 will replace | Independent consumption proven |
| 2026-08-24 | Retry + DLQ `app/kafka/retry.py` + `dlq.py` | Bounded retry, no poison loop, payload-free | Transient→retry→DLQ, permanent→DLQ directly |
| 2026-08-24 | Batch UUID fix `resolved_ids` | Two different UUIDs generated previously | Detection and persist now consistent |
| 2026-08-24 | `/api/v1` canonical + legacy keep | Spec §4.1 versioning, least disruption | Both `/health` and `/api/v1/health` work, tests preserve |
| 2026-08-24 | Redis `7-alpine` + `redis`/`fakeredis` + `app/redis/client.py` | Phase 4 counters, low-latency, not source of truth | `docker compose` now `postgres+kafka+redis` all healthy |
| 2026-08-24 | `analytics_service` Redis `seen` + `pipeline` | Idempotent distributed counters, TTL bounded | Duplicate `event_id` not double-counted, `per_minute` 120s |
| 2026-08-24 | `GET /api/v1/analytics` | Spec §11 dashboard metrics §4.1 | `total/by_type/by_source/per_minute` from Redis/fallback |
| 2026-08-25 | Consumer lag via worker heartbeats (JSON payload) → /ready, /metrics gauges, /analytics | aiokafka `highwater()` needs no Admin client; zero new deps; honest absence when stale | Real lag visible during load tests; backlog behavior measured |
| 2026-08-25 | Production image + APP_ENV=production fail-fast endpoint gate | runtime pip-install images are dev-grade; graceful degradation would silently mask misconfig in prod | `Dockerfile`, `.dockerignore`, `infra/docker-compose.prod.yml`, `infra/aws/*` |

---

# 18. Final Interview Checklist

State after Phase 9 (documentation phase):

- [x] every major technology (§4 deep dive)
- [x] every major component (docs/architecture.md inventory)
- [x] complete data flow (§3 numbered flow)
- [x] database schema (events table, unique event_id, created_at index)
- [x] API design (endpoints, envelope, versioning, batch semantics)
- [x] failure handling (retry/DLQ/degradation ladder + live proofs)
- [x] security (§10 incl. honest known gaps)
- [~] scaling strategy (worker groups demonstrated; multi-replica api designed on paper only)
- [x] performance bottlenecks (measured + analyzed §8/docs/load-testing.md)
- [x] testing strategy (§9)
- [~] deployment architecture (runbook ready; cloud execution pending operator)
- [x] why each technology was selected (§4 alternatives reasoning)
- [x] what I personally implemented (phase entries §14)
- [x] what failed during development (§7 + "What confused me" per phase)
- [x] actual benchmark results (§8, never invented)

# 19. Frontend polish pass — landing page + System Health fix (2026-08-28)

Reference-first visual polish of the existing dashboard (no rewrite; the frontend was already ~85% aligned to the reference).

**Landing page (net-new).** Added a dedicated `#/landing` route rather than a separate marketing site, so it shares the dashboard's design tokens and reads as the same product.
- `router.ts`: added `"landing"` to `ROUTES`.
- `App.tsx`: `PAGE_META.landing` entry (to satisfy the `Record<Route, …>` type) + an early `return <LandingPage …/>` placed *after* all hooks (React hook-order rule) and before the `.app` shell, since landing renders its own full-page chrome.
- `LandingPage.tsx`: own sticky nav, 2-zone hero (headline "Real-time Observability / for Streaming Systems" with the second line in accent), CTAs into the dashboard, a Your-Applications → PulseStream → Data-Stores flow visual, a 4-item feature grid, and a horizontal "how events flow" architecture strip (API → Kafka → Workers → PostgreSQL → Redis → WebSocket).
- **Honesty:** hero mini-metrics (ev/s, latency, lag) are wired to the live `metrics` snapshot with an em-dash fallback and a note that switches to "Connect the API to see live metrics" when `metrics` is null — no fabricated numbers. Nav links point only to sections that actually exist (no dead Docs/Pricing links).
- `Sidebar.tsx`: brand block is now a `<button>` navigating to `landing`.

**System Health bug fix (reference §13).** Rows showed doubled/overlapping text ("HealthyHealthy / PostgreSQLPostgreSQL"). Two causes: (a) `SystemHealth.tsx` rendered the status `Badge` twice, and (b) `.svc-list/.svc-row/.svc-name/.svc-metric/.svc-detail` were referenced but never defined in `styles.css`, so the row grid collapsed. Removed the duplicate Badge and added the missing grid CSS (with a `max-width:620px` rule that drops the metric column).

**Verification:** `npm run build` clean (tsc + vite, CSS 38.10 kB); `npm run test` 43/43 passing. No backend, API-contract, or existing-interaction changes.

## 20. Per-page visual polish pass (2026-08-28)

Reference-oriented audit across all pages. A read-only sub-agent grepped every component's classes against `styles.css` to find *defects only* (no redesign). Fixes applied:

- **Overview heading** → "Overview / Real-time system overview and key metrics" (was the `PULSESTREAM` wordmark). Page-title type raised to the reference hierarchy (26px/700; subtitle 13px `text-secondary`). Updated the one test asserting the old wordmark to query the heading role.
- **Invisible status dots (shared root cause).** `.badge .dot` had no `background`, so every badge's status dot was a 0-colour 5px gap. Added `background: currentColor` — dots now inherit the tone colour (green/amber/red/neutral). Fixes the Events "stored" pill, Simulator "Running" pill, and Health-row badges at once.
- **System Health strip (Overview) — doubled/colliding status.** `Badge` printed the status word *and* `.sc-status` printed it again, and `.svc-chip` wasn't a flex column so `.sc-status`/`.sc-metric` (inline, margin-top ignored) collapsed onto one line ("Healthylag 5"). Added a `dotOnly` mode to `Badge` (dot only, text → `aria-label`) so the chip shows `[•] Name / Status / metric`, and made `.svc-chip` a `flex-direction:column` container.
- **Failures.** `sev-retry_exhausted` had no matching CSS (only `.sev-exhausted`) → colourless dot on the most common DLQ case; renamed the selector. Loading skeleton used the 5-col `.stream-row` grid (bar trapped in the 74px column) → gave it a dedicated `.fail-skeleton` row. Defined the previously-missing `.fail-rows` container.
- **Failure rate card.** `.failure-summary` was undefined (stat blocks stacked and touched); reused the existing `.chart-stats` flex row (matches Throughput).
- **Latest events.** `.st-src`/`.st-user` were only styled under `.stream-row`, not `.latest-row`, so long source/user values wrapped and broke row alignment; added `.latest-row` truncation rules (ellipsis + `min-width:0`).
- **Health** — kept the expandable service rows (not converted to tiles): rows are the real interaction model (inline detail exposing every `/api/v1/ready` field). Tiles were a discussion point, not a reference requirement.
- **Pipeline** — connector geometry verified already correct (measured SVG at z-index 0 behind opaque nodes at z-index 1; branch split/merge intact). No change.

**Verification:** `npm run build` clean (tsc + vite, CSS 38.69 kB); `npm run test` 43/43 passing. No backend/API/WebSocket/routing changes; no functionality removed.



## §21 — Final visual QA / typography pass

Pixel-level pass against the stated type scale (titles ~26/700, metric values 24–28/700, nav 14–15, body 13–14, section titles 12–14/700 uppercase, metadata 11–12). Applied the "do nothing if correct" rule: verified the cascade's *effective* values before touching anything.

**Cascade audit (no change needed — already on target):** later override blocks win, so effective values are page-header h1 = 26px/700 (styles.css:861), panel-head h2 = 12.5px/700 uppercase (styles.css:862), kpi-value = 25px/700 (styles.css:864), body = 13.5px (styles.css:860). Earlier base rules (h1 19px, h2 11px/11.5px, body 13px) are shadowed. The only genuine gap was navigation.

**Changed:** `.nav-item` font-size 12.5px → 14px (styles.css:155) to hit the "navigation 14–15px" target; added `font-size: 13px` to `.mobile-nav .nav-item` (styles.css:202) to keep the horizontal chip bar compact. Sidebar (208px expanded) has ample room for 14px labels — no wrap/overflow; mobile chips already scroll via `overflow-x: auto`.

**Verification:** `npm run test` 43/43; `npm run lint` (tsc --noEmit) clean; `npm run build` clean (CSS 38.71 kB, JS 227.59 kB). No backend/API/WebSocket/routing changes; no functionality removed.

## §22 — Multi-tenant DB foundation (Increment A) (2026-08-28)

First increment of the single-tenant → multi-tenant SaaS evolution. Scope was deliberately narrow: **database foundation only**, non-destructive, no auth logic, no frontend. SPEC scopes PulseStream as single-tenant and must not change (CLAUDE.md), so all tenancy decisions are recorded here.

**Alembic introduced (was: `Base.metadata.create_all`).** `alembic/env.py` runs through the app's own async engine (asyncpg) and reads `DATABASE_URL` from `Settings` — same connection string as the app, no creds in `alembic.ini`. The single migration `0001_multitenant_foundation` is **guarded/idempotent** (inspects the live schema before each op) so it safely *adopts* a database whose base tables were already created by `create_all` (the docker `pgdata` volume) — it also creates `events`/`event_failures` from scratch on a fresh Alembic-only DB. Added `alembic` to `requirements.txt` (prod must be able to migrate). `create_all` still runs in dev/tests as a convenience and is now a no-op for existing tables.

**New tables:** `organizations` (tenant), `users` (argon2 hash later; no plaintext), `memberships` (user↔org + role, unique per pair), `api_credentials`, `sessions`. No rows are created for users/sessions/etc. — foundation only.

**`organization_id` on `events` and `event_failures`:** NOT NULL, FK → `organizations.id` (`ondelete=RESTRICT`), with `server_default` = the reserved Demo org UUID. The server_default is the key trick that lets the existing **shared-key ingest and the Kafka consumer path keep working untouched** — neither resolves a tenant yet (that is Increment C), so the DB fills Demo automatically. To be removed once explicit tenant threading lands.

**Uniqueness moved from global `event_id` to composite `(organization_id, event_id)`** (`uq_events_org_event_id`). `event_id` kept as a *non-unique* lookup index. Two tenants may legitimately reuse an event_id. Updated the one dependent site: `persist_event` ON CONFLICT target `["event_id"]` → `["organization_id", "event_id"]` (a stale single-column target would have errored — no matching unique index).

**Reserved Demo org** (`00000000-0000-0000-0000-000000000001`, slug `demo`, `is_reserved=true`) owns all pre-existing data and the shared `PULSESTREAM_API_KEYS` flow. Seeded two ways so both schema-creation paths satisfy the FK: explicitly in the migration, and via a SQLAlchemy `after_create` listener on the `organizations` table (fires under `create_all` in dev + test fixtures). Backfilled all existing events into it.

<!-- INCREMENT_A_VERIFY_MARKER -->

**Security foundations (schema, not yet enforced):** passwords → `password_hash` only; API secrets → `hashed_secret` + public `key_prefix` (raw secret never stored, shown once at creation later); sessions → `token_hash` only, with `expires_at` + `revoked_at`. **DB-backed sessions were chosen over stateless JWT specifically for server-side revocability** (logout must invalidate).

**Verification (measured, against the live docker `pgdata` volume):**
- Pre-migration snapshot: `events`=301, `event_failures`=0, no `organization_id`, unique index `ix_events_event_id`, only 2 tables.
- `alembic upgrade head` → post-migration: **all 301 events preserved and backfilled to Demo** (`count(DISTINCT organization_id)=1`), `event_failures`=0, Demo org present, 8 tables, `events` has FK `fk_events_organization` + composite unique `uq_events_org_event_id`, `ix_events_event_id` now **non-unique**, `alembic_version`=`0001_multitenant_foundation`.
- Restarted `api` + both workers (source is volume-mounted → they run the new code). API `/health` 200. `POST /api/v1/events` → 201 and the new row auto-assigned to Demo; `GET` → 200; duplicate `POST` → 409 (composite dedup); `EventOut` unchanged (no `organization_id` leaked into the API contract). Persistence worker consumed the same event and logged "idempotent skip" — the composite ON CONFLICT works on the consumer path, worker stayed healthy (no traceback).
- Backend suite: **162 passed** (`pytest`, integration tests ran against docker Postgres). Deliberately ignored `test_failure_matrix_integration.py` (it stops/starts containers for several minutes; orthogonal to tenancy).

**Data-loss note (honest):** `test_persistence_integration.py` truncates `events` on teardown (pre-existing test design), so after the suite the demo `events` were cleared to 0. Data *preservation by the migration itself* was proven by the before/after counts above; the reserved Demo org and all tenant tables survive. Demo traffic is regenerable via the Simulator / Demo Store.

**Deferred to later increments (NOT done here):** resolving an API key → organization at ingest; org-scoping the read queries (`find_existing_event_ids`, `list_recent_events`, `get_event_by_id`, failures) — safe for now because Demo is the only tenant; removing the `organization_id` server_default once tenant context is threaded explicitly; login/signup, WebSocket isolation, Redis/Kafka key namespacing. No frontend, pipeline-visual, or SPEC changes.


## §23 — Server-side authentication (Increment B) (2026-08-28)

Second increment. Scope: a complete **server-side auth system** (signup, login, logout, `/auth/me`, forgot/reset password) on the tenant tables from Increment A. Explicitly out of scope and NOT touched: tenant isolation of data, frontend auth, WebSocket auth, API-key management UI, landing page, pipeline redesign. The API-key event-ingestion flow is unchanged.

**Two hashing algorithms, on purpose** (`app/core/security.py`): passwords use **Argon2id** (`argon2-cffi`, memory-hard, deliberately slow) — correct for low-entropy human secrets. Opaque tokens (session tokens, reset tokens) use **SHA-256** — they are 256-bit random (`secrets.token_urlsafe(32)`), so there is nothing to brute-force and a fast non-reversible lookup digest is the right tool; Argon2 there would add latency for zero benefit. Raw password and raw tokens are never stored or logged. `verify_password` swallows all errors → `False` so callers treat every failure identically.

**Sessions are DB-backed, not JWT** (continuing Increment A's rationale): the raw session token lives ONLY in an httpOnly cookie; the `sessions` row stores its SHA-256 hash. Lookups reject revoked (`revoked_at`) or expired (`expires_at`) sessions, so **logout is real server-side invalidation** and a stolen cookie can be killed — impossible with stateless JWT without extra machinery.

**Cookies** (`routes_auth._set_session_cookies`): `ps_session` is `HttpOnly` (JS can't read it → XSS can't exfiltrate); `ps_csrf` is deliberately NON-httpOnly (the SPA must read it to echo in a header). Both `SameSite=lax`, `Path=/`, `Max-Age`=session TTL. `Secure` is off in dev (http) but **forced on in production** via `Settings.session_cookie_secure_effective` (`… or app_env == "production"`).

**CSRF = double-submit token** (`app/core/csrf.py`): state-changing requests (POST/PUT/PATCH/DELETE) must send `X-CSRF-Token` matching the `ps_csrf` cookie (constant-time compare); safe methods are never challenged. A cross-site attacker can cause the cookie to ride along but cannot read it to populate the header (same-origin policy) → mismatch → 403. Applied to `logout`. **Not applied to API-key ingestion** — that uses a custom header + no cookie, so it is inherently CSRF-safe; leaving it alone is what keeps the existing flow byte-for-byte identical.
<!-- INCREMENT_B_VERIFY_MARKER -->

**Rate limiting** (`app/core/rate_limit.py`): per-process fixed-window counter keyed by `(bucket, client-ip)`, applied to signup/login/forgot/reset. Dependency-free and deterministic in tests (no Redis round-trip on the auth hot path). **Honest limitation:** in-process means it is per-instance; a distributed Redis-backed limiter is deferred to the deployment/scaling increment. Limits come from settings at call time so tests tune them via env + `get_settings.cache_clear()`. Returns the standard 429 envelope with `retry_after_seconds`.

**Anti-enumeration:** login returns one generic `invalid_credentials` for unknown-email / wrong-password / inactive alike; a **dummy Argon2 verify** runs when the email is unknown so response timing doesn't leak account existence. `forgot-password` always returns the same 200 message whether or not the account exists. (Signup necessarily 409s on a taken email — unavoidable for account creation.)

**Password reset** needed a token store → new model `password_reset_tokens` + guarded migration `0002_password_reset_tokens` (`down_revision=0001`, inspects live schema, no-op if the table already exists — same adoption pattern as 0001). Tokens are single-use (`used_at`) and expiring (`expires_at`, 30 min). Consuming a reset **revokes all of the user's sessions** (a reset must log out everywhere). Delivery: production emails the link (out of scope here); in non-production the raw token is returned in the response body so the flow is testable end-to-end — guarded by `app_env != "production"`, documented in `routes_auth.forgot_password`.

**Protected-route dependency** (`get_current_context` / `get_current_user`): reads the session cookie, resolves it to a live session + active user, else 401 `not_authenticated`. Uses `Depends(get_db)` which FastAPI request-caches, so the sub-dependency and the route handler share one DB session (needed so logout can revoke on the same session).

**Settings added** (`app/core/config.py`, all overridable via env, mirrored in `.env.example`): `session_cookie_name`, `session_ttl_seconds` (7d), `session_cookie_samesite`, `session_cookie_secure` (+ `_effective` property), `session_cookie_domain`, `csrf_cookie_name`, `csrf_header_name`, `auth_rate_limit_max` (10), `auth_rate_limit_window_seconds` (60), `password_min_length` (10), `password_reset_ttl_seconds` (1800). New deps: `argon2-cffi`, `email-validator` (for `EmailStr`).

**Verification (measured):**
- `alembic history` → single linear chain `base → 0001 → 0002 (head)`, one head. `alembic upgrade head` on the live docker DB advanced `0001 → 0002`; `password_reset_tokens` created with the six expected columns; migration is create-only so **event/user data untouched** (it only adds a table).
- Backend suite: **180 passed** (`pytest --ignore=tests/test_failure_matrix_integration.py`) = 162 prior + **18 new** in `tests/test_auth_system.py` covering signup (cookies httpOnly/CSRF-readable, no secret leak), duplicate-email 409, weak-password 422, login success, wrong-password + unknown-email (identical generic 401), `/auth/me` (401 unauth / 200 auth), logout requires CSRF (403) and revokes + clears cookies, revoked-session rejected, expired-session rejected (forced via DB), full reset flow (old pw fails / new works / sessions revoked), single-use token, generic forgot response, invalid reset token 400, login rate-limit 429, and API-key ingestion still 201. Same skip note as §22 for the failure-matrix module (multi-minute container churn, orthogonal).
- **Live smoke test** (restarted `api` container → it `pip install`s the new deps from `requirements.txt`, proving the manifest is complete): signup → 201 with `ps_session; HttpOnly` + readable `ps_csrf`; `/auth/me` → 200; logout w/ CSRF → 200 then `/auth/me` → 401; logout w/o CSRF → 403; **API-key ingestion unchanged** — 401 without the configured `ps_demo_key_local`, 201 with it (pre-existing behavior, my code did not touch it).

**Deferred (NOT done here):** binding a signup to an organization/membership (tenant increment); email delivery of reset links; frontend auth shell / SPA integration; WebSocket session auth; API-key management UI; distributed (Redis) rate limiting; removing the dev-only reset-token echo once email exists. No SPEC, frontend, or pipeline-visual changes.


## §24 — Tenant context + API-key ingestion isolation (Increment C) (2026-08-28)

Third increment. Scope: make ingestion **tenant-aware end-to-end** — DB-backed, org-owned API keys resolved server-side; `organization_id` attached to every event and threaded through Kafka → workers → Redis → the read APIs; complete cross-tenant isolation. Explicitly deferred and NOT touched: the frontend / API-key UI, WebSocket isolation, landing page, pipeline visuals, PROJECT_SPEC.

**API key format & storage** (`app/services/tenant_service.py`): a key is `psk_` + `secrets.token_urlsafe(32)`. The `psk_` marker makes a leaked key obviously a PulseStream ingest key (greppable in incident response); the entropy after it is what authenticates. We store **only** a SHA-256 hash (`hashed_secret`) plus a 12-char public `key_prefix` — the raw key is returned exactly once, at creation, and never persisted. Same two-algorithm rationale as §23: keys are high-entropy, so SHA-256 (fast, non-reversible lookup) is correct; Argon2 would add latency for no benefit. Resolution = prefix lookup → **constant-time** `tokens_equal(hash, stored)` over candidates → revocation check → stamp `last_used_at`. Constant-time compare runs even for revoked rows so timing can't distinguish "revoked" from "never existed". Never logs the key.

**Why no new migration:** every table and column this increment needs (`organizations`, `memberships`, `api_credentials`, and the `events.organization_id` composite-unique + FK) already shipped in migration `0001` (Increment A). Increment C is pure application logic over the existing schema — `alembic history` stays `base → 0001 → 0002 (head)`, unchanged.
<!-- INCREMENT_C_VERIFY_MARKER -->

**Two auth surfaces, two org resolvers — never trust the client.** The work order's hard rule is "never accept `organization_id` from the frontend/client for authorization." Two server-side resolvers enforce it:
- **Ingestion (write) — `app/core/auth.py::require_ingest_api_key`.** Order matters: (1) no key + no configured shared keys → Demo (open dev path preserved); (2) no key + shared keys configured → 401 `missing_api_key`; (3) key not equal to its own `.strip()` → `malformed_api_key`; (4) key matches a configured `PULSESTREAM_API_KEYS` value → Demo (the existing Demo Store / Simulator shared key still works); (5) otherwise resolve against the DB → the owning org, else 401 `invalid_api_key`. Padded-key rejection is ordered **before** the config/DB checks so `test_malformed_key_rejected` holds.
- **Reads — `app/core/tenant_context.py::resolve_read_organization`.** Reads the session cookie; **no/invalid session → Demo, and it NEVER raises 401**, so `/events`, `/analytics`, `/failures` stay public exactly as before (unauthenticated callers see the Demo/public dashboard). An authenticated caller gets their own org via `get_or_create_user_organization`. Both resolvers derive the org id entirely server-side.

**Lazy org provisioning** (`get_or_create_user_organization`): users created in Increment B have no org yet. First time one is needed (creating a key, or an authed read), we provision a personal `Organization` (deterministic slug `org-{user.id.hex[:12]}` so a retry can't collide) + an `owner` `Membership`, absorbing `IntegrityError` on concurrent create (re-query by membership, then by slug). The reserved **Demo** org is never auto-created here — it is seeded with the schema.

**Redis namespacing — Demo/None keeps LEGACY keys, everyone else gets `org:{id}:`** (`analytics_service._org_segment`). This was the sharp design tension: the existing Redis unit tests assert *literal* key strings (`{prefix}seen:{eid}`, `{prefix}analytics:per_minute:{minute}`), and the public dashboard reads the un-namespaced keyspace. Solution: `organization_id is None` or `== DEMO` → empty segment (byte-for-byte identical to pre-tenant keys); any other org → `org:{id}:` segment prefixing **every** key — counters, the `seen:` dedup set, and per-minute buckets. Net effect: dedup is now **per-tenant** (the same `event_id` in two tenants counts once *each*, never cross-deduped), and no tenant can read or clobber another's counters. `reset_metrics` scans `{prefix}analytics:per_minute:*`, `{prefix}seen:*`, and `{prefix}org:*` to purge all tenants. In-memory fallback (Redis down) returns an **empty** snapshot for a non-Demo org rather than leaking the process-global counters (which aren't tenant-partitioned).

**Kafka org threading** (`serialization.py`): `serialize_event` emits `organization_id` (string, or `null` for a transient row whose column default hasn't flushed); `deserialize_event` parses it as **OPTIONAL** — missing/`None` → `None` (legacy messages published before this increment still deserialize), invalid UUID → `ValueError`. The consumer (`event_consumer_service.persist_event`) and `failure_recorder.record_failure` both attach `organization_id` only when present, otherwise **omit the column** so its `server_default` (Demo) applies — passing an explicit `None` would violate the NOT-NULL column, so the "omit vs. set" distinction is load-bearing. The composite `ON CONFLICT (organization_id, event_id) DO NOTHING` idempotency is preserved.

**API-key lifecycle API** (`app/schemas/api_key.py`, `app/api/routes_api_keys.py`, backend only): `POST /api-keys` (CSRF + auth) → provisions/uses the caller's org, mints a key, returns the raw secret **once** (`ApiKeyCreatedOut`); `GET /api-keys` → the org's keys via `ApiKeyOut` (prefix + metadata, **never** secret or hash); `POST /api-keys/{id}/revoke` (CSRF + auth) → sets `revoked_at`, scoped to the caller's org so another tenant's key id returns **404** (no cross-tenant existence signal, no IDOR). Registered at both `""` and `/api/v1` like the other routers. No frontend built (deferred per scope).

**Verification (measured):**
- New suite `tests/test_tenant_isolation.py`: **12 passed** — A→A / B→B ingestion + scoped reads (B can't see A's events, cross-id GET is 404); ingested row carries A's non-Demo org; key create returns raw once + list hides secret; unauth/missing-CSRF rejected; revoked key → 401 at ingestion; can't revoke another tenant's key (404); Demo shared key → Demo org; failures are tenant-scoped; Redis analytics + dedup namespaced per tenant; Kafka round-trip preserves `organization_id` and legacy (no-org) messages deserialize to `None`.
- **Test-environment note (honest):** the shared docker Postgres holds a live stream worker that re-inserts the broker copy of each published event; because that deployed worker predates org-threading it lands the copy under the Demo default, so a single API ingest can leave the *same* `event_id` under two orgs in the DB. The DB-level assertions were written to be robust to this (assert the caller's non-Demo org is *among* the rows) rather than assuming exactly one row. This is a running-container artifact, not a code path in this increment — the API insert itself uses the resolved org.
- `alembic history` unchanged (`base → 0001 → 0002`, single head) — no migration needed (see above).

**Deferred (NOT done here):** frontend / API-key management UI; WebSocket tenant isolation; landing-page and pipeline-visual changes; per-tenant heartbeat/lag scoping (heartbeats stay worker-scoped — a worker serves all tenants, so lag is a per-consumer-group property, not per-tenant; documented rather than forced). No SPEC changes.


## §25 — Multi-tenant WebSocket isolation (Increment D) (2026-08-28)

Fourth increment. Scope: make the dashboard's live socket (`/ws`) **authenticated and tenant-partitioned** — resolve the org server-side from the session cookie, reject anonymous connections, group connections into per-organization rooms, and broadcast each org a snapshot computed from *only its own* data. Explicitly deferred and NOT touched: frontend auth, API-key UI, landing page, pipeline visuals, PROJECT_SPEC.

**Auth gate — a deliberate policy change from the read path.** Increment C's read resolver (`resolve_read_organization`) NEVER raises: no/invalid cookie → Demo, keeping REST reads public. The WebSocket resolver `resolve_ws_organization` (in `app/core/tenant_context.py`) is the opposite by design — no/invalid session → **`None`**, and the endpoint then `close(code=1008)`s the handshake **before `accept()`** (so the client sees an HTTP 403 and the socket never joins a room). The work order requires "reject unauthenticated WebSocket connections", so the live socket is now authenticated. The public/Demo dashboard keeps working via the **polling fallback** — the REST `/analytics` endpoint is still public and still Demo-scoped — which is exactly why "preserve the polling fallback" is called out: it is what covers the anonymous dashboard now that WS requires auth. The org is read only from the cookie; query params / headers / any client-supplied org id are ignored for authorization (test: `test_ws_org_comes_from_session_not_query_or_headers`).

**Per-organization rooms** (`app/api/ws.py::ConnectionManager`): the flat `set[WebSocket]` became `dict[org_id -> set[WebSocket]]`. A room key exists only while it has ≥1 socket (empty rooms are deleted), so `organizations()` never yields a tenant with nothing to send to. `broadcast_to_org(org, data)` touches exactly one room and evicts sockets that fail on send (one dead client can't wedge the loop or crash siblings) — the broken-client-removal and payload-free-logging guarantees from the pre-tenant manager are preserved. `active_connections` is kept as a **read-only aggregate property** (union across rooms) purely so the Prometheus gauge (`app/core/metrics.py`) and `/ready` health payload keep working unchanged; nothing broadcasts to it.

**Per-org broadcaster** (`app/services/broadcaster.py`): the loop body was extracted into `broadcast_once()`, which iterates `manager.organizations()` and, for each, calls `get_metrics(organization_id=org)` (that org's isolated `org:{id}:` Redis keyspace from §24) and sends the result only to that org's room. Snapshots are computed **only** for orgs with a live client — no wasted work, and structurally no way to hand one tenant another's numbers. On connect the endpoint also sends an immediate snapshot so a fresh client isn't blank until the next tick; same `{"type": "metrics", "data": {...}}` shape, so the wire contract is unchanged.

**Session resolver uses its own short-lived DB session.** WebSocket routes have no request-scoped `get_db` generator, so `resolve_ws_organization` opens its own `SessionFactory()` on the caller's event loop (no cross-loop asyncpg reuse). It reuses the exact §B/§C primitives — `auth_service.get_valid_session` → `get_user_for_session` → `tenant_service.get_or_create_user_organization` — so a user with no org yet is lazily provisioned here too.

**Testing approach — why FakeWebSocket, not TestClient, for the isolation tests.** Real WS isolation needs a real session cookie (Postgres) AND real per-org metrics (Redis). But httpx/`ASGITransport` can't open a WebSocket, and Starlette's sync `TestClient` runs its socket on an `asyncio.run` portal loop that collides with asyncpg's loop-bound pool the moment a test also touches the DB on another loop. Resolution: `tests/test_increment_d_ws_isolation.py` drives the **endpoint coroutine directly** with a `FakeWebSocket` double, on the single pytest-asyncio session loop — real signup via `AsyncClient`, real cookie fed to the fake socket, real manager/broadcaster, `fake_redis` for deterministic metric values. The sync `TestClient` (`tests/test_websocket_unit.py`) is kept only for the handshake-level rejection tests (no cookie → returns before any DB access → always run, no Postgres). The old unauthenticated-connection unit tests were intentionally removed/replaced — "reject unauthenticated" makes them obsolete — and `test_prometheus_metrics::test_websocket_gauge_changes` was updated to move the gauge by driving the manager with a fake socket instead of an (now-rejected) anonymous handshake.

**Verification (measured):** <!-- INCREMENT_D_VERIFY_MARKER -->
- Full backend suite (Docker Postgres + Kafka + Redis all up): **206 passed, 0 failed** in ~123s (was 199 after Increment C; net +7 = +10 new WS-isolation tests, −3 obsolete unauthenticated unit tests). New file `tests/test_increment_d_ws_isolation.py` (10 tests): unauthenticated rejected (never accepted, close 1008); invalid session rejected (not downgraded to Demo); authenticated connection accepted + immediate snapshot; org resolved from session, not query/header; tenant A vs B each see only their own totals (A=3, B=1) — no leakage; multiple clients same org get identical snapshots; disconnected client cleaned up; broken client evicted without starving siblings; message shape `{"type":"metrics","data":{...}}` preserved; broadcast never logs payload.
- **Rate-limit gotcha:** the new tests do ~9 signups; the per-process auth limiter (10/60s) is shared across the whole suite, so they 429'd when run after the other auth-heavy suites. Fixed by calling `reset_rate_limits()` in the module's autouse fixture (same pattern as `test_auth_system`), not by loosening the limit.
- **Live Docker WebSocket smoke** (against the running compose stack — api on :8001, redis on :6379; `api` container restarted so uvicorn re-imported the new modules): anonymous `ws://…/ws` → rejected with HTTP 403 (no 101 upgrade); two real signups → both accepted, both frames `type=metrics`; per-org isolation → seeding `pulsestream:org:{A}:analytics:total=4242` in live Redis showed `A.total=4242` while `B.total=0` on their respective sockets. All three checks PASS. Smoke script was temporary and removed after the run.

**Deferred (NOT done here):** frontend WebSocket auth wiring / dashboard login; API-key UI; landing-page and pipeline-visual changes. No SPEC changes.

## §26 — Frontend authentication shell (Increment E) (2026-08-28)

Fifth increment. Scope: build the **frontend** auth experience on top of the now multi-tenant backend — auth context from the session cookie, the auth routes (login/signup/forgot/reset/logout/account), protected dashboard routes, global 401/403 handling through one API client, CSRF on mutations, WS wired to the authenticated session, polling fallback preserved, and the org/workspace name shown in the shell. Explicitly deferred and NOT touched: API-key management UI, Integration/Developer page, Landing-page redesign, pipeline visuals, PROJECT_SPEC.

**One shared API client is the single choke point** (`src/lib/apiClient.ts`). Every call goes through `request()`, which: sends `credentials:"include"` (the httpOnly `ps_session` cookie rides automatically); on mutations reads the non-httpOnly `ps_csrf` cookie and echoes it in `X-CSRF-Token` (the backend's double-submit check from §B); parses the structured `{error:{code,message,details}}` envelope into a typed `ApiError(status, code, details)`; and on a 401 dispatches a global `ps:auth-expired` DOM event. **Why a DOM event, not a React callback:** the client is framework-free and imported by non-React code, so it cannot call `setState`. The `AuthProvider` subscribes to the event and drops to `unauthenticated`; this decouples the transport from React and gives one place where an expired session forces a logout+redirect. The auth forms opt out with `silent401:true` because *their* 401 (a bad password) is a user-facing field error, not a session expiry — without the opt-out, a failed login would trigger a spurious global "session expired".

**Auth state derives from the server, never localStorage** (`src/context/AuthContext.tsx`). Source of truth is `GET /api/v1/auth/me`; state is `{status: loading|authenticated|unauthenticated, user}`. Probed once on mount and re-derived after every mutation (`login`/`signup` call `refresh()` then throw if `/me` still comes back empty). A `generation` ref guards against a late in-flight `/me` resolving *after* an explicit logout and resurrecting a dead session (the race: user clicks logout while a refresh is mid-flight). Keeping zero auth data in localStorage means there is no client-trusted identity to forge — the cookie the browser can't read is the only credential.

**The one required backend change** (justified as "absolutely required for frontend integration"): `/api/v1/auth/me` now returns the caller's organization. Added `OrganizationOut` + `MeOut(UserOut)` in `app/schemas/auth.py` and had the route resolve the org via the existing `tenant_service.get_or_create_user_organization`. This is **additive** — `MeOut` extends `UserOut`, existing `/me` consumers/tests (which only assert `email`) are unaffected — and it is the minimum needed to satisfy the work order's "display the authenticated workspace/organization name in the shell". No tenant/auth *architecture* changed; `get_current_user` is retained (still used by `routes_api_keys.py`).

**Routing kept the existing hash router** (`src/lib/router.ts`) rather than adding react-router. Rationale: the whole app already uses `#/route?params`, and hash routing keeps the static nginx deploy free of server-side rewrite rules (every path serves `index.html`; the SPA reads the fragment). Routes are split into `DASHBOARD_ROUTES` (protected), `AUTH_ROUTES` (public), and `landing` (public). Guarding lives in `App.tsx::AppRoutes` as a redirect **effect** (never during render, to avoid setState-in-render): unauthenticated + dashboard route → `login`; authenticated + a credential-entry route (`AUTH_REDIRECT_ROUTES`, which excludes `logout` since that's an action) → `overview`. While `status==="loading"` a splash renders instead of flashing a form.

**WebSocket wiring is one line of intent** (`Dashboard` passes `useWebSocket(wsUrl, user !== null)`). The browser auto-attaches the session cookie on the same-origin WS handshake and the backend (§D) authorizes from it, so the frontend only *gates* the socket to authenticated sessions. `useWebSocket` gained an `enabled` flag: when false it tears down any socket and returns, so an unauthenticated view (or a logged-out one) uses the **REST polling fallback** (`useAnalyticsMetrics`) unchanged — the fallback was preserved, not reimplemented. The public landing page renders with polling-only metrics (`useAnalyticsMetrics(null, false)`).

**Styling reuses the dashboard's design tokens** — new `src/styles/auth.css` (imported after `styles.css` in `main.tsx`) references the existing CSS variables (`--bg`, `--panel`, `--accent`, `--danger`, `--radius`, …) so the auth surface shares one visual language. Split-panel shell (brand rail hidden < 860px → single-column card), accessible fields (`useId`-wired label/error/`aria-describedby`, `aria-invalid`, password reveal with `aria-pressed`), loading (`aria-busy` + spinner, `prefers-reduced-motion` aware), error/success banners (`role=alert`/`status`), and the sidebar workspace chip + user/sign-out block. The existing dashboard was NOT redesigned.

**Stale-test fix in the backend suite (not caused by this increment, but surfaced by running it).** `test_websocket_disconnect_and_reconnect_compose` connected to the live compose WS **anonymously** and expected metrics — but §D made that handshake return HTTP 403. The test predated §D's enforcement (it passed at §D verification only because the then-running `api` container hadn't yet re-imported the WS-auth code). Corrected to sign up over HTTP, then present the `ps_session` cookie via the websockets client's `additional_headers={"Cookie": …}`; added a companion `test_websocket_rejects_unauthenticated_compose` that asserts an anonymous handshake raises `InvalidStatus` (403). This aligns the compose smoke tests with the intended authenticated-WS architecture; no backend behavior changed.

**Verification (measured):** <!-- INCREMENT_E_VERIFY_MARKER -->
- **Frontend unit/integration tests** (`npm run test` = `vitest run`): **58 passed, 0 failed** across 7 files (~5.6s). New file `src/auth.test.tsx` (15 tests): guards (anon→Login redirect, authed→dashboard redirect, no WS when anon, WS opens when authed), Login states (empty-submit validation with no network call, 401→"Invalid email or password", success→Overview), Signup states (short-password client validation, 409→email-exists), logout (session revoked + `X-CSRF-Token` present on the logout POST → redirect to Login), API client (CSRF header on mutations + `credentials:include`, no CSRF on GET, 401 dispatches `ps:auth-expired`, `silent401` suppresses it), and global session expiry (event drops authed shell to Login). Existing `src/App.test.tsx` updated: mocked `/api/v1/auth/me` returns an authenticated user with an organization, and a `makeResponse()` helper exposes `text()` (the apiClient reads `res.text()`, not `res.json()`); four shell tests now `await` the dashboard heading before interacting (the shell mounts async after `/me`).
- **TypeScript check** (`npm run lint` = `tsc --noEmit`): clean, 0 errors.
- **Production build** (`npm run build` = `tsc && vite build`): success — 78 modules, `index.js` 243.97 kB (gzip 73.85), `index.css` 46.08 kB (gzip 9.20).
- **Backend regression** (Docker Postgres+Kafka+Redis up): **207 passed, 0 failed** in ~121s (was 206 at §D; +1 net = the new anon-rejection compose test; the stale WS test was fixed in place, not added).
- **Live Docker smoke** (compose stack; `api` restarted to re-import the additive `/me`, `frontend` rebuilt to ship the new auth bundle): frontend `/` → 200 and the served CSS bundle contains `.auth-shell`/`.auth-card`/`.workspace-chip`/`.signout-btn`/`.auth-spinner` (new build shipped); full HTTP auth flow → `GET /me` anon **401 not_authenticated** → `POST /signup` **201** (sets `ps_session` + `ps_csrf`) → `GET /me` **200** now including `organization{id,name,slug}` → `POST /logout` without header **403 csrf_failed** → with `X-CSRF-Token` **200** → `GET /me` post-logout **401** (session revoked); authenticated WS delivers a `type=metrics` frame and an anonymous WS is rejected 403 (backend integration tests). Smoke script was temporary and removed after the run.

**Deferred (NOT done here):** API-key management UI, Integration/Developer page, Landing-page redesign, pipeline-visual changes. Only backend change was the additive `/me` organization field. No SPEC changes.

## §27 — Customer-facing SaaS features (Increment F) (2026-08-28)

Sixth increment. Scope: build the **customer-facing surfaces** on top of the completed multi-tenant auth system — an **API Keys** page (create org-owned keys, reveal the raw secret exactly once, list/revoke), an **Integration/Developer** page documenting the real ingest contract, a refined **Account** page, a rebuilt public **Landing** page, and the nav to reach them. **Zero backend changes** — this increment is entirely frontend, wired to the API contract that already exists (`routes_api_keys.py`, `routes_events.py`, `schemas/`). PROJECT_SPEC untouched; Kafka/Redis/auth architecture untouched.

**Read the contract before writing a line of UI.** The work order said "use the currently implemented API contract — do not invent endpoints or fields", so the first step was reading `app/api/routes_api_keys.py` and `app/schemas/api_key.py`/`event.py`. Everything the UI shows is grounded in what the server actually returns: `ApiKeyOut{id,name,key_prefix,created_at,last_used_at,revoked_at}` for the list, `ApiKeyCreatedOut` (adds `api_key`) only on create, and the exact `EventIn` field set (`event_type` regex, `source`, optional `timestamp`/`event_id`/`user_id`/`request_id`/`payload`/`schema_version`) documented verbatim on the Integration page. No fabricated fields, no invented endpoints, no fake data.

**The raw secret is rendered exactly once, from the create response only** (`src/components/ApiKeysPage.tsx`). The server returns `api_key` solely on `POST /api-keys`; the list endpoint never includes it. The UI mirrors that: `revealed` state holds the one-time `ApiKeyCreatedOut`, shown in an `.ak-reveal` banner with a "copy now — it will **not be shown again**" warning and a copy button; the table renders only `key_prefix…` + status/timestamps, never a secret. Dismissing the banner clears `revealed` for good. **The client never sends an organization id** — every call (`api.get/post`) resolves the caller's org server-side from the session cookie, preserving tenant isolation exactly as before.

**Destructive action is gated by an accessible confirm dialog** (`src/ui/ConfirmDialog.tsx`). Revoke opens a `role="alertdialog"` modal (focus moves to the confirm button, ESC/overlay cancels unless busy, body scroll locked) that names the key and states the consequence — "any application still using it will receive `401 invalid_api_key`", "cannot be undone". Revoke is idempotent server-side (only sets `revoked_at` if null), so a double-submit is harmless. Reusable pieces added: `CopyButton` (clipboard API with a `textarea+execCommand` fallback for non-secure contexts, transient "Copied" state, `aria-live`) and `ConfirmDialog`.

<!-- INCREMENT_F_MORE -->

**The Integration page documents the running API, not an idealized one** (`src/components/IntegrationPage.tsx`). `ORIGIN` derives from `window.location.origin` so copy/paste snippets hit the correct host in every environment. It shows the endpoint (`POST /api/v1/events` + batch/read-back), the `X-API-Key` auth header, a full event JSON, a schema table generated from the real field rules (required/optional badges, the `^[a-z][a-z0-9_.]*$` `event_type` pattern, the `409 duplicate_event`/`422` outcomes), and curl/JavaScript/Python examples — each with its own copy button. A "How it works" flow strip (Your App → PulseStream API → Kafka → Workers → PostgreSQL·Redis → Dashboard) states plainly that the key attributes events to the caller's workspace.

**Account, Landing, and nav reuse the existing design language.** `AccountPage` gained an identity header (avatar/name/email/status), a Workspace card (org name/slug/id + isolation note), and a Developer card linking to the two new pages. `LandingPage` was rebuilt with six honestly-worded capabilities, a curl integration snippet, and CTAs routing to Sign up / Sign in — **no fake logos, testimonials, uptime, or metrics**; hero stats show an honest "—" when no live data is reported. Nav: a "Developer" group (API Keys, Integrations) added to `Sidebar` (MobileNav auto-includes it), matching `PAGE_META`/route entries in `App.tsx`, and Command Palette entries. New styles live in `src/styles/saas.css` (imported after `auth.css`), referencing existing tokens only — **no new dependencies**.

**Verification (measured):** <!-- INCREMENT_F_VERIFY_MARKER -->
- **Frontend unit/integration tests** (`npm run test` = `vitest run`): **71 passed, 0 failed** across 9 files (~8s), up from 58 at §E. New `src/apiKeys.test.tsx` (8 tests): empty state; list with prefix/Active/Never; create → one-time reveal of the raw secret + warning + copy (asserts `clipboard.writeText` called with the raw value) + new key appears in the reloaded list + dismiss hides the secret; server-error path (create fails → error shown, **no secret revealed**); revoke requires the confirm dialog then flips the row to Revoked; cancel leaves the key Active. New `src/landing.test.tsx` (5 tests): public marketing content renders with honest "—" placeholders; "Get Started" → `#/signup`; "Sign in" → `#/login`; unauthenticated visits to `#/api-keys` and `#/integrations` redirect to `#/login`. Tests mock `fetch` `Response`s exposing `text()` (the apiClient reads `res.text()`) and `navigator.clipboard.writeText`, following the existing `MockWS`/`makeResponse`/`ME`-with-organization harness; adding the Developer nav group did not break `App.test.tsx`.
- **TypeScript check** (`npm run lint` = `tsc --noEmit`): clean, 0 errors.
- **Production build** (`npm run build` = `tsc && vite build`): success — 83 modules, `index.js` 265.08 kB (gzip 79.07), `index.css` 54.24 kB (gzip 10.41).
- **Backend regression** (Docker Postgres+Kafka+Redis up): **207 passed, 0 failed** in 121.34s — unchanged from §E, as expected for a frontend-only increment (no backend files touched).
- **Docker smoke** (compose stack, all 8 containers healthy): `GET /api/v1/health` → 200 `{status:ok}`; `GET /api/v1/ready` → 200 with postgres/redis/kafka/persistence-worker/analytics-worker/broadcaster all healthy; frontend `/` → 200.
- **Live customer flow** (through the running stack at `localhost:8001`, a throwaway `@example.com` signup): signup **201** (org auto-created server-side) → login **200** → `/me` **200** returning `organization{id,name,slug}` (never client-supplied) → create key **201** with raw `psk_…` shown once → send event with that raw key **201** → `GET /events` (session-scoped) shows exactly that event **200** → revoke **200** (`revoked_at` set; `last_used_at` populated, proving the key had been used) → same raw key rejected **401 invalid_api_key** → logout **200** → `/me` **401** → login again **200** → the event is still present **200**. End-to-end pass; tenant isolation and cross-org rejection remain covered by the 207 backend integration tests. The verification script was temporary and removed after the run.

**Deferred / NOT done:** no Kafka/Redis/auth architecture changes, no pipeline-visual redesign beyond the Integration page's documentation flow, no PROJECT_SPEC edits, no Git operations. This completes Increment F.


## §28 — Final hardening and polish (Increment G) (2026-08-28)

Seventh increment. Scope: make the **existing** product production/demo ready — **no new product features**. Highest priority was the two pipeline visualizations; then a UI/typography/responsive/a11y polish pass, a security-regression check, and dead-code cleanup. **Entirely frontend** — zero backend files touched, so the auth/tenant/WS/API-key surface is unchanged by construction.

**The pipeline topology was faked, so the "fix" started by reading the backend, not the pixels.** The old `PipelineGraph` merged both workers into PostgreSQL and then drew PostgreSQL → Redis → WebSocket as one linear chain — topologically wrong. The real flow (verified in `event_consumer_service.py`, `analytics_service.py`, `broadcaster.py`): API → Kafka, then **two lanes that branch at Kafka and never re-merge** — Persistence Worker → PostgreSQL, and Analytics Worker → Redis → WebSocket. The component was rewritten to draw that honest topology with a **measured-SVG connector layer**: nodes sit on a CSS `grid-template-areas` two-row grid; an absolutely-positioned SVG draws each connector from live `getBoundingClientRect()` measurements (relative to the container), so every line pins exactly to a node edge. A `fork()` helper draws a smooth S-curve from Kafka's right edge to each worker; `straight()` draws edge-to-edge segments. Connectors are built upstream→downstream so the `stroke-dashoffset 20→0` flow animation travels in the real event-flow direction, and only animates when `ev/s > 0`. Geometry re-measures on `ResizeObserver` + window resize + content change (status badges / ev/s / worker lag), and below 1100px the grid collapses to a clean single-column stack with the SVG hidden — no broken connector geometry on mobile. Both the Overview "Live pipeline" and the Pipeline page "Event flow" render this same component, so one rewrite fixed both. Clickable nodes, health status, live ev/s, and the inspector selection are all preserved.

**Polish, driven by a two-agent audit (CSS + components), applied only where it was a genuine defect — not cosmetic churn.** Concrete fixes: `.latest-row` (Latest events table) had a ~510px-min 5-column grid with no narrow breakpoint → horizontal overflow on mobile; added a ≤720px rule that drops the User column (header and body together) so it never overflows. The landing hero `.lp-flow` had fixed-width nodes with no wrap → overflow at ~390px; it now stacks vertically at ≤560px. Pipeline node labels (`.pt-name`) switched from `nowrap` (which spilled "Persistence Worker" past the card edge at tight widths) to wrapping, with a node `min-height` so lanes stay aligned. The token-refactor suggestions from the audit (introduce `--accent-line`/`--radius-xs`, normalize `550`/`650` weights) were **deliberately skipped** — they are consistent as-is and the work order forbids refactoring working code for its own sake.
<!-- INCREMENT_G_MORE -->

**Accessibility fixes were the other substantive change.** Custom `role="button"` elements handled Enter but not Space (Space should activate and be `preventDefault`-ed to stop page scroll); fixed across `ActivityFeed`, `Distributions`, `KpiCards`, `SystemHealth`, `FailuresView`, and both `EventExplorer` rows, and the clickable `EventExplorer` table row gained `role="button"`. `Drawer` was a `role="dialog" aria-modal` with **no focus management** — it now moves focus into the panel on open, traps Tab focus within the drawer, and restores focus to the previously-focused element on close (Escape/scroll-lock were already correct; `ConfirmDialog` and `CommandPalette` already handled focus). The `Sidebar` collapse button (which renders only "»" when collapsed) got an `aria-label`. `ActivityFeed` also gained the loading/error states it was missing — it previously showed the empty message during the first fetch and silently swallowed load failures; it now shows a skeleton while loading and an error banner on first-load failure, keeping the honest empty state only when the fetch truly returns no rows.

**Cleanup:** deleted `PipelineStrip.tsx` (superseded by `PipelineGraph`, imported nowhere — confirmed no source or test references) and removed its now-orphaned `.pipe-node`/`.pipe-name`/`.pipe-connector`/`.pipe-line`/`.pipe-branch` CSS rules. Consciously **not** removed: two `CopyButton` variants and the hand-rolled `.badge` pills the audit flagged — both work, and `ui/Badge` is typed to `DependencyStatus` so it does not fit the non-status pills; consolidating them is a refactor the work order excludes.

**Security regression check:** none. Every changed file is frontend presentation/a11y — no server-side session, CSRF, tenant-isolation, API-key hashing/revocation, WebSocket-auth, or org-derivation code was touched, and the client still never sends an organization id. Verified live below.

**Files changed (11):** rewrote `frontend/src/components/PipelineGraph.tsx`; edited `frontend/src/styles.css`, `frontend/src/ui/Drawer.tsx`, `frontend/src/components/ActivityFeed.tsx`, `Distributions.tsx`, `KpiCards.tsx`, `SystemHealth.tsx`, `FailuresView.tsx`, `EventExplorer.tsx`, `Sidebar.tsx`; deleted `frontend/src/components/PipelineStrip.tsx`.

**Verification (measured):**
- **Frontend tests** (`vitest run`): **71 passed, 0 failed** across 9 files (~8s) — unchanged count; `App.test.tsx`'s `.pipe-topo` node-name and "Live pipeline"/"Event flow" assertions still green after the pipeline rewrite.
- **TypeScript** (`tsc --noEmit`): clean, 0 errors.
- **Production build** (`tsc && vite build`): success — 83 modules, `index.js` 265.81 kB (gzip 79.46), `index.css` 54.47 kB (gzip 10.44).
- **Backend tests** (`pytest tests`, Docker Postgres+Kafka+Redis up): **207 passed, 0 failed** in 121.38s — unchanged, as expected for a frontend-only increment. Individually re-confirmed the security-relevant suites: tenant isolation `test_increment_c_isolation.py` **12 passed**, WS isolation `test_increment_d_ws_isolation.py` **10 passed**, auth + API-key lifecycle `test_auth.py`+`test_auth_system.py` **29 passed**. (Note: running an arbitrary *subset* of async test files together triggers spurious "coroutine never awaited"/RuntimeError failures because the pytest-asyncio loop scope is `session`; each file passes alone and the full suite passes — a harness artifact, not a regression.)
- **Docker health** (compose stack, all 8 containers healthy): `GET /health` → 200 `{status:ok}`; `GET /api/v1/ready` → 200 `status:ready` with postgres/redis/kafka healthy and broadcaster running.
- **Live authenticated WebSocket smoke** (throwaway `@example.com` signup against `localhost:8001`): signup **201** + `ps_session` issued → WS `/api/v1/ws` with the session cookie **accepted**, pushed a `{type,data}` metrics frame → WS **without** the cookie correctly **rejected with HTTP 403** (org resolved server-side, never accepted into a room). Temporary smoke script removed after the run.

**Deferred / NOT done / limitations:** the running `frontend` container image predates these edits (built earlier), so the manual **browser** walkthroughs (visual pipeline render, API-key reveal-once UI, responsive behavior at real tablet/mobile widths) were **not** re-driven in this environment — they require rebuilding the image and a browser, which is left to the user's redeploy; the responsive/visual fixes above are reasoned from the CSS + verified by build/tests, not by a live screenshot. Cross-org data isolation and API-key rejection are covered by the backend integration tests (confirmed green), not re-driven through the UI. No token-system refactor, no `CopyButton`/`Badge` consolidation, no backend changes, no PROJECT_SPEC edits, no Git operations. This completes Increment G.

## §29 — Remove duplicate "Live pipeline" card from Overview (2026-08-28)

**Change:** the Overview page carried a **"Live pipeline"** card rendering `PipelineGraph`, duplicating the Pipeline page's **"Event flow"** graph. Removed the single Overview `<Card title="Live pipeline">…</Card>` block from the `route === "overview"` branch in `frontend/src/App.tsx` (the one graph that sat between "Key metrics" and `<Throughput/>`).

**Deliberately retained:** the shared `pipeNode` / `setPipeNode` selection state stays — it is still consumed by the Overview `SystemHealthStrip` (`selected`/`onSelect`) and the right-rail inspector card, so it is **not** dead after the removal. `PipelineGraph` import stays (Pipeline page still uses it). All other Overview sections unchanged. The Pipeline page "Event flow" section and `PipelineGraph.tsx` are untouched. No backend/API/WS/Kafka/Redis/auth/routing/data changes.

**Test update:** `frontend/src/App.test.tsx` default-Overview test dropped its "Live pipeline" + `.pipe-topo` ("Kafka"/"Persistence Worker") assertions (those elements no longer render on Overview); it now checks Key metrics + Event throughput + Latest events. The Pipeline-page test ("Event flow" / "Analytics Worker") is unchanged.

**Verification:** `vitest run` → 71 passed (9 files), exit 0. `tsc --noEmit` → exit 0. `npm run build` (`tsc && vite build`) → clean, 83 modules, exit 0.


## §30 — Traffic Lab: use your own API key instead of the shared Demo key (2026-08-28)

**Goal:** let a signed-in user drive simulator traffic under one of *their own* ingest keys so generated events land in their workspace, while keeping the Demo shared-key path as the default fallback. Frontend-only wiring plus tests — no change to the backend tenant-isolation architecture or the Demo Store.

**Design constraint that shaped the UI:** `GET /api/v1/api-keys` returns only `key_prefix` (the reveal-once model — the raw secret is shown exactly once at creation and never re-fetched). So the browser cannot recover a saved key's secret. The control is therefore a **selector + paste field**: a dropdown of the user's non-revoked keys (loaded from the existing endpoint) plus a password input for the full secret. Because the create endpoint derives `key_prefix = raw[:12]`, the raw key always starts with its prefix, which lets the client validate the pasted secret (`trimmedSecret.startsWith(key_prefix)`) before sending. The "Demo environment" option sends **no** `X-API-Key` (open-mode → Demo org), preserving existing behavior byte-for-byte.

**Files:**
- `frontend/src/lib/simulator.ts` — `sendOne(config, apiKey?)` and `start({…, apiKey?})` now attach `X-API-Key` only when a non-empty key is passed; no key → header omitted (Demo path).
- `frontend/src/components/EventSimulator.tsx` — loads non-revoked keys on mount (non-fatal on failure; Demo stays available), adds the selector + conditional secret field with prefix-mismatch feedback, gates Send/Start on `keyReady`, and passes `activeApiKey` through. `.sim-hint` styling added to `styles.css`.
- `frontend/src/components/EventSimulator.test.tsx` — mockFetch made URL-aware (the api-keys GET goes through the shared apiClient, which reads `res.text()`), assertions switched from `calls[0]` to a `find` on the `/events` call. Added tests: keys load (revoked filtered out), selecting a key sends it as `X-API-Key`, prefix-mismatch gates traffic, Demo default sends no key.
- `tests/test_increment_c_isolation.py` — added `test_simulator_user_key_attributes_events_to_that_org` (user key → caller's own non-Demo org, invisible to a peer tenant) and `test_simulator_demo_fallback_maps_to_demo_org` (no key → Demo org). Also added `reset_rate_limits()` to the `database` fixture: these integration tests all sign up fresh tenants from one client IP, so the per-process auth limiter (10/60s) accumulated across cases and tripped a 429 in `test_failures_are_scoped_to_tenant` when the file grew — resetting per test isolates them.

**Verification:** frontend `vitest run` → 75 passed (9 files), exit 0. `tsc --noEmit` → exit 0. `npm run build` → clean, 83 modules, exit 0. Full backend `pytest tests` → 209 passed, exit 0 (2:03).


## §31 — Traffic Lab "zero activity" bug: two root causes (2026-08-28)

**Symptom:** with an own key selected and pasted, clicking Send/Start left EVENTS ATTEMPTED = 0 with no error — i.e. the HTTP layer was never reached.

**Root cause 1 (the reported symptom) — `crypto.randomUUID()` in an insecure context.** `generateEvent()` built `event_id`/`request_id` with `crypto.randomUUID()`, which is defined **only in a secure context** (HTTPS or `http://localhost`). Opened over plain HTTP on a non-localhost origin (a Docker host's LAN IP), `crypto.randomUUID` is `undefined` and the call throws. That line sat in `sendOne()` *before* the `try`, so the throw rejected the async promise; the button handler wraps the call in `void`, so the rejection was swallowed — `record()` never ran, counters stayed 0, no `sim-error`. Tests passed because Node/jsdom always exposes `randomUUID`. **Fix:** `safeUUID()` in `eventFactory.ts` — uses `crypto.randomUUID` when present, else derives a v4 UUID from `crypto.getRandomValues` (available in insecure contexts), else a `Math.random` last resort. Also moved `generateEvent()` **inside** `sendOne`'s try so any future generation error is counted as a failure with a visible reason instead of vanishing.

**Root cause 2 (why attribution would still be wrong) — nginx clobbered the browser's `X-API-Key`.** `frontend/nginx.conf.template` did `proxy_set_header X-API-Key "${DEMO_API_KEY}"` unconditionally on `/api/`, overwriting any browser-supplied key with the injected demo key. Proven live: the same event posted with a real user key returned org `035ce095…` (the user's org) when sent **direct** to the API (`:8001`), but org `00000000-…-01` (Demo) when sent **through nginx** (`:3000`). So even after fix 1, own-key traffic would be misattributed to Demo. **Fix:** an http-context `map $http_x_api_key $effective_api_key { "" "${DEMO_API_KEY}"; default $http_x_api_key; }` and `proxy_set_header X-API-Key $effective_api_key;` — preserve a browser key, inject the demo key only when none was sent, and (empty `DEMO_API_KEY`) still drop the header for auth-off mode. Only `${DEMO_API_KEY}` is envsubst-substituted; `$http_x_api_key` is a runtime nginx var.

**Deployment note:** the dashboard is a static bundle baked into the nginx image (`build: ./frontend`, `dist/` copied in) — a running container serves the bundle from its last image build, so **both** fixes require `docker compose build frontend && docker compose up -d frontend`. Confirmed the rebuilt bundle contains the fallback (`getRandomValues` present in served JS).

**Not changed:** backend ingestion auth (`require_ingest_api_key` already honored `X-API-Key` correctly), tenant isolation, Kafka, Redis, Demo Store. The simulator still uses plain `fetch` (correct — ingestion is header-auth, not cookie+CSRF, so `apiClient` is inappropriate here).

**Verification (live stack + suites):**
- Through nginx with the user's key → event attributed to the **user's org**; user's scoped `/events` read returns it (2 rows, Demo events absent → isolation intact).
- Through nginx with no key (Demo option) → **Demo org** (fallback preserved).
- Regression test added (`EventSimulator.test.tsx`): with `crypto.randomUUID` removed, Send 1 event still yields attempted=1 / successful=1 and a valid v4 `event_id`.
- `vitest run` → 76 passed (9 files), exit 0. `tsc --noEmit` → exit 0. `npm run build` → clean, 83 modules, exit 0.

## §32 — Overview/analytics stuck at zero: stale worker process, not a code bug (2026-08-28)

**Symptom:** events ingest fine (POST 201), appear on the Events page, persist to Postgres — but the Overview dashboard stays at Total/Processed/Producers = 0 for a real (non-Demo) tenant, while the WebSocket shows "Connected". Pipeline/analytics tiles all zero.

**Diagnosis method (read-only, live stack first):** traced the analytics path end-to-end and pinned the exact point where data disappears.
- Kafka: `analytics-workers` group healthy, all 6 partitions assigned, **lag 0** — worker IS consuming (rules out "not consuming").
- Kafka message bytes carry the **correct** `organization_id` (`ed5ad70a…`, a real tenant) — serialization/publish are fine.
- Redis: **zero** `pulsestream:org:*` keys; **1205** events all in the legacy/Demo keyspace (`pulsestream:analytics:total`). So every tenant's events were being recorded under the un-namespaced Demo keyspace.
- The dashboard reads `get_metrics(org=<real session org>)` → the isolated `org:{id}:analytics:*` namespace, which was empty → **0**. (WS auth/connection was never the problem.)

**Root cause (category C symptom / category G cause): the analytics-worker was running STALE in-memory code.** Timeline (UTC): `serialization.py` changed 00:35, `analytics_service.py` (tenant namespacing / `_org_segment`) changed 00:36 — but the analytics-worker **process started 23:59:17**, ~36 min *before* those edits. Code is volume-mounted and the worker runs plain `python -m worker.analytics_worker` (no `--reload`/watch), so Python loaded the pre-namespacing module once at 23:59 and never reloaded. It therefore wrote every event to the legacy keyspace for ~8h. The `api` (restarted 01:49) and `persistence-worker` (restarted 06:57) had been restarted *after* the edit, which is why ingestion/persistence attributed orgs correctly while analytics did not — a classic "who got restarted" skew.

**Proof it was stale in-memory code, not the source:** a *fresh* Python process inside the SAME running container (`docker compose exec analytics-worker python -c …`) ran `deserialize_event` + `_org_segment` + `record_event` on a real-shaped message and correctly produced `org:{id}:analytics:*` with a non-zero `get_metrics(org)`. Same container, same disk code, correct result — the only difference from the long-lived worker was a fresh import.

**Fix (smallest, no source change): `docker compose restart analytics-worker`.** The on-disk code is already correct; the worker only needed to reload it.

**Verification with fresh traffic (new throwaway tenant `bfcb8e63…`, 12 events via API key through the real ingest path):**
- Worker (its own Kafka→Redis path) created `pulsestream:org:bfcb8e63…:analytics:*`; `analytics:total = 12`.
- `GET /api/v1/analytics` (session-scoped) → total 12, by_type `{order.created:12}`, by_source `{diag-store:12}`, producers 1, latency ≈1.08 ms.
- WebSocket (session cookie) initial snapshot AND periodic broadcast frames → total 12.
- Tenant isolation intact: unrelated org → 0; Demo/legacy keyspace (1205) untouched.
- Suites: backend `pytest` 209 passed; `vitest run` 76 passed; `tsc --noEmit` exit 0; `npm run build` clean.

**Recurrence guard (process, not code):** this dev stack has **no auto-reload** for `api` or the workers (volume-mounted code, plain run commands). Any change to worker or shared (`app/…`) code requires `docker compose restart <service>` (or `up -d --build`) to take effect. Optional hardening (NOT done — out of scope): run workers under `watchmedo auto-restart …` / uvicorn `--reload` in dev so code edits reload automatically. Left to the user's discretion.



## §33 — Landing page rebuilt as a marketing surface (2026-08-28)

**What changed and why:** the public `landing` route was a split-screen "Sign in"-style page. It is now a full marketing page (nav, hero + product preview, trust strip, how-it-works, features, developer/integration section, final CTA, footer). Scope was deliberately limited to the landing surface: `LandingPage.tsx`, the landing block of `styles.css`, two additive icons, and `landing.test.tsx`. No backend, auth, router, or dashboard page was touched.

**Constraint that shaped the implementation — the app uses a HASH router.** `parseHash()` reads `window.location.hash` and falls back to route `overview` for anything unknown, so a marketing anchor (`href="#ls-features"`) would be read as a route change and bounce an unauthenticated visitor to `login`. The old page had exactly that latent bug. Every in-page link is therefore a `<button>` calling `element.scrollIntoView()`, and a regression test asserts the hash is still `#/landing` after clicking two nav items.

**No animation library.** The brief mentioned Framer Motion; `package.json` has only `react`/`react-dom`. Rather than add a dependency for decoration, reveals use one small `IntersectionObserver` component plus CSS transitions, and `prefers-reduced-motion` renders everything in its final state. `IntersectionObserver`, `matchMedia` and `scrollIntoView` are all absent in jsdom, so each is feature-detected — content renders visible when they are missing, i.e. the animation is never a gate on the content.

**Honesty over the reference design.** The reference mock showed invented KPIs (1,248 / 74.9K / 98.6% / 153 ms). Per the project honesty rule the preview instead reads the real public metrics snapshot and prints an em dash for anything not reported; the throughput sparkline is deliberately unlabelled (shape only, no axis values); flow nodes carry status words, not counts. No customer logos, testimonials or statistics were fabricated.

**Diagram correctness:** both the in-preview flow and the developer-section architecture diagram show the real topology — one ingest API, one Kafka topic, then a fork into two independent consumer groups whose lanes never rejoin (`persistence-workers → PostgreSQL`, `analytics-workers → Redis → WebSocket → Dashboard`).

**Destinations, and one honest compromise:** "Get started free" → `signup`, "Sign in" → `login`. There is **no docs or pricing route** in this app (the integration guide is the auth-gated `integrations` dashboard route), so "View documentation" / "Docs" / "Integrations" scroll to the on-page developer section instead of inventing a broken route, and "Pricing" scrolls to the free-to-start final CTA. Footer Legal entries render as plain text, not links, because no legal pages exist.

**Verification:** `vitest run` 78 passed (9 files, 2 new landing tests); `tsc --noEmit` exit 0; `npm run build` clean (83 modules). `button.brand` was kept when the old `.lp-*` block was removed — it styles the dashboard sidebar brand, not the landing page.


## §34 — Auth navigation: landing is now the way out of both login and logout (2026-08-28)

**Problem:** once §33 made `landing` a real marketing page, the auth flow had two dead ends. Reaching `#/login` from the landing hero left no way back (the login page has no nav), and signing out sent the user to `#/login` — i.e. straight back into an auth form instead of the public site.

**Fix (4 files, no new routing logic):**
- `AuthLayout` gained one optional `back?: ReactNode` slot rendered above the card heading. Only `LoginPage` passes it; signup / forgot-password / reset-password are unchanged, so the shell stays uncluttered.
- The control is a `<button>` calling the existing `navigateTo("landing")`. **Deliberately not `history.back()`**: `#/login` is frequently the first entry in the history stack (bookmark, deep link, or the post-logout redirect), where `back()` either does nothing or leaves the app. Explicit route navigation always works and matches how every other imperative jump in the app is done.
- `LogoutPage` now calls `navigateTo("landing")` after `logout()`. Nothing about session teardown changed: `AuthContext.logout()` still POSTs `/api/v1/auth/logout` with the `ps_csrf`-derived CSRF header and then clears user/status. Only the destination after that moved.

**Guard behaviour is untouched and still correct.** `AUTH_REDIRECT_ROUTES` (login/signup/forgot/reset) bounces an *authenticated* user to `overview`; `isDashboardRoute()` bounces an *unauthenticated* one to `login`; `landing` is in `PUBLIC_ROUTES` and in neither guard, so it renders for both. `logout` stays out of `AUTH_REDIRECT_ROUTES` because it is an action route — if it were listed, an authenticated user hitting `#/logout` would be redirected to `overview` before the revoke ran.

**Tests (81 passing, +3):** the login page renders the back control and still exposes the email field / forgot-password / create-account links; clicking it lands on `#/landing` with the marketing hero rendered; the logout test now asserts the landing page (keeping its CSRF-header assertion); and a new test signs out and then re-requests `#/overview` to prove the protected-route guard still redirects to `#/login` — the new exit path must not be mistaken for a weakened session.

**Verification:** `vitest run` 81 passed (9 files); `tsc --noEmit` exit 0; `npm run build` clean (83 modules, CSS 67.16 kB, JS 278.66 kB).


---

## 35. README rebuilt as a visual, animated landing page (2026-08-28)

**Ask:** replace the text-heavy `README.md` with something modelled on the OmniRoute README — visual first, animated, and carrying the actual dashboard screenshots.

**What OmniRoute actually does** (read before writing anything): a centred `<div align="center">` hero, a typing-SVG tagline, a wall of shields.io `for-the-badge` badges, an HTML nav table linking to emoji-slug anchors, screenshots in fixed-width HTML tables with `<sub>` captions, and long prose folded into `<details>` blocks. The trick is not more content — it is *less* prose per screenful, with structure doing the explaining.

**Animation without JavaScript.** GitHub strips `<script>` from Markdown, so nothing interactive survives. Two mechanisms remain:
1. **Self-hosted animated SVGs** — CSS `@keyframes` inside the `<svg>` element still animate when the file is referenced as an image on the raw CDN. `docs/assets/hero.svg` (drifting radial glows, an ECG-style pulse trace revealed with `stroke-dashoffset`, staggered text fade-ins), `docs/assets/pipeline.svg` (dashed links that flow, per-card entrance stagger, pulsing status dots), `docs/assets/divider.svg` (a sweeping gradient rule).
2. **`readme-typing-svg.demolab.com`** for the animated four-line tagline — the one external dependency, chosen because it degrades to a static line if the service is unreachable.

Every animated SVG carries a `@media (prefers-reduced-motion: reduce)` block that freezes the animation and forces the final visual state. Motion is decoration here, so it must be droppable.

**SVG lessons.** Text inside SVG does not wrap or reflow: labels have to be hand-fitted. Two problems found by measuring rather than eyeballing — the hero's pulse trace was drawn through the topology strip's text baseline (fixed by rebuilding the path in absolute coordinates around `y=250`, and raising `stroke-dasharray` 1700 → 2400 so the longer path still reveals fully), and six `pipeline.svg` sub-labels overflowed their 140 px cards (`ON CONFLICT DO NOTHING` → `idempotent insert`, `counters · per-tenant keys` → `per-tenant counters`, and so on). Each diagram also gets a long descriptive `aria-label`, because the diagram *is* the architecture explanation for anyone reading it.

**Honesty compromises.** OmniRoute leans on headline statistics; PulseStream cannot, because most of ours were never measured. The "Measured, not claimed" section quotes only the figures the load-test run actually produced (batch ≈ 4.8K events/s at p95 1.5 s, ≈ 7K saturated, single-event ≈ 50/s, persistence drain ≈ 370/s), keeps the machine-specific caveat, and links `docs/load-testing.md`. The Tests section lists commands and no counts — the backend suite run for this pass never completed, and a plausible-looking number would have been invented. No uptime claim, no fabricated logos.

**Assets added:** `docs/assets/{hero,pipeline,divider}.svg` and `docs/screenshots/{landing,overview,events,sources,pipeline,simulator}.png`. `README.md` went 176 → 396 lines, but most of that is structure (tables, `<details>`, image markup) rather than prose to read.
