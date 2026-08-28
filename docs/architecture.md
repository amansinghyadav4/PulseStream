# PulseStream — Architecture (as implemented)

This document describes the system **as it is actually built** (Phases 1–8),
not the aspirational target from the original spec. Where reality differs from
the spec's sketch, this document wins.

## Topology (docker compose)

```text
   producers / browsers
          │  HTTP POST /api/v1/events        wss://…/api/v1/ws
          ▼                                        │
 ┌─────────────────────┐   nginx SPA+proxy   ┌──────┴────────┐
 │      frontend       │────────────────────▶│  React build  │
 └─────────────────────┘                     └───────────────┘
          │ api:8000
          ▼
 ┌──────────────────────────────────────────────────────────┐
 │                       FastAPI api                        │
 │ validate (Pydantic) → PG commit → Kafka publish → 201    │
 │ /health /ready /metrics /analytics /ws  + WS broadcaster │
 └───────┬─────────────┬───────────────┬────────────────────┘
         │             │               │
         ▼             ▼               ▼
 ┌──────────────┐  ┌───────────┐  ┌─────────────┐
 │ PostgreSQL   │  │   Kafka   │  │    Redis    │
 │ events table │  │ application-events (6p)│  counters, seen:{id},
 │ source of    │  │ dead-letter-events (DLQ)│ per-minute buckets,
 │ truth        │  └─────┬─────┘  │ worker heartbeats (+lag)
 └──────▲───────┘        │        └──────▲──────────────┘
        │                │ two independent consumer groups
        │        ┌───────┴────────┐      │
        │        ▼                ▼      │
        │  persistence-workers   analytics-workers
        │  idempotent INSERT     Redis pipelines (INCR/HINCRBY,
        │  ON CONFLICT DO NOTHING; SET seen NX first)
        │        │                │
        └────────┘                └── heartbeat {ts,group,lag} every 10s
                                       → read by /ready and /metrics gauges
```

## Component inventory

| Component | What it does | In | Out | If it fails |
|---|---|---|---|---|
| **FastAPI api** (`app/main.py`) | validates, commits to PG, publishes to Kafka, serves health/ready/metrics/analytics/ws | HTTP events, queries | 201 + rows in PG + messages on `application-events` | process restarts (`restart: unless-stopped`); PG down → `/ready` 503; Kafka/Redis down → soft-degrade, ingest still 201 |
| **PostgreSQL 16** | durable event store, unique `event_id` constraint = idempotency anchor | inserts/queries via SQLAlchemy 2 async | rows | only hard readiness gate; workers redeliver after recovery |
| **Kafka 3.9 (KRaft)** | buffers bursts, decouples ingest from processing, fan-out to groups | produced events | consumed by 2 groups; poison → DLQ | publish bounded ≤5s cap with producer re-bootstrap; consumers resume at committed offsets |
| **persistence-workers group** | idempotent persist (`INSERT … ON CONFLICT DO NOTHING`), manual commit per event | Kafka stream | PG rows | no commit on failure → redelivery (at-least-once); drains ~368 ev/s idle (measured) |
| **analytics-workers group** | low-latency counters: `SET seen:{id} NX` then pipeline INCR/HINCRBY | Kafka stream | Redis keys | falls back to in-memory counters if Redis down |
| **Redis 7** | counters, 24h `seen:{id}` idempotency, per-minute buckets (TTL 120s), worker heartbeats | commands from api/analytics-worker | metrics state | never blocks ingestion; analytics degrades honestly |
| **WS broadcaster** (`app/services/broadcaster.py`) | ~1s loop: reads analytics state, broadcasts `{type:"metrics"}` to dashboards | Redis/get_metrics | WS frames | broken sockets removed without affecting others |
| **DLQ path** (`retry.py`, `dlq.py`) | bounded retry (3×, 100ms→1.6s) for transient; permanent/malformed → `dead-letter-events`; terminal commit | failing messages | DLQ envelope `{original,error}` | DLQ send failure → no commit → redelivery |

## End-to-end flow of one event

```text
POST /api/v1/events {event_id?, type, source, ts, user_id?, payload}
 1 Pydantic validation; server fills missing event_id/timestamp, normalizes tz→UTC
 2 body-size middleware rejects >1 MiB with 413 before handler
 3 PG INSERT (unique event_id) — duplicate → 409 duplicate_event envelope
 4 Kafka produce key=user_id→source→event_id, acks=all, ≤5s bound (non-fatal)
 5 HTTP 201 (DB is the contract; Kafka outage never fails the client)
 6 both consumer groups receive the message independently
 7 persistence: ON CONFLICT DO NOTHING insert → commit offset
   analytics: seen:{id} NX gate → counter pipeline → commit offset
 8 transient handler error → retry ×3 → DLQ; malformed → DLQ directly;
   offset commits only after terminal success
 9 broadcaster pushes updated metrics to dashboards ~1s later
```

## Key behavioral guarantees

- **At-least-once**, not exactly-once: duplicates are absorbed by the PG unique
  constraint (persistence) and the Redis `seen` gate (analytics). Verified by
  live kill/redelivery test (`tests/test_failure_matrix_integration.py`).
- **Graceful degradation ladder**: Redis down → in-memory fallback; Kafka down →
  DB-only ingest; PG down → hard 503. `/ready` reports each dependency's real
  status; nothing invents "healthy".
- **Observability**: structured JSON logs (ids only, never payloads),
  Prometheus metrics incl. real per-partition consumer lag sampled from worker
  heartbeats every 10s.
- **Production posture**: multi-stage non-root image, fail-fast settings gate
  when `APP_ENV=production`, required-var compose, deployment runbook in
  `infra/aws/README.md`.

## Measured performance (single host, run of record)

See `docs/load-testing.md` for methodology. Headlines: batch ingest 4.8K ev/s
@ p95 1.5s, ~7K ev/s saturated; single-event ingest ~50 ev/s (per-request
commit-bound); persistence drain ~368 ev/s (the burst-backlog bottleneck).

## Deliberate non-features

Authentication, rate limiting, TLS termination, Alembic migrations, HA/multi-node
— each documented as deferred with reasons (spec scope discipline), not forgotten.
