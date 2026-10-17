# Event Simulator

A small demonstration/client-testing layer built into the dashboard UI. It
generates realistic application events through PulseStream's **existing public
API** so the full pipeline can be exercised during a demo without hand-writing
HTTP requests.

## Why it exists

- portfolio demonstration: show real events flowing end-to-end in seconds
- real-world testing of the complete event lifecycle
- light load/throughput experimentation (well below Phase 7 benchmark levels)

## What it is NOT

- It does NOT represent production traffic patterns or volumes.
- Its counters (attempted / successful / failed / current rate) describe
  **simulator activity only** — they are not analytics and never feed the
  dashboard metrics.
- It adds no backend surface: it only calls `POST /api/v1/events`, exactly like
  any external producer. It never writes to PostgreSQL, Redis, or Kafka directly.

## How to start it

```powershell
docker compose up -d          # full stack
# dashboard at http://localhost:3000 → sidebar → "Simulator"
```

No extra services, commands, or configuration — it ships inside the frontend.

## Running a demo

1. Open the dashboard, click **Simulator** in the sidebar.
2. Pick an event type (or *Random*), keep source `demo-store`.
3. Click **Send 1 event** — watch Recent Events, Overview counters and the WS
   throughput chart react within ~1–2 seconds.
4. Set rate to `10` events/sec, duration to `30` seconds, click **Start traffic**.
5. Watch Overview / Throughput / Types / Sources update live; click **Stop** any
   time for a clean stop (in-flight requests settle and are counted).

## Safe traffic limits (enforced in both UI and engine)

| Limit | Value | Rationale |
|---|---|---|
| Max rate | 50 events/sec | far below measured single-host ingest capacity; keeps persistence backlog bounded |
| Max duration | 300 s per run | bounded demos |
| Max total | 5,000 events per run | absolute cap, also bounds continuous mode |

Continuous mode ("empty duration") runs until **Stop** is pressed but still
stops automatically at the 5,000-event cap. Stop is always clean: scheduled
future sends are dropped, already-sent requests are counted.

## Implementation notes

- Frontend-only (`frontend/src/lib/eventFactory.js`, `simulator.js`,
  `components/EventSimulator.jsx`). No new dependencies; charts/design system
  unchanged.
- Generated payloads follow the exact `EventIn` contract: UUIDv4 `event_id`,
  lowercase dotted `event_type` (validated by `^[a-z][a-z0-9_.]*$` server-side),
  non-blank source, RFC-3339 UTC timestamp, generated `user_id`,
  `schema_version: 1`, realistic payload shapes per event type.
