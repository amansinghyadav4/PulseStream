import asyncio, uuid, json, sys
from datetime import datetime, timezone
import httpx
from sqlalchemy import select, func, text
from app.db.session import SessionFactory, engine
from app.db.base import Base
from app.models.event import Event

BASE = "http://127.0.0.1:8000"

async def check_health():
    async with httpx.AsyncClient() as ac:
        for p in ["/health","/api/v1/health","/ready","/api/v1/ready"]:
            r = await ac.get(BASE+p)
            print(f"GET {p} -> {r.status_code} {r.json()}")
            assert r.status_code in (200,503)

async def post_event(payload_secret):
    eid = str(uuid.uuid4())
    payload = {"secret_live": payload_secret, "page": "/test"}
    async with httpx.AsyncClient() as ac:
        r = await ac.post(f"{BASE}/api/v1/events", json={
            "event_id": eid,
            "event_type": "page.viewed",
            "source": "live-test",
            "timestamp": "2026-08-24T12:00:00Z",
            "payload": payload,
            "user_id": "u-live-verify"
        })
        print(f"POST /api/v1/events {eid} -> {r.status_code}")
        assert r.status_code == 201, r.text
        # wait for worker to consume (persistence)
        await asyncio.sleep(2)
        # GET via both prefixes
        for path in [f"/events/{eid}", f"/api/v1/events/{eid}"]:
            gr = await ac.get(BASE+path)
            print(f"GET {path} -> {gr.status_code}")
            assert gr.status_code == 200
            assert gr.json()["payload"] == payload
        return eid, payload

async def check_db_count(eid):
    async with SessionFactory() as s:
        cnt = await s.scalar(select(func.count()).select_from(Event).where(Event.event_id==uuid.UUID(eid)))
        print(f"DB count for {eid}: {cnt}")
        assert cnt == 1
        # also check duplicate via worker path would still be 1 (already tested via persist)
        return cnt

async def test_duplicate_no_second_row(eid):
    # try duplicate POST should be 409
    async with httpx.AsyncClient() as ac:
        r = await ac.post(f"{BASE}/api/v1/events", json={
            "event_id": eid,
            "event_type": "page.viewed",
            "source": "live-test",
            "timestamp": "2026-08-24T12:00:00Z",
            "payload": {"secret_live": "dup"},
            "user_id": "u-live-verify"
        })
        print(f"duplicate POST -> {r.status_code} (expect 409)")
        assert r.status_code == 409
    await check_db_count(eid)
    print("duplicate test PASS")

async def main():
    await check_health()
    eid, payload = await post_event("LIVE_SECRET_42")
    await check_db_count(eid)
    await test_duplicate_no_second_row(eid)
    # verify analytics independent - we can't read worker's in-memory from separate process, but we can test via direct service
    from app.services.analytics_service import reset_metrics, get_metrics, record_event
    await reset_metrics()
    # simulate same event through analytics worker's handler
    des = {"event_id": uuid.UUID(eid), "event_type":"page.viewed","source":"live-test","payload":payload,"timestamp":datetime.now(timezone.utc),"schema_version":1,"user_id":"u-live-verify","request_id":None,"created_at":datetime.now(timezone.utc)}
    await record_event(des)
    m = get_metrics()
    print(f"analytics direct metrics after 1 event: {m}")
    assert m["total"]==1
    assert m["events_by_type"]["page.viewed"]==1
    print("analytics direct PASS")
    # DLQ check via consumer with malformed
    from app.kafka.consumer import KafkaEventConsumer
    from unittest.mock import AsyncMock
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="live-dlq-test")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka
    dlq = AsyncMock()
    dlq.send = AsyncMock()
    consumer._dlq = dlq
    malformed = b"not json live"
    async def handler(e):
        pass
    committed = await consumer.handle_raw(malformed, handler)
    print(f"malformed DLQ committed={committed} (expect True)")
    assert committed is True and dlq.send.await_count==1
    print("DLQ malformed PASS")
    print("ALL LIVE PIPELINE CHECKS PASS")

asyncio.run(main())
