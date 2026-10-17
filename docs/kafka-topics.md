# PulseStream — Kafka Topics & Partitioning (Phase 2A)

## Canonical topics

| Topic | Purpose | Produced by | Consumed by | Retention (dev) |
|-------|---------|-------------|-------------|-----------------|
| `application-events` | Primary pipeline for all validated application events (ingested via `POST /events` and `/events/batch`). Single source of truth for downstream processing. | `KafkaEventPublisher` (`app/services/kafka_publisher.py:88`) | `persistence-workers` (Phase 2D), `analytics-workers` (Phase 2E) | default (7 days in dev) |
| `dead-letter-events` | Dead-letter queue for poison messages that cannot be processed after retries (permanent validation or processing failures). Workers produce here instead of infinite retry. | Workers (Phase 2G) | Operators / optional DLQ replayer (future) | default |

The legacy name `events.raw` was used in early Phase 1 (`app/core/config.py:19` before 2A) and is **retired**. Configuration `kafka_topic` now defaults to `application-events`; no code references `events.raw` after Phase 2A. Use `KAFKA_TOPIC` / `KAFKA_DLQ_TOPIC` env overrides if a different name is required (e.g., `KAFKA_TOPIC=application-events` in `.env.example:8`).

A small number of meaningful topics is intentional per `PulseStream_PROJECT_SPEC.md:218` — one primary stream plus one DLQ — rather than one topic per `event_type`.

## Partition configuration (development)

| Setting | Value | Where | Purpose |
|---------|-------|-------|---------|
| `KAFKA_NUM_PARTITIONS` | `6` | `docker-compose.yml:38` `KAFKA_NUM_PARTITIONS: 6` | Number of partitions for auto-created topics. 6 allows parallel consumption by up to 6 workers per consumer group while keeping dev overhead low. |
| `KAFKA_DEFAULT_REPLICATION_FACTOR` | `1` | `docker-compose.yml:43` | Replication for auto-created topics in single-node dev cluster. Production would use 3. |
| `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR` | `1` | `docker-compose.yml:32` | Required for single-node KRaft (otherwise broker fails to start). |

Partitions are auto-created on first `send_and_wait` to `application-events` (`KAFKA_AUTO_CREATE_TOPICS_ENABLE="true"`). For explicit control, create via:
```bash
docker exec pulsestream-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create --if-not-exists --topic application-events --partitions 6 --replication-factor 1
docker exec pulsestream-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --describe --topic application-events
```

## Partition-key strategy

**Key:** `user_id → source → event_id` (implemented Phase 2B, documented here for infrastructure phase).

```
if user_id is not None and user_id != "":
    key = user_id
elif source is not None and source != "":
    key = source
else:
    key = event_id   # deterministic final fallback, always present
```

### Why this ordering

1. **`user_id` first — per-user ordering.** Most product analytics and persistence workloads need events for the same user to be processed in order (e.g., `order.created` before `order.paid` for `user_id=u-123`). Kafka guarantees ordering *within a partition*; hashing `user_id` to a partition therefore gives ordering by user without global ordering cost. This drives partition count choice: 6 partitions spreads users, not events, across workers.

2. **`source` fallback — service-centric ordering when `user_id` absent.** Service events (`source=checkout-service`, `payment-service`) have no user; grouping by `source` preserves ordering per producer and avoids random scattering of, say, all `shipment.updated` events across partitions. It also distributes load when many anonymous/system events exist.

3. **`event_id` final fallback — deterministic and unique.** `event_id` is always present (server-generated UUID if omitted per `app/schemas/event.py:49`). Hashing the UUID gives uniform distribution when neither `user_id` nor `source` can be used (should not happen because `source` is required `min_length=1` per `app/schemas/event.py:13`, but retained for defensive completeness).

The publisher sends with `key=partition_key.encode("utf-8")` and `value=<event JSON>` (`app/services/kafka_publisher.py:62`). Consumers in the same group (`analytics-workers`, `persistence-workers` per spec `§6:252`) each receive all partitions independently — horizontal scaling is then `min(num_partitions, num_workers_per_group)`.

### Trade-offs

