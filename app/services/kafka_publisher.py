from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from aiokafka import AIOKafkaProducer

from app.core.config import get_settings
from app.kafka.serialization import partition_key_for_event, serialize_event

if TYPE_CHECKING:
    from app.models.event import Event

logger = logging.getLogger(__name__)


class KafkaEventPublisher:
    def __init__(self, bootstrap_servers: str, topic: str, enabled: bool = True) -> None:
        self._topic = topic
        self._enabled = enabled
        self._bootstrap_servers = bootstrap_servers
        self._producer: AIOKafkaProducer | None = None

    async def start(self) -> None:
        if not self._enabled:
            logger.info("kafka producer disabled")
            return
        if self._producer is not None:
            return
        try:
            self._producer = AIOKafkaProducer(
                bootstrap_servers=self._bootstrap_servers,
                acks="all",
                enable_idempotence=True,
            )
            await self._producer.start()
            logger.info("kafka producer started", extra={"topic": self._topic})
        except Exception:
            logger.exception("kafka producer failed to start - running without kafka")
            # Disable producer so publish becomes a no-op; DB remains source of truth
            if self._producer is not None:
                try:
                    await self._producer.stop()
                except Exception:
                    pass
                self._producer = None

    async def stop(self) -> None:
        if self._producer is not None:
            try:
                await self._producer.stop()
                logger.info("kafka producer stopped")
            except Exception:
                logger.exception("error stopping kafka producer")

    async def publish(self, key: str, value: bytes) -> None:
        # The database is the source of truth: a Kafka outage must not fail
        # an already-committed ingest, so publish errors are logged only.
        # Never log `value` (contains payload).
        if not self._ensure_started():
            return
        try:
            # Hard-bounded wait: broker outage cannot hang ingestion (spec §8).
            await asyncio.wait_for(
                self._producer.send_and_wait(self._topic, value=value, key=key.encode("utf-8")),
                timeout=5,
            )
        except Exception:
            logger.exception(
                "failed to publish event to kafka - resetting producer for recovery",
                extra={"topic": self._topic, "partition_key": key},
            )
            # Drop wedged client (stale broker metadata/IP) so the next publish
            # bootstraps a fresh connection instead of failing forever.
            await self._discard()

    def _ensure_started(self) -> bool:
        if not self._enabled:
            return False
        return True

    async def _discard(self) -> None:
        if self._producer is not None:
            try:
                await asyncio.wait_for(self._producer.stop(), timeout=5)
            except Exception:
                pass
            self._producer = None

    async def publish_event(self, event: Event) -> None:
        # Canonical serialization lives in app.kafka.serialization so consumers reuse it.
        value = serialize_event(event)
        # Partition key: user_id -> source -> event_id (docs/kafka-topics.md)
        key = partition_key_for_event(event)
        await self.publish(key, value)


settings = get_settings()
publisher = KafkaEventPublisher(
    bootstrap_servers=settings.kafka_bootstrap_servers,
    topic=settings.kafka_topic,
    enabled=settings.kafka_enabled,
)
