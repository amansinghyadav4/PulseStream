"""PulseStream load generator (Phase 7, spec section 17).

Open-loop paced HTTP event generator:
- schedules requests on a fixed time grid (rate independent of response time),
- fixed pool of concurrent workers bounds in-flight requests,
- measures per-request client-side latency and status,
- reports throughput, p50/p90/p95/p99/max, error rate, error breakdown.

Usage:
    python load-tests/loadgen.py --url http://localhost:8001 --rate 1000 \
        --duration 30 --mode batch --batch-size 100 --json-out out.json

Modes:
    single  one event per POST /api/v1/events
    batch   N events per POST /api/v1/events/batch

`--rate` is always EVENTS per second (batch mode divides by --batch-size to
get the request rate). Achieved rate below target means the system (or the
client pool) could not keep up - reported honestly, never extrapolated.
"""
from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import math
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

EVENT_TYPES = [
    "order.created",
    "payment.completed",
    "page.viewed",
    "user.login",
    "shipment.updated",
]
SOURCES = [
    "checkout-service",
    "web-frontend",
    "mobile-app",
    "billing-service",
    "logistics-service",
]


def make_event(seq: int) -> dict:
    """Build one canonical event. Unique event_id every time (no dedupe hits)."""
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": EVENT_TYPES[seq % len(EVENT_TYPES)],
        "source": SOURCES[(seq // 7) % len(SOURCES)],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "user_id": f"user-{seq % 500:04d}",
        "request_id": str(uuid.uuid4()),
        "payload": {"seq": seq, "pad": "x" * 96},
        "schema_version": 1,
    }


def percentile(sorted_values: list[float], p: float) -> float:
    """Linear-interpolated percentile over an ascending-sorted list."""
    if not sorted_values:
        return 0.0
    k = (len(sorted_values) - 1) * (p / 100.0)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return sorted_values[int(k)]
    return sorted_values[lo] * (hi - k) + sorted_values[hi] * (k - lo)


class LoadRunner:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.base_url = args.url.rstrip("/")
        # single mode is one event per request by definition; batch_size only applies to batch mode
        self.batch_size = 1 if args.mode == "single" else max(1, args.batch_size)

    def _endpoint(self) -> str:
        if self.args.mode == "batch":
            return f"{self.base_url}/api/v1/events/batch"
        return f"{self.base_url}/api/v1/events"

    def _body(self, seq: int) -> dict | list[dict]:
        if self.args.mode == "batch":
            base = seq * self.batch_size
            return {"events": [make_event(base + j) for j in range(self.batch_size)]}
        return make_event(seq)

    async def run_window(self, rate_events: float, duration_s: float, record: bool) -> dict:
        """Run one paced window. Returns window stats (empty when record=False)."""
        rate_requests = rate_events / self.batch_size
        total_requests = max(1, int(rate_requests * duration_s))
        interval = 1.0 / rate_requests
        concurrency = self.args.concurrency

        latencies_ms: list[float] = []
        status_counts: dict[str, int] = {}
        ok_events = 0
        sent = 0

        next_index = 0
        deadline_exceeded = False

        timeout = httpx.Timeout(self.args.timeout)
        limits = httpx.Limits(
            max_connections=concurrency + 16,
            max_keepalive_connections=concurrency,
        )

        async def fire(client: httpx.AsyncClient, seq: int) -> None:
            nonlocal ok_events, sent
            body = self._body(seq)
            start = time.perf_counter()
            status = 0
            try:
                resp = await client.post(self._endpoint(), json=body, timeout=timeout)
                status = resp.status_code
                # drain body to reuse the connection cleanly
                resp.read()
            except (httpx.TimeoutException, httpx.TransportError) :
                status = 0
            except Exception:
                status = -1
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            sent += 1
            if 200 <= status < 300:
                if isinstance(body, dict) and "events" in body:
                    ok_events += len(body["events"])
                else:
                    ok_events += 1
            key = str(status)
            status_counts[key] = status_counts.get(key, 0) + 1
            if record:
                latencies_ms.append(elapsed_ms)

        async def worker(client: httpx.AsyncClient, t0: float) -> None:
            nonlocal next_index, deadline_exceeded
            while True:
                if next_index >= total_requests:
                    return
                index = next_index
                next_index += 1
                due = t0 + index * interval
                delay = due - time.perf_counter()
                if delay > 0:
                    await asyncio.sleep(delay)
                elif time.perf_counter() > t0 + duration_s + self.args.timeout:
                    # hopelessly behind schedule: stop feeding new work
                    deadline_exceeded = True
                    return
                await fire(client, index)

        async with httpx.AsyncClient(limits=limits) as client:
            health = await client.get(f"{self.base_url}/api/v1/health", timeout=5)
            if health.status_code != 200:
                raise RuntimeError(f"API not healthy at {self.base_url}: {health.status_code}")

            t0 = time.perf_counter()
            workers = [asyncio.create_task(worker(client, t0)) for _ in range(concurrency)]
            await asyncio.gather(*workers)
            wall = time.perf_counter() - t0

        result = {
            "target_events_per_sec": rate_events if record else 0,
            "sent_requests": sent,
            "ok_events": ok_events,
            "wall_seconds": round(wall, 3),
            "offered_requests_per_sec": round(sent / duration_s, 2),
            # completion-based throughput includes any queueing tail - honest
            "achieved_events_per_sec": round(ok_events / wall, 1) if wall > 0 else 0.0,
            "achieved_requests_per_sec": round(sent / wall, 2) if wall > 0 else 0.0,
            "completion_tail_seconds": round(max(0.0, wall - duration_s), 3),
            "behind_schedule": deadline_exceeded,
            "status_breakdown": status_counts,
        }
        if record and latencies_ms:
            ordered = sorted(latencies_ms)
            result["latency_ms"] = {
                "p50": round(percentile(ordered, 50), 2),
                "p90": round(percentile(ordered, 90), 2),
                "p95": round(percentile(ordered, 95), 2),
                "p99": round(percentile(ordered, 99), 2),
                "max": round(ordered[-1], 2),
                "samples": len(ordered),
            }
            errors = sum(v for k, v in status_counts.items() if not k.startswith("2"))
            result["error_rate_pct"] = round(100.0 * errors / max(1, sent), 3)
        return result


async def main_async(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="PulseStream load generator")
    parser.add_argument("--url", default="http://localhost:8001")
    parser.add_argument("--mode", choices=["single", "batch"], default="single")
    parser.add_argument("--rate", type=float, required=True, help="target EVENTS/sec")
    parser.add_argument("--duration", type=float, default=30.0, help="measured seconds")
    parser.add_argument("--warmup", type=float, default=5.0, help="unmeasured warmup seconds")
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--concurrency", type=int, default=64)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--json-out", default=None)
    argv_args = parser.parse_args(argv)

    runner = LoadRunner(argv_args)

    summary: dict = {
        "config": {
            "url": argv_args.url,
            "mode": argv_args.mode,
            "rate_events_per_sec": argv_args.rate,
            "duration_s": argv_args.duration,
            "warmup_s": argv_args.warmup,
            "batch_size": argv_args.batch_size,
            "concurrency": argv_args.concurrency,
            "timeout_s": argv_args.timeout,
        },
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
    }

    if argv_args.warmup > 0:
        print(f"warmup {argv_args.warmup}s ...", flush=True)
        await runner.run_window(argv_args.rate, argv_args.warmup, record=False)

    print(f"measuring {argv_args.duration}s at target {argv_args.rate} ev/s ...", flush=True)
    window = await runner.run_window(argv_args.rate, argv_args.duration, record=True)
    summary["window"] = window

    print(json.dumps(window, indent=2))
    if argv_args.json_out:
        Path(argv_args.json_out).write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"results written to {argv_args.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main_async(sys.argv[1:])))
