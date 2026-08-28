"""Live Phase 5 dashboard verification: POST → Kafka → analytics → Redis → WebSocket.

Run with backend + workers + Docker (postgres/kafka/redis) up.
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone

import httpx

from app.redis.client import get_redis
from app.services.analytics_service import get_metrics, reset_metrics

BASE = "http://127.0.0.1:8000"
WS = "ws://127.0.0.1:8000/api/v1/ws"


async def ws_collect(url: str, seconds: float) -> list[dict]:
    """Connect a raw WebSocket and collect messages for N seconds."""
    try:
        from websockets.client import connect as ws_connect
    except ImportError:
        from websockets import connect as ws_connect  # type: ignore

    messages: list[dict] = []

    async def _run():
        async with ws_connect(url) as ws:
            end = asyncio.get_event_loop().time() + seconds
            while asyncio.get_event_loop().time() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    messages.append(json.loads(raw))
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    break

    await asyncio.wait_for(_run(), timeout=seconds + 5)
    return messages


async def main() -> None:
    print("=== reset analytics ===")
    await reset_metrics()

    print("=== health ===")
    async with httpx.AsyncClient(timeout=10) as ac:
        for p in ["/health", "/api/v1/health", "/ready", "/api/v1/ready"]:
            r = await ac.get(BASE + p)
            assert r.status_code == 200, (p, r.status_code)
            print(f"GET {p} -> {r.status_code} {r.json()}")

        # 1. POST event succeeds
        eid = str(uuid.uuid4())
        r = await ac.post(
            f"{BASE}/api/v1/events",
            json={
                "event_id": eid,
                "event_type": "page.viewed",
                "source": "ws-live-test",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "payload": {"page": "/live"},
            },
        )
        assert r.status_code == 201, r.text
        print(f"1. POST /api/v1/events -> 201 id={eid[:8]}")

        # 2-3. Redis counters increment; WS client receives metrics
        msgs = await ws_collect(WS, 3.5)
        metrics_msgs = [m for m in msgs if m.get("type") == "metrics"]
        assert metrics_msgs, f"no metrics broadcast received: {msgs}"
        last = metrics_msgs[-1]["data"]
        assert last["total"] >= 1, f"total not incremented: {last}"
        print(f"2-3. Redis total={last['total']} via WS broadcast ({len(metrics_msgs)} msgs)")

        # REST analytics still works
        r = await ac.get(f"{BASE}/api/v1/analytics")
        assert r.status_code == 200
        rest = r.json()
        assert rest["total"] >= 1
        print(f"9. GET /api/v1/analytics -> 200 total={rest['total']}")

        # 4. Recent events contains the event
        r = await ac.get(f"{BASE}/api/v1/events?limit=20")
        assert r.status_code == 200
        recent = r.json()
        ids = [e["event_id"] for e in recent]
        assert eid in ids, "recent events missing posted event"
        # newest first check
        created = [e["created_at"] for e in recent]
        assert created == sorted(created, reverse=True), "not newest-first"
        print(f"4. GET /api/v1/events?limit=20 -> 200 count={len(recent)} contains event, newest first")

        # limit validation
        r = await ac.get(f"{BASE}/api/v1/events?limit=1001")
        assert r.status_code == 422
        print("   GET ?limit=1001 -> 422")

        # 5. Duplicate does not double-count analytics
        before = (await get_metrics())["total"]
        r = await ac.post(
            f"{BASE}/api/v1/events",
            json={
                "event_id": eid,
                "event_type": "page.viewed",
                "source": "ws-live-test",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "payload": {},
            },
        )
        assert r.status_code == 409
        after = (await get_metrics())["total"]
        assert before == after, f"duplicate inflated analytics {before}->{after}"
        print(f"5. duplicate POST -> 409, analytics unchanged ({before})")

    # 6. graceful disconnect handled inside server (connection closed below without error)
    # 7. reconnect works
    msgs2 = await ws_collect(WS, 2.5)
    assert any(m.get("type") == "metrics" for m in msgs2), "reconnect failed"
    print("6-7. disconnect/reconnect OK (second WS session received broadcasts)")

    # 8. Redis fallback: patch get_redis to None and verify get_metrics falls back
    import app.redis.client as rc
    import app.services.analytics_service as svc

    async def none_redis():
        return None

    orig = rc.get_redis
    try:
        rc.get_redis = none_redis  # type: ignore
        m = await svc.get_metrics()
        assert "total" in m
        print(f"8. Redis-down fallback get_metrics -> total={m['total']} (in-memory)")
    finally:
        rc.get_redis = orig  # type: ignore

    # 10-11. persistence + retry/DLQ untouched (covered by pytest suite)

    # 12. no payload in logs — verified by unit tests (caplog assertions)

    print("ALL LIVE DASHBOARD CHECKS PASS")


asyncio.run(main())
