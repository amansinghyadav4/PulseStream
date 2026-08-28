from __future__ import annotations

import logging
import time
from typing import Any

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST

logger = logging.getLogger(__name__)

registry = CollectorRegistry()

http_requests_total = Counter(
    "pulsestream_http_requests_total", "HTTP requests", ["method", "path", "status"], registry=registry
)
http_request_latency_seconds = Histogram(
    "pulsestream_http_request_latency_seconds", "HTTP request latency", ["method", "path"], registry=registry
)
events_processed_total = Counter(
    "pulsestream_events_processed_total",
    "Events processed (worker persist success incl. idempotent duplicates, and API ingest)",
    registry=registry,
)
events_failed_total = Counter(
    "pulsestream_events_failed_total", "Events terminally failed to DLQ", registry=registry
)
websocket_connections = Gauge(
    "pulsestream_websocket_connections", "Active WebSocket dashboard clients", registry=registry
)

# Worker heartbeat gauges: 1 = fresh heartbeat observed at scrape time, 0 = stale/unknown.
worker_heartbeat = Gauge(
    "pulsestream_worker_heartbeat", "1 if worker heartbeat fresh else 0", ["worker"], registry=registry
)

# Consumer lag per worker group + partition, sampled from the workers' heartbeat
# payloads (written every HEARTBEAT_INTERVAL_S) at scrape time. Real broker-side
# highwatermark minus consumer position — never fabricated.
consumer_lag = Gauge(
    "pulsestream_consumer_lag", "Consumer lag by group and partition", ["group", "partition"], registry=registry
)


def _set_lag_gauges(group: str, lag: Any) -> None:
    """Set per-partition lag gauges from a heartbeat payload {partition_str: int}."""
    if not isinstance(lag, dict):
        return
    for partition, value in list(lag.items())[:64]:
        try:
            consumer_lag.labels(group=group, partition=str(partition)).set(max(0, int(value)))
        except (TypeError, ValueError):
            continue


def scrape() -> tuple[bytes, str]:
    """Refresh gauges that reflect live state, then render exposition."""
    try:
        from app.api.ws import manager

        websocket_connections.set(len(manager.active_connections))
    except Exception:
        pass

    async def _noop() -> None:  # pragma: no cover - never called
        pass

    # Heartbeat freshness requires an async redis read; /metrics handler performs it
    # before calling scrape_values(). Here we only render.
    return generate_latest(registry), CONTENT_TYPE_LATEST


async def refresh_worker_gauges() -> None:
    from app.services.heartbeat import read_heartbeat

    for name, group in (("persistence", "persistence-workers"), ("analytics", "analytics-workers")):
        status = await read_heartbeat(name)
        worker_heartbeat.labels(worker=name).set(1 if status.get("status") == "healthy" else 0)
        _set_lag_gauges(group, status.get("lag"))


class HttpRequestMetricsMiddleware:
    """Pure ASGI middleware recording request count + latency per route template."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path_tmpl = scope.get("path")
        method = scope.get("method", "")
        start = time.monotonic()
        status_holder = {"status": 500}

        async def send_wrapper(message: Any) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                # Prefer route template once router resolved it
                route = scope.get("route")
                if route is not None and getattr(route, "path", None):
                    nonlocal_path = route.path
                    if isinstance(nonlocal_path, str):
                        nonlocal_scope = scope
                        nonlocal_scope["metrics_path"] = nonlocal_path
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            elapsed = time.monotonic() - start
            label_path = scope.get("metrics_path") or path_tmpl
            # Skip scraping noise
            if label_path != "/metrics":
                http_requests_total.labels(method=method, path=label_path, status=str(status_holder["status"])).inc()
                http_request_latency_seconds.labels(method=method, path=label_path).observe(elapsed)
