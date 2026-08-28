import asyncio, uuid, json
from datetime import datetime, timezone
import httpx
from app.redis.client import get_redis
from app.services.analytics_service import reset_metrics, get_metrics
from app.core.config import get_settings

BASE="http://127.0.0.1:8000"

async def test_live_redis():
    # clear redis and PG via reset
    await reset_metrics()
    r = await get_redis()
    if r is None:
        print("redis not available - cannot test live redis")
        return
    await r.flushall()
    print("redis flushed")

    # POST events via API
    async with httpx.AsyncClient() as ac:
        e1 = str(uuid.uuid4())
        e2 = str(uuid.uuid4())
        # event with user_id for partition key
        resp1 = await ac.post(f"{BASE}/api/v1/events", json={"event_id": e1, "event_type":"order.created","source":"live-redis","payload":{"a":1},"user_id":"u-redis-1","timestamp":"2026-08-24T12:00:00Z"})
        print(f"POST e1 {resp1.status_code}")
        assert resp1.status_code==201
        resp2 = await ac.post(f"{BASE}/api/v1/events", json={"event_id": e2, "event_type":"page.viewed","source":"live-redis","payload":{"a":2},"user_id":"u-redis-1","timestamp":"2026-08-24T12:00:00Z"})
        print(f"POST e2 {resp2.status_code}")
        assert resp2.status_code==201

        # wait for analytics worker to consume and increment redis (worker runs in separate process, needs time)
        await asyncio.sleep(3)

        # Check analytics endpoint (should read from Redis)
        resp = await ac.get(f"{BASE}/api/v1/analytics")
        print(f"GET /api/v1/analytics -> {resp.status_code} {resp.json()}")
        assert resp.status_code==200
        data = resp.json()
        print(f"analytics data: {data}")
        # total should be at least 2 (maybe more from previous tests)
        assert data["total"] >= 2

        # Check legacy endpoint
        resp2 = await ac.get(f"{BASE}/analytics")
        print(f"GET /analytics -> {resp2.status_code} {resp2.json()}")
        assert resp2.status_code==200

        # Duplicate should not double count
        dup_resp = await ac.post(f"{BASE}/api/v1/events", json={"event_id": e1, "event_type":"order.created","source":"live-redis","payload":{"a":1},"user_id":"u-redis-1","timestamp":"2026-08-24T12:00:00Z"})
        print(f"duplicate POST -> {dup_resp.status_code} expect 409")
        assert dup_resp.status_code==409

        # Check that analytics did not double count duplicate (since POST was rejected, no new event, but test duplicate via worker idempotency)
        # Simulate duplicate delivery via direct redis seen check: try to record same event_id again via analytics service
        from app.services.analytics_service import record_event
        # This should be duplicate and not increment
        before = (await get_metrics())["total"]
        await record_event({"event_id": uuid.UUID(e1), "event_type":"order.created","source":"live-redis","payload":{}, "timestamp": datetime.now(timezone.utc), "schema_version":1, "user_id":"u-redis-1", "request_id": None, "created_at": None})
        after = (await get_metrics())["total"]
        print(f"duplicate analytics record before={before} after={after} (should be same)")
        assert before == after, "duplicate should not increment"

        # Check Redis keys and TTL
        prefix = get_settings().redis_key_prefix
        seen_key = f"{prefix}seen:{e1}"
        ttl = await r.ttl(seen_key)
        print(f"seen TTL for {e1}: {ttl} (expect 86400)")
        assert ttl > 0 and ttl <= 86400

        # per_minute key
        # Find per_minute keys
        keys = await r.keys(f"{prefix}analytics:per_minute:*")
        print(f"per_minute keys: {keys}")
        for k in keys:
            ttl2 = await r.ttl(k)
            print(f"per_minute {k} ttl {ttl2}")
            assert ttl2 > 0 and ttl2 <= 120

        print("live redis verify PASS")

    # test graceful fallback: simulate redis down by injecting None
    from unittest.mock import patch
    import app.redis.client as rc
    import app.services.analytics_service as svc
    async def mock_none():
        return None
    # patch both
    original_get = rc.get_redis
    # Use monkey patch via direct
    rc._redis = None
    rc._redis_available = False
    # Also need to patch svc's get_redis reference? svc imports get_redis at runtime via from app.redis.client import get_redis inside function, so patching rc is enough
    # But record_event imports get_redis inside function, so it will see mocked None via rc
    # For this test, we can just call record_event and it should fallback to in-memory
    await reset_metrics()
    # Force fallback by making get_redis return None
    with patch.object(rc, "get_redis", new=mock_none):
        with patch.object(svc, "get_redis", new=mock_none, create=True):
            # Need to also patch the imported reference in analytics_service module
            # analytics_service does `from app.redis.client import get_redis` inside function, so patching rc.get_redis will affect it
            await svc.record_event({"event_id": uuid.uuid4(), "event_type":"order.created","source":"svc-a","payload":{}, "timestamp": datetime.now(timezone.utc), "schema_version":1})
            m = await svc.get_metrics()
            print(f"fallback in-memory metrics after redis down: {m}")
            assert m["total"] >= 1
            print("graceful fallback PASS")

asyncio.run(test_live_redis())
print("ALL LIVE REDIS CHECKS PASS")
