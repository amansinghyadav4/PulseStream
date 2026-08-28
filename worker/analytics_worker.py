from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from app.kafka.consumer import KafkaEventConsumer, create_consumer
from app.kafka.dlq import dlq_publisher
from app.services.analytics_service import record_event
from app.services.heartbeat import HEARTBEAT_INTERVAL_S, beat

logger = logging.getLogger(__name__)


class AnalyticsWorker:
    """Consumes application-events with group analytics-workers.

    - topic = application-events
    - group_id = analytics-workers
    - reuses KafkaEventConsumer and deserialize_event (via consumer)
    - in-memory counters via analytics_service (no Redis/DB)
    - one event at a time
    - graceful start/stop, Kafka unavailable backoff, never logs payload
    """

    def __init__(self, consumer: KafkaEventConsumer | None = None, dlq: Any = dlq_publisher) -> None:
        self.consumer = consumer or create_consumer(group_id="analytics-workers")
        self.dlq = dlq
        if self.consumer._topic != "application-events":
            logger.warning(
                "analytics worker topic mismatch, forcing application-events",
                extra={"topic": self.consumer._topic},
            )
            self.consumer._topic = "application-events"  # type: ignore[attr-defined]
        if self.consumer._group_id != "analytics-workers":
            logger.warning(
                "analytics worker group mismatch, forcing analytics-workers",
                extra={"group_id": self.consumer._group_id},
            )
            self.consumer._group_id = "analytics-workers"  # type: ignore[attr-defined]
        # DLQ parity with persistence worker (Phase 6): malformed/permanent failures
        # must terminal-commit instead of blocking the partition.
        self.consumer._dlq = dlq  # type: ignore[attr-defined]
        self._running = False
        self._heartbeat_task: asyncio.Task | None = None

    async def _heartbeat_loop(self) -> None:
        consecutive_failures = 0
        while self._running:
            # Heartbeat carries the real per-partition consumer lag (Phase 7)
            try:
                lag = await self.consumer.lag_snapshot()
            except Exception:
                lag = {}
            ok = await beat("analytics", extra={"group": "analytics-workers", "lag": lag})
            consecutive_failures = 0 if ok else consecutive_failures + 1
            if consecutive_failures >= 3:
                logger.warning(
                    "heartbeat failures - forcing consumer restart (self-heal)",
                    extra={"worker": "analytics", "failures": consecutive_failures},
                )
                try:
                    await self.consumer.stop()
                    await self.consumer.start()
                except Exception:
                    logger.exception("consumer self-heal restart failed")
                consecutive_failures = 0
            await asyncio.sleep(HEARTBEAT_INTERVAL_S)

    async def handle_event(self, event: dict[str, Any]) -> None:
        """Handler passed to KafkaEventConsumer.handle_raw.

        Records event in analytics_service. On failure raises -> no commit.
        Never logs payload.

        Processing latency is measured SERVER-SIDE inside analytics_service
        (monotonic clock, handler-entry -> counter pipeline) and recorded
        behind the same seen-key idempotency gate as the counters. Client
        event timestamps are never used for latency.
        """
        await record_event(event)

    async def start(self) -> None:
        await self.consumer.start()
        self._running = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info(
            "analytics worker started",
            extra={"group_id": "analytics-workers", "topic": self.consumer._topic},
        )

    async def stop(self) -> None:
        self._running = False
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None
        try:
            await self.consumer.stop()
        except Exception:
            logger.exception("error stopping analytics worker consumer")
        logger.info("analytics worker stopped", extra={"group_id": "analytics-workers"})

    async def run(self) -> None:
        if not self._running:
            await self.start()

        while self._running:
            if self.consumer._consumer is None:
                await asyncio.sleep(5)
                if not self._running:
                    break
                await self.consumer.start()
                continue

            try:
                await self.consumer.run(self.handle_event)
            except Exception:
                logger.exception("analytics worker run loop failed, will retry", extra={"group_id": "analytics-workers"})

            if self._running:
                await asyncio.sleep(1)


async def _main() -> None:
    worker = AnalyticsWorker()
    try:
        await worker.run()
    except KeyboardInterrupt:
        pass
    finally:
        await worker.stop()


if __name__ == "__main__":
    logging.basicConfig(level="INFO")
    asyncio.run(_main())


