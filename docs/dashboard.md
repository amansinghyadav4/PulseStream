# PulseStream — Dashboard Metrics Traceability (Phase 5)

Every displayed metric traces: SOURCE → BACKEND CALCULATION → TRANSPORT → FRONTEND DISPLAY.
No metric is displayed without a real backend source. Unavailable metrics render as "Unavailable".

## Implemented metrics

| Metric | Source | Backend calculation | Transport | Frontend |
|---|---|---|---|---|
| `total` / `events_processed_total` | Redis key `pulsestream:analytics:total` (`INCR` in `record_event`, idempotent via `seen:{event_id}`) | `get_metrics()` `app/services/analytics_service.py` reads `GET total_key` (fallback: in-memory `_total`) | WS `{"type":"metrics"}` + REST `/api/v1/analytics` | Overview, Failure rate denominator |
| `events_failed_total` | Redis key `pulsestream:analytics:failed` — incremented **only** at terminal DLQ handling (`app/kafka/retry.py` after successful `dlq.send`; malformed path in `app/kafka/consumer.py`) | `GET failed_key` | WS + REST | Failure rate numerator |
| `events_by_type` | Redis hash `pulsestream:analytics:by_type` (`HINCRBY field event_type`) | `HGETALL` → `{k:int}` | WS + REST | Event types list |
| `events_by_source` | Redis hash `pulsestream:analytics:by_source` (`HINCRBY field source`) | `HGETALL` | WS + REST | Event sources list |
| `active_producers` | Derived from `events_by_source` keys (distinct observed sources) | `len(events_by_source)` | WS + REST | Overview (defensible: count of distinct sources actually observed) |
| `events_per_minute` | Redis key `pulsestream:analytics:per_minute:{YYYY-MM-DDTHH:MM}` (`INCR`+`EXPIRE 120`, bucketed by event timestamp) | `GET current-minute bucket` | WS + REST | Event throughput |
| `events_per_second` | Same minute bucket | `round(per_minute/60, 2)` — honest approximation, per-second granularity not measured; documented as derived | WS + REST | Event throughput |
| `processing_latency_avg_ms` | Redis `pulsestream:analytics:latency:sum` + `latency:count` (`INCRBYFLOAT`/`INCR` per unique event, same atomic pipeline as the counters) | avg = `sum/count`; sample per event = **server-side monotonic duration of processing that event in the analytics worker** (handler entry → dedup gate → counter pipeline). Client-supplied `event.timestamp` is NOT used (an old client timestamp previously produced astronomically large values). Samples exist only for events passing the `seen:{event_id}` gate, so duplicate deliveries never skew the average. NOT end-to-end pipeline latency (API ingest and Kafka queue time are not included — API request latency is separately available as the Prometheus histogram `pulsestream_http_request_latency_seconds`) | WS + REST | Processing latency ("Unavailable" until first counted event) |
| `active_producers` | Derived from `events_by_source` keys (distinct observed sources) | `len(events_by_source)` | WS + REST | Overview (defensible: count of distinct sources actually observed) |
| Recent events | PostgreSQL `events` table (source of truth) | `SELECT … ORDER BY created_at DESC LIMIT/OFFSET` (`app/api/routes_events.py:list_recent_events`, `created_at` indexed) | REST polling every 2s (`RecentEvents.jsx`) | Recent events list |

## Explicitly unavailable (not fabricated)

| Metric | Why unavailable | Display |
|---|---|---|
| Exact per-second throughput | Underlying data is minute-bucket only; per-second would be fabrication beyond `per_minute/60`. | Shown as approximation label |
| End-to-end processing latency | Would require correlated server-side timestamps at every stage (API receive → publish → consume → persist). The current metric covers only the analytics-worker stage, measured precisely; extending to true end-to-end needs an architecture change (e.g. stage timestamps carried in the message envelope), which has been deliberately not faked. | Analytics-worker average only |

## Consumer lag (Phase 7 — now real, with freshness caveat)

`consumer_lag` is the sum of per-partition lag across both worker groups,
sampled from the workers' Redis heartbeat payloads (`app/services/heartbeat.py`,
written every 10s; each worker computes broker highwatermark − consumer
position for its current assignment via `KafkaEventConsumer.lag_snapshot()`).
When no fresh heartbeat carries a snapshot (Redis down, workers never assigned)
it is honestly `null`. Caveat: the value can be up to ~10s stale between
heartbeats. The same values are exported as Prometheus gauges
`pulsestream_consumer_lag{group,partition}` on `/metrics`.

## Failed-event visibility (`GET /api/v1/failures`)

Terminal failures are audited in the PostgreSQL `event_failures` table,
written **only after** terminal DLQ handling succeeded (message on
`dead-letter-events`, offset committed) — so the audit never changes retry/DLQ
semantics. Per record: event_id/type/source/user_id/payload when the message
could be deserialized (all honestly NULL for malformed messages), the error,
handler `attempts` (3 = two retries then DLQ; 1 = permanent error, no retry;
0 = malformed), `final_status` (`dlq_retry_exhausted | dlq_permanent |
dlq_malformed`) and `failed_at`. The dashboard **Failures** page lists these
with a per-row detail drawer; summary chips reuse the existing analytics
counters, so the failure-rate metric meaning is unchanged.

## Broadcast shape

```json
{"type": "metrics", "data": {
  "total": 0,
  "events_processed_total": 0,
  "events_failed_total": 0,
  "events_by_type": {},
  "events_by_source": {},
  "events_per_minute": 0,
  "events_per_second": 0.0,
  "processing_latency_avg_ms": null,
  "active_producers": 0,
  "consumer_lag": 42
}}
```

No event payloads are ever broadcast or logged.
