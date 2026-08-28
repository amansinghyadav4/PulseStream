from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from aiokafka import AIOKafkaConsumer

from app.core.config import get_settings
from app.kafka.retry import with_retry_and_dlq
from app.kafka.serialization import deserialize_event

logger = logging.getLogger(__name__)


class KafkaEventConsumer:
    """Reusable Kafka consumer for application-events.

    Generic enough for both `persistence-workers` and `analytics-workers`
    (Phase 2D/2E). Single topic, manual commit, at-least-once.
    Supports retry + DLQ via with_retry_and_dlq (Phase 2G).
    """

    def __init__(
        self,
        bootstrap_servers: str,
        topic: str,
        group_id: str,
        auto_offset_reset: str = "earliest",
        enable_auto_commit: bool = False,
        dlq: Any | None = None,
    ) -> None:
        self._bootstrap_servers = bootstrap_servers
        self._topic = topic
        self._group_id = group_id
        self._auto_offset_reset = auto_offset_reset
        self._enable_auto_commit = enable_auto_commit
        self._dlq = dlq
        self._consumer: AIOKafkaConsumer | None = None

    async def start(self) -> None:
        if self._consumer is not None:
            return
        try:
            self._consumer = AIOKafkaConsumer(
                self._topic,
                bootstrap_servers=self._bootstrap_servers,
                group_id=self._group_id,
                auto_offset_reset=self._auto_offset_reset,
                enable_auto_commit=self._enable_auto_commit,
                value_deserializer=lambda v: v,
            )
            await self._consumer.start()
            logger.info(
                "kafka consumer started",
                extra={"topic": self._topic, "group_id": self._group_id},
            )
        except Exception:
            logger.exception(
                "kafka consumer failed to start - running without kafka",
                extra={"topic": self._topic, "group_id": self._group_id},
            )
            if self._consumer is not None:
                try:
                    await self._consumer.stop()
                except Exception:
                    pass
                self._consumer = None

    async def stop(self) -> None:
        if self._consumer is not None:
            try:
                await self._consumer.stop()
                logger.info("kafka consumer stopped", extra={"group_id": self._group_id})
            except Exception:
                logger.exception("error stopping kafka consumer", extra={"group_id": self._group_id})
            finally:
                self._consumer = None

    async def handle_raw(
        self,
        raw_value: bytes,
        handler: Callable[[dict[str, Any]], Awaitable[None]],
        dlq: Any | None = None,
    ) -> bool:
        """Process one raw Kafka value with retry + DLQ.

        Flow: deserialize_event() -> with_retry_and_dlq(handler) -> commit().
        - Malformed (ValueError from deserialize) is permanent: no retry, DLQ directly, then commit if DLQ succeeds.
        - Transient handler failures: retry up to 3 with backoff, then DLQ, then commit.
        - Never commits on ultimate failure (handler or DLQ failure).
        - Never logs payload.
        - dlq param overrides self._dlq if provided (for tests).
        """
        effective_dlq = dlq if dlq is not None else self._dlq

        # 1. deserialize
        try:
            event = deserialize_event(raw_value)
        except Exception as exc:
            # Permanent malformed
            logger.exception(
                "malformed kafka message - will DLQ if possible",
                extra={"topic": self._topic, "group_id": self._group_id},
            )
            if effective_dlq is not None:
                try:
                    await effective_dlq.send(raw_value, error=str(exc), key="malformed")
                    logger.info("malformed sent to DLQ", extra={"topic": self._topic, "group_id": self._group_id})
                    try:
                        from app.services.analytics_service import record_failed

                        await record_failed(None)
                    except Exception:
                        pass
                    # Audit the malformed failure (best-effort; no event fields exist)
                    try:
                        from app.services.failure_recorder import record_failure

                        await record_failure(None, error=str(exc)[:1024], attempts=0, final_status="dlq_malformed")
                    except Exception:
                        pass
                    # Terminal handling: commit to avoid poison loop if DLQ succeeded
                    if self._consumer is not None:
                        try:
                            await self._consumer.commit()
                            return True
                        except Exception:
                            logger.exception("failed to commit after DLQ (malformed)", extra={"topic": self._topic, "group_id": self._group_id})
                            return False
                    return False  # no consumer to commit, but DLQ succeeded
                except Exception:
                    logger.exception("failed to send malformed to DLQ - not committing", extra={"topic": self._topic, "group_id": self._group_id})
                    return False
            return False

        # 2. handler with retry + DLQ
        try:
            await with_retry_and_dlq(handler, event, raw_value, effective_dlq)
        except Exception:
            # with_retry already logged; handler ultimately failed and DLQ also failed (or no DLQ)
            logger.exception(
                "event handler ultimately failed - not committing offset",
                extra={
                    "topic": self._topic,
                    "group_id": self._group_id,
                    "event_id": str(event.get("event_id", "unknown")),
                },
            )
            return False

        # 3. commit only on success (handler success or DLQ terminal success)
        if self._consumer is None:
            return False

        try:
            await self._consumer.commit()
        except Exception:
            logger.exception(
                "failed to commit offset",
                extra={"topic": self._topic, "group_id": self._group_id},
            )
            return False

        return True

    async def lag_snapshot(self) -> dict[str, int]:
        """Per-partition consumer lag for the CURRENT assignment only.

        lag = highwatermark (broker end offset known to this fetcher) - position.
        Partitions with unknown offsets are omitted honestly rather than
        reported as zero. Empty dict when Kafka is unavailable. Never raises.
        """
        if self._consumer is None:
            return {}
        try:
            out: dict[str, int] = {}
            for tp in self._consumer.assignment():
                try:
                    hw = self._consumer.highwater(tp)
                    pos = self._consumer.position(tp)
                    if inspect.isawaitable(pos):
                        pos = await pos
                except Exception:
                    continue
                if hw is None or hw < 0 or pos is None or pos < 0:
                    continue
                out[str(tp.partition)] = max(0, int(hw) - int(pos))
            return out
        except Exception:
            return {}

    # Backwards-compatible simple path without retry/DLQ (used by older tests if needed)
    async def handle_raw_simple(
        self,
        raw_value: bytes,
        handler: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> bool:
        """Legacy simple handler without retry/DLQ (kept for reference)."""
        try:
            event = deserialize_event(raw_value)
        except Exception:
            logger.exception("malformed kafka message - skipping, not committing", extra={"topic": self._topic, "group_id": self._group_id})
            return False
        try:
            await handler(event)
        except Exception:
            logger.exception("event handler failed - not committing offset", extra={"topic": self._topic, "group_id": self._group_id, "event_id": str(event.get("event_id", "unknown"))})
            return False
        if self._consumer is None:
            return False
        try:
            await self._consumer.commit()
        except Exception:
            logger.exception("failed to commit offset", extra={"topic": self._topic, "group_id": self._group_id})
            return False
        return True

    async def run(self, handler: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        """Continuously consume messages and process via handle_raw.

        Uses self._dlq for DLQ handling.
        """
        if self._consumer is None:
            logger.warning("kafka consumer not started - run() is a no-op", extra={"group_id": self._group_id})
            return
        try:
            async for msg in self._consumer:  # type: ignore[attr-defined]
                await self.handle_raw(msg.value, handler)  # type: ignore[arg-type]
        except Exception:
            logger.exception("kafka consumer run loop failed", extra={"group_id": self._group_id})


def create_consumer(group_id: str | None = None, dlq: Any | None = None) -> KafkaEventConsumer:
    """Factory using pydantic-settings defaults."""
    settings = get_settings()
    return KafkaEventConsumer(
        bootstrap_servers=settings.kafka_bootstrap_servers,
        topic=settings.kafka_topic,
        group_id=group_id or settings.kafka_group_id,
        auto_offset_reset=settings.kafka_auto_offset_reset,
        enable_auto_commit=settings.kafka_enable_auto_commit,
        dlq=dlq,
    )
