"""Increment C — tenant context + API-key ingestion isolation.

Two kinds of tests live here:

* **Integration** (require the Dockerized Postgres, skip cleanly when it is
  unreachable — same pattern as test_auth_system): full signup → create key →
  ingest → scoped-read flows proving tenant A and tenant B never see each other.
* **Unit** (always run): Redis key namespacing and Kafka org threading, which
  need neither Postgres nor a broker.

Never asserts on payload contents or logs secrets.

Filename note: this module is named to sort BEFORE ``test_prometheus_metrics``
and ``test_websocket_unit``. Those use the sync Starlette ``TestClient`` /
``asyncio.run(...)`` which, on Python 3.13, leave the thread with no current
event loop; under this pytest-asyncio version any *async* module collected after
them fails at setup with "no current event loop". Every other async module in
the suite already sorts ahead of them — this one follows the same convention.
"""
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text

from app.core.config import get_settings
from app.core.rate_limit import reset_rate_limits
from app.db.base import Base
from app.db.session import SessionFactory, engine
from app.main import app
from app.models.event import Event
from app.models.organization import DEMO_ORGANIZATION_ID

PASSWORD = "correct horse battery staple"


@pytest.fixture
async def database():
    """Non-autouse: only DB-dependent tests request it; unit tests skip past it."""
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("PostgreSQL unavailable; skipping tenant isolation integration tests")
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    get_settings.cache_clear()
    # Isolate the per-process auth limiter per test: every integration case here
    # signs up fresh tenants and they share one client IP, so without this the
    # "signup" bucket accumulates across tests and eventually trips its 429.
    reset_rate_limits()
    yield
    get_settings.cache_clear()


def _email() -> str:
    return f"tenant-{uuid.uuid4().hex}@example.com"


def _event_body(**overrides) -> dict:
    body = {
        "event_id": str(uuid.uuid4()),
        "event_type": "tenant.test",
        "source": "tenant-suite",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {},
        "schema_version": 1,
    }
    body.update(overrides)
    return body


def _fresh_client() -> AsyncClient:
    """Independent cookie jar per tenant so sessions never collide."""
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _csrf(c: AsyncClient) -> dict:
    return {"X-CSRF-Token": c.cookies.get("ps_csrf", "")}


async def _signup(c: AsyncClient):
    r = await c.post("/api/v1/auth/signup", json={"email": _email(), "password": PASSWORD})
    assert r.status_code == 201, r.text
    return r


async def _create_key(c: AsyncClient, name="prod") -> dict:
    r = await c.post("/api/v1/api-keys", json={"name": name}, headers=_csrf(c))
    assert r.status_code == 201, r.text
    return r.json()


async def _ingest(c: AsyncClient, raw_key: str, body: dict):
    return await c.post("/api/v1/events", json=body, headers={"X-API-Key": raw_key})


# --------------------------------------------------------------------------- #
# Integration: ingestion + scoped reads                                       #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_ingestion_attaches_resolved_org_and_reads_are_scoped(database):
    async with _fresh_client() as ca, _fresh_client() as cb:
        await _signup(ca)
        await _signup(cb)
        key_a = (await _create_key(ca))["api_key"]
        key_b = (await _create_key(cb))["api_key"]

        ev_a = _event_body(event_type="a.only")
        ev_b = _event_body(event_type="b.only")
        assert (await _ingest(ca, key_a, ev_a)).status_code == 201
        assert (await _ingest(cb, key_b, ev_b)).status_code == 201

        # Reads are scoped to the caller's org via the session cookie.
        a_ids = {e["event_id"] for e in (await ca.get("/api/v1/events?limit=100")).json()}
        b_ids = {e["event_id"] for e in (await cb.get("/api/v1/events?limit=100")).json()}

        assert ev_a["event_id"] in a_ids
        assert ev_a["event_id"] not in b_ids, "tenant B must not see tenant A's event"
        assert ev_b["event_id"] in b_ids
        assert ev_b["event_id"] not in a_ids, "tenant A must not see tenant B's event"

        # get_event by id is also scoped: A's event is 404 for B.
        cross = await cb.get(f"/api/v1/events/{ev_a['event_id']}")
        assert cross.status_code == 404, cross.text