| Choice | Benefit | Cost |
|--------|---------|------|
| `user_id` ordering | Correct per-user causality; natural sharding for user-centric features | **Hot partition / skew:** a very high-volume single user (or single `source` when `user_id` absent) hashes to one partition, creating a hotspot while other partitions idle. Mitigation: monitor partition lag, consider adding salt or splitting highly active users in future, but not in Phase 2 (keep simple). |
| 6 partitions (dev) | Enough parallelism for `persistence-workers` + `analytics-workers` scale tests; low overhead | Not enough for >6 workers per group; production will need 12–24+ based on load tests §17. Changing partition count after topic creation requires partition reassignment (not automatic). |
| RF=1 (dev) | Works on single broker, no min-ISR failures | No durability if broker dies; production needs RF=3 and `KAFKA_TRANSACTION_STATE_LOG_MIN_ISR` accordingly. |
| Small topic set | Simpler operations, fewer consumer assignments | Per-`event_type` filtering must happen in consumer logic, not via topic selection. Acceptable because spec §6 explicitly prefers few meaningful topics. |

## Idempotency

### Producer vs consumer

- **Producer idempotence** (`enable_idempotence=True`, `acks="all"` `app/services/kafka_publisher.py:33`) prevents duplicate writes on producer retry (broker deduplicates via PID/sequence). It does **not** prevent consumer-side duplicates from at-least-once delivery.
- **Consumer idempotency** is provided by `event_id` uniqueness: `events.event_id` `UNIQUE` `app/models/event.py:15` plus `INSERT ... ON CONFLICT DO NOTHING` `app/services/event_consumer_service.py:42`. Duplicate `application-events` delivery (first insert succeeds, second `rowcount=0`) is treated as successful handling → offset committed `worker/persistence_worker.py:64`, no duplicate row. API path `POST /events` already enforces `409 duplicate_event` `app/api/routes_events.py:22`; worker path must tolerate API-originated rows (same `event_id`).

### At-least-once flow (Phase 2C–2G)

```
Kafka application-events
  ↓
KafkaEventConsumer.handle_raw(raw)  app/kafka/consumer.py:76
  ↓ deserialize_event() app/kafka/serialization.py:38
  ↓ handler(event)  (persistence: persist_event / analytics: record_event)
  ↓ SUCCESS → commit offset  app/kafka/consumer.py:118
  ↓ FAILURE → NOT commit → redelivery (at-least-once)

Transient DB/network failure → retry with bounded backoff (100ms→400ms→1600ms, max 3) app/kafka/retry.py → after exhaustion → DLQ dead-letter-events → commit terminal
Permanent malformed (ValueError, missing field, naive timestamp) → no retry → DLQ directly → commit terminal
Never log payload (only event_id/event_type/source/group_id).
```

Producer `acks="all"` does not make exactly-once; consumer may see duplicates, hence DB constraint is the source of truth.

### Batch UUID fix (Phase 2F)

`app/api/routes_events.py:43` previously called `EventIn.resolved_event_id()` twice (once for duplicate check, once in `event_service.ingest_event_batch` → `_build_event`), generating two different UUIDs for the same `None` event, so the `seen` set did not match persisted IDs. Fixed `app/api/routes_events.py:43` to resolve once per item, store `resolved_ids`, and stabilize `item.event_id = rid` before persistence, so detection and insert use identical IDs.

## Startup / shutdown behavior (Phase 2A)

- Producer lifecycle: `app/main.py:31` `lifespan` calls `await publisher.start()` (lazy `AIOKafkaProducer` creation per `app/services/kafka_publisher.py:31`) and `await publisher.stop()` on shutdown. Start failure is non-fatal — producer set to `None`, ingestion still returns 201 (DB is source of truth per `app/services/kafka_publisher.py:39`).
- If `KAFKA_ENABLED=false` (`.env.example:8`), no producer is created (`app/services/kafka_publisher.py:25`).
- Auto-creation ensures `application-events` and `dead-letter-events` exist on first publish; no blocking topic-creation step in API startup.

## Verification (Phase 2A)

```powershell
docker compose up -d kafka          # broker healthcheck: kafka-broker-api-versions.sh
docker compose ps
docker exec pulsestream-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
docker exec pulsestream-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic application-events
# expect Partitions: 6, ReplicationFactor: 1
```
If Docker unavailable, `pytest` still passes (producer disabled / skipped) — Phase 2A does not require live Kafka for unit tests.

## What is NOT in Phase 2A

Consumers, consumer groups, workers, retry/DLQ processing, analytics aggregation, Redis, WebSockets — all deferred to 2B–2G. This document is infrastructure only.
