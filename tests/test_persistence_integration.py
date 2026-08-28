import uuid
import pytest
from sqlalchemy import text, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import Base
from app.db.session import SessionFactory, engine
from app.kafka.serialization import deserialize_event, serialize_event
from app.models.event import Event
from app.services.event_consumer_service import persist_event


@pytest.fixture(scope="module", autouse=True)
async def database():
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("PostgreSQL unavailable; skipping persistence integration tests")
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    # cleanup: optional truncate after module
    try:
        async with SessionFactory() as session:
            await session.execute(text("TRUNCATE events RESTART IDENTITY CASCADE"))
            await session.commit()
    except Exception:
        pass


def _event_dict(**overrides):
    base = {
        "event_id": uuid.uuid4(),
        "event_type": "order.created",
        "source": "checkout-service",
        "timestamp": "2026-08-24T12:00:00+00:00",
        "user_id": "u-int-1",
        "request_id": "r-int-1",
        "payload": {"total": 99},
        "schema_version": 1,
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_persistence_worker_persists_new_event():
    event_id = uuid.uuid4()
    # Simulate Kafka message: create ORM event, serialize, deserialize
    from datetime import datetime, timezone

    evt = Event(
        event_id=event_id,
        event_type="order.created",
        source="checkout-service",
        timestamp=datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        user_id="u-int-new",
        request_id="r-1",
        payload={"total": 1},
        schema_version=1,
        created_at=datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    )
    raw = serialize_event(evt)
    des = deserialize_event(raw)

    async with SessionFactory() as session:
        inserted = await persist_event(session, des)
        assert inserted is True

        # verify row exists
        result = await session.execute(select(Event).where(Event.event_id == event_id))
        row = result.scalar_one_or_none()
        assert row is not None
        assert row.payload == {"total": 1}
        assert row.user_id == "u-int-new"


@pytest.mark.asyncio
async def test_persistence_idempotent_duplicate_via_worker():
    event_id = uuid.uuid4()
    from datetime import datetime, timezone

    evt = Event(
        event_id=event_id,
        event_type="order.created",
        source="checkout-service",
        timestamp=datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        user_id="u-dup-int",
        request_id=None,
        payload={"total": 2},
        schema_version=1,
        created_at=datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    )
    raw = serialize_event(evt)
    des = deserialize_event(raw)

    async with SessionFactory() as session:
        inserted1 = await persist_event(session, des)
        assert inserted1 is True
        count1 = await session.scalar(select(func.count()).select_from(Event).where(Event.event_id == event_id))
        assert count1 == 1

    # second delivery same event_id, different payload (should be ignored due to ON CONFLICT)
    evt2 = Event(
        event_id=event_id,
        event_type="order.created",
        source="checkout-service",
        timestamp=datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        user_id="u-dup-int",
        request_id=None,
        payload={"total": 999},  # different payload, but duplicate id should be ignored
        schema_version=1,
        created_at=datetime(2026, 8, 24, 12, 0, 5, tzinfo=timezone.utc),
    )
    raw2 = serialize_event(evt2)
    des2 = deserialize_event(raw2)

    async with SessionFactory() as session:
        inserted2 = await persist_event(session, des2)
        assert inserted2 is False  # idempotent skip
        count2 = await session.scalar(select(func.count()).select_from(Event).where(Event.event_id == event_id))
        assert count2 == 1

        # payload should remain first value, not overwritten
        result = await session.execute(select(Event).where(Event.event_id == event_id))
        row = result.scalar_one()
        assert row.payload == {"total": 2}


@pytest.mark.asyncio
async def test_api_originated_event_is_idempotent_for_worker(client):
    # Use API to create event (DB source of truth), then simulate worker re-processing same Kafka message
    eid = str(uuid.uuid4())
    resp = await client.post(
        "/events",
        json={
            "event_id": eid,
            "event_type": "page.viewed",
            "source": "web-app",
            "timestamp": "2026-08-24T12:00:00Z",
            "payload": {"page": "/home"},
            "user_id": "u-api-dup",
        },
    )
    assert resp.status_code == 201, resp.text

    # Now simulate worker receiving same event from Kafka
    from datetime import datetime, timezone

    evt = Event(
        event_id=uuid.UUID(eid),
        event_type="page.viewed",
        source="web-app",
        timestamp=datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc),
        user_id="u-api-dup",
        request_id=None,
        payload={"page": "/home"},
        schema_version=1,
        created_at=datetime.now(timezone.utc),
    )
    raw = serialize_event(evt)
    des = deserialize_event(raw)

    async with SessionFactory() as session:
        inserted = await persist_event(session, des)
        # API already inserted, so worker should be idempotent skip, not error, still success
        assert inserted is False

        # count still 1
        count = await session.scalar(select(func.count()).select_from(Event).where(Event.event_id == uuid.UUID(eid)))
        assert count == 1

    # GET still works
    got = await client.get(f"/events/{eid}")
    assert got.status_code == 200
    assert got.json()["payload"] == {"page": "/home"}
