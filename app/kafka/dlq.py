from __future__ import annotations

import json
import logging
from typing import Any

from aiokafka import AIOKafkaProducer

from app.core.config import get_settings

logger = logging.getLogger(__name__)


class KafkaDlqProducer:
    """Minimal DLQ producer for dead-letter-events.

    Phase 2D: abstraction exists so persistence worker can later send
    permanent failures here. No retry/backoff yet (Phase 2G).
    Graceful failure, never logs payload.
    """

    def __init__(self, bootstrap_servers: str, topic: str, enabled: bool = True) -> None:
        self._topic = topic
        self._enabled = enabled
        self._bootstrap_servers = bootstrap_servers
        self._producer: AIOKafkaProducer | None = None

    async def start(self) -> None:
        if not self._enabled:
            logger.info("dlq producer disabled", extra={"topic": self._topic})
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
            logger.info("dlq producer started", extra={"topic": self._topic})
        except Exception:
            logger.exception("dlq producer failed to start - dlq disabled", extra={"topic": self._topic})
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
                logger.info("dlq producer stopped", extra={"topic": self._topic})
            except Exception:
                logger.exception("error stopping dlq producer", extra={"topic": self._topic})
            finally:
                self._producer = None

    async def send(self, raw_value: bytes, error: str, key: str | None = None) -> None:
        """Send raw original message to DLQ with error metadata.

        Never logs payload. Logs only topic, key, error code.
        """
        if self._producer is None:
            return
        # Wrap original + error without logging payload
        # We send a JSON envelope: {"original": <base64? but keep raw as utf-8 if possible>, "error": error}
        # For Phase 2D minimal: just forward raw_value with error in headers would be ideal, but aiokafka headers are bytes.
        # Simplify: create DLQ envelope with original payload opaque and error string.
        try:
            # Try to keep original as JSON if it was valid, else as base64-ish string
            try:
                original_str = raw_value.decode("utf-8")
                # validate it's json to avoid double-encoding issues, but keep as string
                json.loads(original_str)
            except Exception:
                original_str = raw_value.hex()  # fallback
            envelope = json.dumps({"original": original_str, "error": error}).encode("utf-8")
            dlq_key = (key or "dlq").encode("utf-8")
            await self._producer.send_and_wait(self._topic, value=envelope, key=dlq_key)
        except Exception:
            logger.exception("failed to send to dlq", extra={"topic": self._topic, "dlq_key": key or "dlq"})


settings = get_settings()
dlq_publisher = KafkaDlqProducer(
    bootstrap_servers=settings.kafka_bootstrap_servers,
    topic=settings.kafka_dlq_topic,
    enabled=settings.kafka_enabled,
)
