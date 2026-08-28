from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.db.session import SessionFactory
from app.kafka.consumer import KafkaEventConsumer, create_consumer
from app.kafka.dlq import dlq_publisher
from app.services.event_consumer_service import persist_event
from app.services.heartbeat import HEARTBEAT_INTERVAL_S, beat

logger = logging.getLogger(__name__)


class PersistenceWorker:
    """Consumes application-events with group persistence-workers.

    - topic = application-events
    - group_id = persistence-workers
    - reuses KafkaEventConsumer and deserialize_event (via consumer)
    - idempotent PG persist via event_consumer_service
    - one event at a time (no concurrency)
    - graceful start/stop, Kafka unavailable does not crash-loop aggressively
    - never logs payload
    """

    def __init__(
        self,
        consumer: KafkaEventConsumer | None = None,
        session_factory: Any = SessionFactory,
        dlq: Any = dlq_publisher,
    ) -> None:
        self.consumer = consumer or create_consumer(group_id="persistence-workers")
        # Ensure correct group/topic even if factory default changed
        # Force expected values for Phase 2D contract
        if self.consumer._topic != "application-events":
            logger.warning(
                "persistence worker topic mismatch, forcing application-events",
                extra={"topic": self.consumer._topic},
            )
            self.consumer._topic = "application-events"  # type: ignore[attr-defined]
        if self.consumer._group_id != "persistence-workers":
            logger.warning(
                "persistence worker group mismatch, forcing persistence-workers",
                extra={"group_id": self.consumer._group_id},
            )
            self.consumer._group_id = "persistence-workers"  # type: ignore[attr-defined]
        self.session_factory = session_factory
        self.dlq = dlq
        # Wire DLQ into consumer so handle_raw can DLQ malformed/permanent failures (Phase 2G)
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
            ok = await beat("persistence", extra={"group": "persistence-workers", "lag": lag})
            consecutive_failures = 0 if ok else consecutive_failures + 1
            if consecutive_failures >= 3:
                logger.warning(
                    "heartbeat failures - forcing consumer restart (self-heal)",
                    extra={"worker": "persistence", "failures": consecutive_failures},
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

        - Persists idempotently via persist_event.
        - On success (including duplicate) returns normally -> consumer commits.
        - On DB failure raises -> consumer does NOT commit (redelivery).
        - Permanent validation failures are not retried here; DLQ will be used in Phase 2G
          but for 2D we just not-commit and count as failure (DLQ abstraction exists but not invoked
          for transient vs permanent distinction yet).
        - Never logs payload.
        """
        # Persist with a fresh session per event (one at a time)
        async with self.session_factory() as session:  # type: ignore[call-arg]
            await persist_event(session, event)

    async def start(self) -> None:
        await self.consumer.start()
        # DLQ producer start is non-fatal as well
        try:
            await self.dlq.start()
        except Exception:
            logger.exception("dlq start failed - continuing without dlq")
        self._running = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info(
            "persistence worker started",
            extra={"group_id": "persistence-workers", "topic": self.consumer._topic},
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
            logger.exception("error stopping persistence worker consumer")
        try:
            await self.dlq.stop()
        except Exception:
            pass
        logger.info("persistence worker stopped", extra={"group_id": "persistence-workers"})

    async def run(self) -> None:
        """Run consumption loop.

        One event at a time, manual commit via consumer.handle_raw.
        If Kafka is unavailable at start, back off 5s and retry without tight looping.
        """
        if not self._running:
            await self.start()

        while self._running:
            if self.consumer._consumer is None:
                # Kafka not available — back off, try restart, avoid crash-loop
                await asyncio.sleep(5)
                if not self._running:
                    break
                await self.consumer.start()
                continue

            try:
                # Delegate to consumer's run loop which iterates and calls handle_event via handle_raw
                await self.consumer.run(self.handle_event)
            except Exception:
                logger.exception("persistence worker run loop failed, will retry", extra={"group_id": "persistence-workers"})

            # If run() exits (consumer closed or error), back off before retry if still running
            if self._running:
                await asyncio.sleep(1)


# Entrypoint for `python -m worker.persistence_worker` or direct script
async def _main() -> None:
    worker = PersistenceWorker()
    try:
        await worker.run()
    except KeyboardInterrupt:
        pass
    finally:
        await worker.stop()


if __name__ == "__main__":
    logging.basicConfig(level="INFO")
    asyncio.run(_main())

