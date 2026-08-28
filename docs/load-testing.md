# Load Testing & Benchmarks (Phase 7)

All numbers below are **measurements actually taken** on the recorded date and
machine. They are not extrapolations. Re-running on different hardware will
produce different absolute numbers; the ratios and bottleneck conclusions are
the durable part.

## Methodology

- **Generator:** `load-tests/loadgen.py` — open-loop paced HTTP client
  (httpx/asyncio). Requests are scheduled on a fixed time grid independent of
  response time, so measured latency reflects server queueing rather than
  client coordination. A fixed worker pool bounds in-flight requests.
- **Latency** is client-side per request (send → complete response).
  Percentiles are linear-interpolated over completed requests.
- **Throughput** is completion-based (`ok_events / wall_time` including any
  queueing tail) — deliberately conservative. `offered_requests_per_sec` is
  also recorded so a saturated run is visible as tail growth
  (`completion_tail_seconds`) rather than hidden.
- Each step runs an unmeasured warmup window first.
- **Consumer lag during load** is sampled from `/api/v1/metrics`
  (`pulsestream_consumer_lag{group,partition}`), which is refreshed at scrape
  time from the workers' Redis heartbeats (broker highwatermark − consumer
  position, refreshed every ~10 s). Post-run drain rates are additionally
  verified against `kafka-consumer-groups.sh --describe` offset deltas.
- **Resources:** mid-load `docker stats --no-stream` snapshots every ~6 s;
  peak CPU per container is reported.
- **PostgreSQL:** row-count delta + relation size via direct `asyncpg` query.
  Note: because the API commits each ingested event synchronously, `events`
  row counts track *ingestion*, not persistence-worker progress — worker
  progress must be read from Kafka offsets.

## Environment (run of record: 2026-08-25)

| Aspect | Value |
|---|---|
| Host | Windows 11, 12th Gen Intel i5-12500H (P-core laptop-class), 15.7 GB RAM |
| Container runtime | Docker Desktop (WSL2 backend) |
| Stack | compose: postgres 16, kafka 3.9 (KRaft), redis 7, api, frontend, 2 workers |
| API process | single uvicorn process (`uvicorn app.main:app`, no `--workers`) |
| Workers | one container per group (`persistence-workers`, `analytics-workers`), one event at a time |
| Kafka topic | `application-events`, 6 partitions, RF 1 |

## Ladder results

Target = offered events/s; achieved = acknowledged events/s incl. tail;
err% = non-2xx share; lag = max persistence-workers lag observed during load.

| Step | Target | Achieved ev/s | p50 ms | p95 ms | p99 ms | err% | Max persist lag |
|---|---:|---:|---:|---:|---:|---:|---:|
| single_100 | 100 | 49 | 150 | 1,214 | 2,501 | 0 | 0 |
| single_1000 | 1,000 | 33 | 2,714 | 10,098 | 14,038 | 0 | 0 |
| batch100_1000 | 1,000 | 1,002 | 73 | 119 | 146 | 0 | 1,373 |
| batch100_5000 | 5,000 | 4,809 | 291 | 1,530 | 1,748 | 0 | 16,341 |
| batch500_10000 | 10,000 | 7,016 | 4,432 | 4,797 | 4,854 | 0 | 50,239 |

Post-run drain (offset-based, idle system): persistence-workers ≈ **368 ev/s**
sustained; analytics-workers fully caught up (Redis pipelines ≫ per-event PG
commits). After the ladder the persistence backlog was ≈163K events
(≈7 min to drain at that rate). DB after run: 327,771 rows / 119 MB.

## Bottleneck analysis

1. **Single-event ingest saturates ≈50 ev/s.** Server-side average latency for
   `POST /events` was **50.6 ms** (Prometheus histogram: 241.1 s / 4,766 req),
   while client-side p50 was ≈150 ms — roughly two thirds of the perceived
   latency is Docker Desktop port-forwarding overhead, one third is real work:
   one PG transaction commit + one `acks="all"` Kafka round trip per request.
   With bounded concurrency this latency directly caps throughput.
2. **Offering 1,000 ev/s single-mode collapses latency, not correctness.**
   The queue grows until p99 hits 14 s while error rate stays 0% — saturation
   shows up as latency and tail growth, which is exactly what open-loop
   measurement is designed to reveal.
3. **Batch ingestion amortizes the expensive parts.** One PG commit per batch
   plus JSON parse amortized across N events yields 1,000 ev/s at p99 146 ms.
   At 5K offered, ingest still achieves 4.8K with p95 1.5 s.
4. **At 10K offered, the API itself is the ceiling (~7K achieved).** Per-batch
   server cost averages ≈1.22 s (`POST /events/batch`: 2,088 s / 1,711 req),
   dominated by the *sequential* per-event Kafka publish loop in
   `routes_events.py` (one broker round trip per event, `acks="all"`).
5. **Persistence worker is the end-to-end catch-up bottleneck (~368 ev/s).**
   It commits one PG transaction per event by design (idempotent,
   at-least-once-safe). Bursts therefore convert into durable backlog that
   drains over minutes; no data is lost or duplicated (ON CONFLICT DO NOTHING
   verified by duplicate tests), but real-time dashboards trail ingest during
   bursts. The analytics worker (Redis pipeline per event) keeps up easily.

## Recommendations (future work, not implemented in Phase 7)

- Batch consumer commits: accumulate N messages → one transaction → one commit
  (raises persistence drain rate by orders of magnitude; changes commit
  granularity semantics, needs its own design pass).
- Parallelize or producer-batch the publish loop in batch ingestion
  (`aiokafka` batches internally if we drop `send_and_wait` per event).
- Size the SQLAlchemy pool explicitly instead of defaults (5+10 overflow).
- Run uvicorn with >1 worker on multi-core hosts.
- Linux/native deployment removes most of the measured proxy overhead.

## Reproduce

```powershell
docker compose up -d                      # full stack healthy
docker compose restart api persistence-worker analytics-worker   # pick up code
.\.venv\Scripts\python.exe load-tests\loadgen.py --url http://localhost:8001 `
    --mode batch --rate 5000 --duration 20 --batch-size 100 --concurrency 64
.\.venv\Scripts\python.exe load-tests\benchmark.py            # full ladder
.\.venv\Scripts\python.exe load-tests\benchmark.py --quick    # short ladder
```

Raw per-step JSON is written to `load-tests/results/`.