@pytest.mark.asyncio
async def test_ingested_event_row_carries_correct_org(database):
    async with _fresh_client() as ca:
        await _signup(ca)
        key_a = (await _create_key(ca))["api_key"]
        ev = _event_body()
        assert (await _ingest(ca, key_a, ev)).status_code == 201

    # The persisted row's organization_id is the resolver's output, NOT anything
    # the client supplied. It must be a real, non-Demo org (A's own tenant).
    # (A background stream worker may separately re-insert the broker copy under
    # the Demo default; we assert the API attached A's non-Demo org regardless.)
    async with SessionFactory() as db:
        orgs = (
            await db.execute(select(Event.organization_id).where(
                Event.event_id == uuid.UUID(ev["event_id"])))
        ).scalars().all()
        assert orgs, "event must be persisted"
        assert any(o != DEMO_ORGANIZATION_ID for o in orgs), \
            "ingestion must attach the caller's own (non-Demo) organization"


# --------------------------------------------------------------------------- #
# Integration: Traffic Lab / Simulator key selection                          #
# --------------------------------------------------------------------------- #
# The dashboard's Traffic Lab lets a signed-in user pick one of their own API
# keys; the browser then sends that raw key as X-API-Key on every generated
# event. Choosing the default "Demo environment" option sends NO key — the
# existing shared/open Demo path. These tests prove backend attribution for both
# simulator paths using a simulator-shaped body (an EVENT_TYPES value from the
# frontend factory + the demo-store source).
def _simulator_event_body(**overrides) -> dict:
    fields = {"event_type": "order.created", "source": "demo-store"}
    fields.update(overrides)
    return _event_body(**fields)


@pytest.mark.asyncio
async def test_simulator_user_key_attributes_events_to_that_org(database):
    """Selecting a user's key (sent as X-API-Key) → the generated event belongs
    to that user's organization and is visible only to them, never to a peer."""
    async with _fresh_client() as ca, _fresh_client() as cb:
        await _signup(ca)
        await _signup(cb)
        key_a = (await _create_key(ca, name="traffic-lab"))["api_key"]

        ev = _simulator_event_body(event_type="checkout.completed")
        assert (await _ingest(ca, key_a, ev)).status_code == 201

        # Scoped read: the generating user sees it; the other tenant never does.
        a_ids = {e["event_id"] for e in (await ca.get("/api/v1/events?limit=100")).json()}
        b_ids = {e["event_id"] for e in (await cb.get("/api/v1/events?limit=100")).json()}
        assert ev["event_id"] in a_ids
        assert ev["event_id"] not in b_ids, "simulator traffic must stay within the caller's org"

        # And the persisted row carries A's own (non-Demo) organization — the id
        # is the resolver's output, not anything the client supplied.
        async with SessionFactory() as db:
            orgs = (
                await db.execute(select(Event.organization_id).where(
                    Event.event_id == uuid.UUID(ev["event_id"])))
            ).scalars().all()
            assert orgs, "event must be persisted"
            assert any(o != DEMO_ORGANIZATION_ID for o in orgs), \
                "user-key traffic must be attributed to the caller's own org"


@pytest.mark.asyncio
async def test_simulator_demo_fallback_maps_to_demo_org(database, monkeypatch):
    """The Traffic Lab's default 'Demo environment' option sends no X-API-Key.
    With no shared key configured this is open mode → the reserved Demo org,
    keeping the existing Demo behavior unchanged."""
    monkeypatch.delenv("PULSESTREAM_API_KEYS", raising=False)
    get_settings.cache_clear()
    try:
        async with _fresh_client() as c:
            ev = _simulator_event_body(event_type="user.signup")
            # No X-API-Key header at all — exactly what the Demo option sends.
            r = await c.post("/api/v1/events", json=ev)
            assert r.status_code == 201, r.text
        async with SessionFactory() as db:
            rows = (
                await db.execute(select(Event.organization_id).where(
                    Event.event_id == uuid.UUID(ev["event_id"])))
            ).scalars().all()
            assert rows, "event must be persisted"
            assert all(o == DEMO_ORGANIZATION_ID for o in rows), \
                "no-key simulator traffic must map to the reserved Demo organization"
    finally:
        get_settings.cache_clear()


# --------------------------------------------------------------------------- #
# Integration: API-key lifecycle                                              #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_api_key_create_returns_raw_once_and_list_hides_secret(database):
    async with _fresh_client() as ca:
        await _signup(ca)
        created = await _create_key(ca, name="ci")
        # Raw key returned exactly once, correct shape, secret never persisted raw.
        assert created["api_key"].startswith("psk_")
        assert created["name"] == "ci"
        assert created["key_prefix"] == created["api_key"][:12]
        assert created["revoked_at"] is None

        listed = (await ca.get("/api/v1/api-keys")).json()
        assert len(listed) == 1
        item = listed[0]
        assert item["key_prefix"] == created["key_prefix"]
        # No secret material ever appears in the list representation.
        assert "api_key" not in item
        assert "hashed_secret" not in item and "secret" not in item


