"""PulseStream benchmark runner (Phase 7, spec section 17).

Runs a ladder of load steps against a LIVE stack (docker compose up),
sampling while each step runs:
- client-side latency/throughput/errors  (via loadgen.py subprocess)
- real Kafka consumer lag                (from /metrics heartbeat-derived gauges)
- container CPU/memory                   (docker stats --no-stream snapshots)
- PostgreSQL rows + relation size        (direct asyncpg query)

Writes one JSON file per run into load-tests/results/. Numbers are recorded
as measured on this machine - never extrapolated or invented.

Usage:
    python load-tests/benchmark.py [--url http://localhost:8001] [--quick]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import asyncpg
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from loadgen import LoadRunner  # noqa: E402

RESULTS_DIR = Path(__file__).resolve().parent / "results"

DEFAULT_DATABASE_URL = "postgresql://pulsestream:pulsestream@localhost:5432/pulsestream"

LAG_GAUGE_RE = re.compile(
    r'pulsestream_consumer_lag\{group="(?P<group>[^"]+)",partition="(?P<partition>[^"]+)"\}\s+(?P<value>\S+)'
)

# label, rate(ev/s), mode, batch, concurrency, duration_s
LADDER_FULL = [
    ("single_100", 100, "single", 1, 16, 15),
    ("single_1000", 1000, "single", 1, 128, 15),
    ("batch100_1000", 1000, "batch", 100, 16, 15),
    ("batch100_5000", 5000, "batch", 100, 64, 20),
    ("batch500_10000", 10000, "batch", 500, 64, 20),
]
LADDER_QUICK = [
    ("single_100", 100, "single", 1, 16, 8),
    ("batch100_1000", 1000, "batch", 100, 16, 8),
]


def docker_stats_snapshot() -> dict[str, dict[str, str]]:
    """One-shot container CPU/mem snapshot keyed by container name."""
    try:
        out = subprocess.run(
            [
                "docker", "stats", "--no-stream",
                "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}",
            ],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception as exc:
        return {"error": str(exc)[:200]}
    stats: dict[str, dict[str, str]] = {}
    for line in out.splitlines():
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) >= 3 and parts[0]:
            stats[parts[0]] = {"cpu": parts[1], "mem": parts[2], **({"net": parts[3]} if len(parts) > 3 else {})}
    return stats


def parse_lag_from_metrics(text: str) -> dict[str, int]:
    """max lag per group from the Prometheus exposition."""
    per_group: dict[str, int] = {}
    for match in LAG_GAUGE_RE.finditer(text):
        group = match.group("group")
        try:
            value = int(float(match.group("value")))
        except ValueError:
            continue
        per_group[group] = max(per_group.get(group, 0), value)
    return per_group


async def db_snapshot(database_url: str) -> dict:
    conn = await asyncpg.connect(database_url, timeout=10)
    try:
        count = await conn.fetchval("SELECT count(*) FROM events")
        size = await conn.fetchval("SELECT pg_total_relation_size('events')")
        return {"rows": int(count or 0), "total_relation_bytes": int(size or 0)}
    finally:
        await conn.close()


async def sample_during(url: str, stop: asyncio.Event, interval: float, samples: list[dict]) -> None:
    iteration = 0
    async with httpx.AsyncClient() as client:
        while not stop.is_set():
            try:
                resp = await client.get(f"{url.rstrip('/')}/api/v1/metrics", timeout=5)
                lag = parse_lag_from_metrics(resp.text) if resp.status_code == 200 else {}
            except Exception:
                lag = {}
            sample: dict = {"t": round(time.perf_counter(), 3), "lag_max_by_group": lag}
            # docker stats is slow (~1-2s) - run off the event loop every 3rd tick (~6s)
            if iteration % 3 == 2:
                stats = await asyncio.to_thread(docker_stats_snapshot)
                if stats:
                    sample["docker_stats"] = stats
            samples.append(sample)
            iteration += 1
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass


async def wait_drained(url: str, timeout_s: float = 90.0) -> float | None:
    """Seconds until persistence-workers lag reaches 0 (None if timed out)."""
    start = time.perf_counter()
    async with httpx.AsyncClient() as client:
        while time.perf_counter() - start < timeout_s:
            try:
                resp = await client.get(f"{url.rstrip('/')}/api/v1/metrics", timeout=5)
                lag = parse_lag_from_metrics(resp.text)
                persist_lag = lag.get("persistence-workers", None)
                if persist_lag == 0:
                    return round(time.perf_counter() - start, 2)
                if persist_lag is None:
                    # gauge absent: no assignment yet; keep waiting honestly
                    pass
            except Exception:
                pass
            await asyncio.sleep(1.0)
    return None


async def run_step(step: tuple, url: str, database_url: str) -> dict:
    label, rate, mode, batch, concurrency, duration = step
    print(f"\n=== {label}: target {rate} ev/s ({mode}, batch={batch}, {duration}s) ===", flush=True)

    before_db = await db_snapshot(database_url)

    samples: list[dict] = []
    stop = asyncio.Event()
    sampler = asyncio.create_task(sample_during(url, stop, 2.0, samples))

    runner = LoadRunner(argparse.Namespace(
        url=url, mode=mode, rate=float(rate), duration=duration, warmup=3.0,
        batch_size=batch, concurrency=concurrency, timeout=10.0,
    ))
    t_start = time.perf_counter()
    window = await runner.run_window(rate, duration, record=True)
    load_wall = time.perf_counter() - t_start

    drain_s = await wait_drained(url)
    stop.set()
    await sampler

    after_db = await db_snapshot(database_url)

    persisted = after_db["rows"] - before_db["rows"]
    result = {
        "step": label,
        "target_events_per_sec": rate,
        "mode": mode,
        "batch_size": batch,
        "concurrency": concurrency,
        "duration_s": duration,
        "client": window,
        "drain_seconds_until_persistence_lag_zero": drain_s,
        "persisted_rows_delta": persisted,
        "persistence_rate_per_sec": round(persisted / max(0.001, load_wall + (drain_s or 0)), 1),
        "db_before": before_db,
        "db_after": after_db,
        "resources_during_load": _cpu_mem_during_load(samples),
        "lag_samples_count": len(samples),
        "lag_samples_max_seen": _max_lag_seen(samples),
    }
    print(json.dumps({k: v for k, v in result.items() if k != "client"}, indent=2), flush=True)
    return result


def _max_lag_seen(samples: list[dict]) -> dict[str, int]:
    worst: dict[str, int] = {}
    for sample in samples:
        for group, value in sample["lag_max_by_group"].items():
            worst[group] = max(worst.get(group, 0), value)
    return worst


def _cpu_mem_during_load(samples: list[dict]) -> dict[str, dict[str, str]]:
    """Peak CPU% and last mem per container across mid-load docker stats samples."""
    peak_cpu: dict[str, float] = {}
    last_mem: dict[str, str] = {}
    for sample in samples:
        for name, stats in sample.get("docker_stats", {}).items():
            try:
                cpu = float(stats.get("cpu", "").rstrip("%"))
            except ValueError:
                cpu = 0.0
            peak_cpu[name] = max(peak_cpu.get(name, 0.0), cpu)
            if stats.get("mem"):
                last_mem[name] = stats["mem"]
    return {
        name: {"cpu_peak_pct": f"{peak_cpu[name]:g}%", "mem_last": last_mem[name]}
        for name in peak_cpu
        if name in last_mem
    }


async def main_async(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="PulseStream benchmark ladder")
    parser.add_argument("--url", default="http://localhost:8001")
    parser.add_argument("--database-url", default=DEFAULT_DATABASE_URL)
    parser.add_argument("--quick", action="store_true")
    args = parser.parse_args(argv)

    ladder = LADDER_QUICK if args.quick else LADDER_FULL
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    report = {
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "environment": {
            "host_os": sys.platform,
            "api_url": args.url,
            "note": "Windows host, Docker Desktop WSL2, single uvicorn process, one worker per group",
        },
        "steps": [],
    }

    for step in ladder:
        result = await run_step(step, args.url, args.database_url)
        report["steps"].append(result)
        out = RESULTS_DIR / f"benchmark_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{step[0]}.json"
        out.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"saved {out}", flush=True)

    print("\n===== SUMMARY =====")
    header = f"{'step':<18}{'target':>9}{'achieved ev/s':>15}{'p50 ms':>9}{'p95 ms':>9}{'p99 ms':>9}{'err%':>7}{'maxPersistLag':>15}"
    print(header)
    for s in report["steps"]:
        lat = s["client"].get("latency_ms", {})
        print(
            f"{s['step']:<18}{s['target_events_per_sec']:>9}"
            f"{s['client'].get('achieved_events_per_sec', 0):>15}"
            f"{lat.get('p50', 0):>9}{lat.get('p95', 0):>9}{lat.get('p99', 0):>9}"
            f"{s['client'].get('error_rate_pct', 0):>7}"
            f"{s['lag_samples_max_seen'].get('persistence-workers', 'n/a'):>15}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main_async(sys.argv[1:])))
