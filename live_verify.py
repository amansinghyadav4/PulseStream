import asyncio, uuid, json, logging
from datetime import datetime, timezone
from sqlalchemy import select, func, text
from app.db.session import SessionFactory, engine
from app.db.base import Base
from app.kafka.serialization import serialize_event, deserialize_event
from app.models.event import Event
from app.services.event_consumer_service import persist_event
from app.services.analytics_service import get_metrics, reset_metrics
from worker.persistence_worker import PersistenceWorker
from worker.analytics_worker import AnalyticsWorker
from app.kafka.consumer import KafkaEventConsumer
from app.core.config import get_settings
from unittest.mock import AsyncMock

async def setup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with SessionFactory() as s:
        await s.execute(text("TRUNCATE events RESTART IDENTITY CASCADE"))
        await s.commit()
    await reset_metrics()
    print("setup done")

asyncio.run(setup())

async def test_duplicate():
    eid = uuid.uuid4()
    evt = Event(
        event_id=eid,
        event_type="order.created",
        source="live-test",
        timestamp=datetime(2026,8,24,12,0,0,tzinfo=timezone.utc),
        user_id="u-live-1",
        request_id=None,
        payload={"total": 123, "secret": "LIVE_SECRET_4"},
        schema_version=1,
        created_at=datetime.now(timezone.utc),
    )
    raw = serialize_event(evt)
    des = deserialize_event(raw)
    async with SessionFactory() as s:
        inserted1 = await persist_event(s, des)
        print(f"first persist inserted={inserted1} id={eid}")
        count1 = await s.scalar(select(func.count()).select_from(Event).where(Event.event_id==eid))
        print(f"count after first={count1}")
    async with SessionFactory() as s:
        inserted2 = await persist_event(s, des)
        print(f"second persist (duplicate) inserted={inserted2} (should be False idempotent)")
        count2 = await s.scalar(select(func.count()).select_from(Event).where(Event.event_id==eid))
        print(f"count after duplicate={count2}")
        r = await s.execute(select(Event).where(Event.event_id==eid))
        row = r.scalar_one()
        print(f"payload after duplicate: {row.payload}")
        assert count2==1
        assert row.payload=={"total":123, "secret": "LIVE_SECRET_4"}
    print("duplicate test PASS")

asyncio.run(test_duplicate())

async def test_analytics():
    await reset_metrics()
    from app.services.analytics_service import record_event
    await record_event({"event_id": uuid.uuid4(), "event_type":"order.created", "source":"svc-a", "payload":{}, "timestamp": datetime.now(timezone.utc), "schema_version":1})
    await record_event({"event_id": uuid.uuid4(), "event_type":"page.viewed", "source":"svc-a", "payload":{}, "timestamp": datetime.now(timezone.utc), "schema_version":1})
    m = get_metrics()
    print(f"analytics metrics: {m}")
    assert m["total"]==2
    assert m["events_by_type"]["order.created"]==1
    print("analytics PASS")
asyncio.run(test_analytics())

async def test_retry_dlq():
    from unittest.mock import patch
    consumer = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="test-retry-group")
    mock_kafka = AsyncMock()
    mock_kafka.commit = AsyncMock()
    consumer._consumer = mock_kafka
    dlq = AsyncMock()
    dlq.send = AsyncMock()
    consumer._dlq = dlq
    malformed = b"not json"
    async def handler(e):
        pass
    committed = await consumer.handle_raw(malformed, handler)
    print(f"malformed DLQ committed={committed} (should True with DLQ)")
    assert committed is True
    assert dlq.send.await_count==1

    evt = Event(
        event_id=uuid.uuid4(),
        event_type="order.created",
        source="svc-a",
        timestamp=datetime(2026,8,24,12,0,0,tzinfo=timezone.utc),
        user_id="u-1",
        request_id=None,
        payload={"total":1},
        schema_version=1,
        created_at=datetime.now(timezone.utc),
    )
    raw = serialize_event(evt)
    consumer2 = KafkaEventConsumer(bootstrap_servers="localhost:9092", topic="application-events", group_id="g2")
    mock_kafka2 = AsyncMock()
    mock_kafka2.commit = AsyncMock()
    consumer2._consumer = mock_kafka2
    dlq2 = AsyncMock()
    dlq2.send = AsyncMock()
    consumer2._dlq = dlq2
    call_count={"n":0}
    async def failing_handler(e):
        call_count["n"]+=1
        from sqlalchemy.exc import SQLAlchemyError
        raise SQLAlchemyError("transient")
    with patch("app.kafka.retry.asyncio.sleep", new=AsyncMock()):
        committed2 = await consumer2.handle_raw(raw, failing_handler)
    print(f"transient exhaustion DLQ committed={committed2} attempts={call_count['n']} (should 3 and True)")
    assert committed2 is True
    assert call_count["n"]==3
    assert dlq2.send.await_count==1
    print("retry DLQ PASS")

asyncio.run(test_retry_dlq())
print("ALL LIVE CHECKS PASS")