@pytest.mark.asyncio
async def test_api_key_requires_auth_and_csrf(database):
    async with _fresh_client() as ca:
        # Unauthenticated create is rejected (no session → CSRF/ auth both fail),
        # never silently accepted.
        anon = await ca.post("/api/v1/api-keys", json={"name": "x"})
        assert anon.status_code in (401, 403)
        await _signup(ca)
        # Authenticated but missing CSRF header → 403.
        no_csrf = await ca.post("/api/v1/api-keys", json={"name": "x"})
        assert no_csrf.status_code == 403
        assert no_csrf.json()["error"]["code"] == "csrf_failed"


@pytest.mark.asyncio
async def test_revoked_key_is_rejected_at_ingestion(database):
    async with _fresh_client() as ca:
        await _signup(ca)
        created = await _create_key(ca)
        raw = created["api_key"]
        # Works before revocation.
        assert (await _ingest(ca, raw, _event_body())).status_code == 201
        # Revoke, then it must be rejected.
        rev = await ca.post(f"/api/v1/api-keys/{created['id']}/revoke", headers=_csrf(ca))
        assert rev.status_code == 200, rev.text
        assert rev.json()["revoked_at"] is not None
        after = await _ingest(ca, raw, _event_body())
        assert after.status_code == 401
        assert after.json()["error"]["code"] == "invalid_api_key"


@pytest.mark.asyncio
async def test_cannot_revoke_another_tenants_key(database):
    async with _fresh_client() as ca, _fresh_client() as cb:
        await _signup(ca)
        await _signup(cb)
        key_a = await _create_key(ca)
        # B tries to revoke A's key → 404 (no cross-tenant existence signal).
        r = await cb.post(f"/api/v1/api-keys/{key_a['id']}/revoke", headers=_csrf(cb))
        assert r.status_code == 404
        # And A's key still works.
        assert (await _ingest(ca, key_a["api_key"], _event_body())).status_code == 201


@pytest.mark.asyncio
async def test_demo_shared_key_still_maps_to_demo(database, monkeypatch):
    monkeypatch.setenv("PULSESTREAM_API_KEYS", "ps_demo_shared_key")
    get_settings.cache_clear()
    try:
        async with _fresh_client() as c:
            ev = _event_body(event_type="demo.shared")
            r = await c.post(
                "/api/v1/events", json=ev, headers={"X-API-Key": "ps_demo_shared_key"}
            )
            assert r.status_code == 201, r.text
        async with SessionFactory() as db:
            row = (
                await db.execute(
                    select(Event).where(Event.event_id == uuid.UUID(ev["event_id"]))
                )
            ).scalar_one()
            assert row.organization_id == DEMO_ORGANIZATION_ID
    finally:
        get_settings.cache_clear()


# --------------------------------------------------------------------------- #
# Integration: failures are tenant-scoped                                     #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_failures_are_scoped_to_tenant(database):
    from app.services.failure_recorder import record_failure

    async with _fresh_client() as ca, _fresh_client() as cb:
        await _signup(ca)
        await _signup(cb)
        # Ingest one event per tenant so we can read back each tenant's org id.
        ev_a = _event_body()
        ev_b = _event_body()
        await _ingest(ca, (await _create_key(ca))["api_key"], ev_a)
        await _ingest(cb, (await _create_key(cb))["api_key"], ev_b)

        async with SessionFactory() as db:
            # Pick each tenant's own (non-Demo) org; a background worker may also
            # have re-inserted the broker copy under the Demo default.
            orgs_a = (
                await db.execute(select(Event.organization_id).where(
                    Event.event_id == uuid.UUID(ev_a["event_id"])))
            ).scalars().all()
            orgs_b = (
                await db.execute(select(Event.organization_id).where(
                    Event.event_id == uuid.UUID(ev_b["event_id"])))
            ).scalars().all()
            org_a = next(o for o in orgs_a if o != DEMO_ORGANIZATION_ID)
            org_b = next(o for o in orgs_b if o != DEMO_ORGANIZATION_ID)
            assert org_a != org_b

        fail_a = uuid.uuid4()
        fail_b = uuid.uuid4()
        assert await record_failure(
            {"event_id": str(fail_a), "event_type": "t", "source": "s",
             "organization_id": str(org_a)},
            error="boom", attempts=3, final_status="dead_letter",
        )
        assert await record_failure(
            {"event_id": str(fail_b), "event_type": "t", "source": "s",
             "organization_id": str(org_b)},
            error="boom", attempts=3, final_status="dead_letter",
        )

        a_fail_ids = {f["event_id"] for f in (await ca.get("/api/v1/failures?limit=100")).json()}
        b_fail_ids = {f["event_id"] for f in (await cb.get("/api/v1/failures?limit=100")).json()}
        assert str(fail_a) in a_fail_ids and str(fail_a) not in b_fail_ids
        assert str(fail_b) in b_fail_ids and str(fail_b) not in a_fail_ids


# --------------------------------------------------------------------------- #
# Unit: Redis analytics namespacing (no Postgres, no broker)                  #
# --------------------------------------------------------------------------- #
def _analytics_event(org_id, **overrides) -> dict:
    body = {
        "event_id": str(uuid.uuid4()),
        "event_type": "u.test",
        "source": "unit",
        "timestamp": datetime.now(timezone.utc),
        "organization_id": org_id,
    }
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_redis_analytics_are_namespaced_per_tenant(fake_redis):
    from app.services.analytics_service import get_metrics, record_event, reset_metrics

    await reset_metrics()
    org_a = uuid.uuid4()
    org_b = uuid.uuid4()

    # 2 events for A, 1 for B, 1 for Demo/legacy (None).
    await record_event(_analytics_event(str(org_a)))
    await record_event(_analytics_event(str(org_a)))
    await record_event(_analytics_event(str(org_b)))
    await record_event(_analytics_event(None))

    assert (await get_metrics(org_a))["total"] == 2
    assert (await get_metrics(org_b))["total"] == 1
    assert (await get_metrics())["total"] == 1, "Demo/legacy keyspace is isolated"

    # Distinct physical keys prove there is no shared counter to clobber.
    prefix = get_settings().redis_key_prefix
    assert await fake_redis.get(f"{prefix}org:{org_a}:analytics:total") == "2"
    assert await fake_redis.get(f"{prefix}org:{org_b}:analytics:total") == "1"
    assert await fake_redis.get(f"{prefix}analytics:total") == "1"
    await reset_metrics()


@pytest.mark.asyncio
async def test_redis_dedup_is_per_tenant(fake_redis):
    """Same event_id in two tenants is counted once per tenant, not deduped
    across the tenant boundary."""
    from app.services.analytics_service import get_metrics, record_event, reset_metrics

    await reset_metrics()
    org_a = uuid.uuid4()
    org_b = uuid.uuid4()
    shared_id = str(uuid.uuid4())

    await record_event(_analytics_event(str(org_a), event_id=shared_id))
    await record_event(_analytics_event(str(org_a), event_id=shared_id))  # dup within A
    await record_event(_analytics_event(str(org_b), event_id=shared_id))  # not a dup vs A

    assert (await get_metrics(org_a))["total"] == 1
    assert (await get_metrics(org_b))["total"] == 1
    await reset_metrics()


# --------------------------------------------------------------------------- #
# Unit: Kafka message org threading (no broker)                               #
# --------------------------------------------------------------------------- #
def _orm_event(org_id):
    return Event(
        event_id=uuid.uuid4(),
        organization_id=org_id,
        event_type="k.test",
        source="unit",
        timestamp=datetime.now(timezone.utc),
        user_id=None,
        request_id=None,
        payload={"a": 1},
        schema_version=1,
        created_at=datetime.now(timezone.utc),
    )


def test_kafka_roundtrip_preserves_organization_id():
    from app.kafka.serialization import deserialize_event, serialize_event

    org = uuid.uuid4()
    ev = _orm_event(org)
    out = deserialize_event(serialize_event(ev))
    assert out["organization_id"] == org
    assert out["event_id"] == ev.event_id


def test_kafka_legacy_message_without_org_deserializes_to_none():
    import json

    from app.kafka.serialization import deserialize_event

    legacy = {
        "event_id": str(uuid.uuid4()),
        "event_type": "k.test",
        "source": "unit",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {},
        "schema_version": 1,
    }
    out = deserialize_event(json.dumps(legacy).encode("utf-8"))
    assert out["organization_id"] is None



