"""API-key authentication tests for event ingestion.

Auth semantics: PULSESTREAM_API_KEYS empty => disabled (all legacy behavior);
set => POST /events and POST /events/batch require X-API-Key. Reads, health,
readiness, metrics and WebSocket stay public by design.

Uses the shared async httpx ASGI `client` fixture so the SQLAlchemy engine
lives on a single stable event loop (sync TestClient portals would create
cross-loop connection issues on Windows Proactor).
"""
import uuid
from datetime import datetime, timezone

import pytest

from app.core.config import get_settings

DEV_KEY = "ps_test_key_12345"


@pytest.fixture
def auth_on(monkeypatch):
    """Enable auth with one test key for the duration of a test."""
    monkeypatch.setenv("PULSESTREAM_API_KEYS", DEV_KEY)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _event_body(**overrides) -> dict:
    body = {
        "event_id": str(uuid.uuid4()),
        "event_type": "auth.test",
        "source": "auth-suite",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {},
        "schema_version": 1,
    }
    body.update(overrides)
    return body


async def _post(client, headers: dict | None = None, body: dict | None = None):
    return await client.post("/api/v1/events", json=body or _event_body(), headers=headers or {})


@pytest.mark.asyncio
async def test_valid_key_accepted(client, auth_on):
    r = await _post(client, headers={"X-API-Key": DEV_KEY})
    assert r.status_code == 201, r.text
    assert r.json()["event_type"] == "auth.test"


@pytest.mark.asyncio
async def test_missing_key_rejected_401_envelope(client, auth_on):
    r = await _post(client)
    assert r.status_code == 401
    err = r.json()["error"]
    assert err["code"] == "missing_api_key"
    assert "X-API-Key" in err["message"]


@pytest.mark.asyncio
async def test_invalid_key_rejected_and_never_echoed_or_logged(client, auth_on, caplog):
    presented = "ps_wrong_key_99999"
    r = await _post(client, headers={"X-API-Key": presented})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_api_key"
    assert presented not in r.text
    combined = caplog.text
    assert presented not in combined


@pytest.mark.asyncio
async def test_malformed_key_rejected(client, auth_on):
    # present-but-empty header behaves like absent credentials
    r = await _post(client, headers={"X-API-Key": ""})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "missing_api_key"
    for bad in ("   ", "short", "PS_TEST_KEY_12345", f"{DEV_KEY} extra"):
        r = await _post(client, headers={"X-API-Key": bad})
        assert r.status_code == 401, f"key {bad!r} should be rejected"
        assert r.json()["error"]["code"] in ("invalid_api_key", "malformed_api_key")


@pytest.mark.asyncio
async def test_batch_endpoint_also_protected(client, auth_on):
    payload = {"events": [_event_body(), _event_body()]}
    no_key = await client.post("/api/v1/events/batch", json=payload)
    assert no_key.status_code == 401
    ok = await client.post("/api/v1/events/batch", json=payload, headers={"X-API-Key": DEV_KEY})
    assert ok.status_code == 201
    assert len(ok.json()) == 2


@pytest.mark.asyncio
async def test_valid_key_with_invalid_payload_still_validation_error(client, auth_on):
    """Auth success must NOT mask payload validation; 422 stays 422."""
    r = await _post(
        client,
        headers={"X-API-Key": DEV_KEY},
        body=_event_body(event_type="INVALID TYPE!!"),
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


@pytest.mark.asyncio
async def test_auth_failure_never_reaches_kafka(client, auth_on, monkeypatch):
    from app.services import kafka_publisher

    spy = AsyncMock()
    monkeypatch.setattr(kafka_publisher.publisher, "publish_event", spy)
    await _post(client, headers={"X-API-Key": "wrong-key"})
    spy.assert_not_awaited()
    # valid key DOES reach the publish path (proves the spy was wired correctly)
    await _post(client, headers={"X-API-Key": DEV_KEY})
    spy.assert_awaited_once()


from unittest.mock import AsyncMock  # noqa: E402


@pytest.mark.asyncio
async def test_auth_failure_does_not_create_database_records(client, auth_on):
    """A rejected event must never appear in the event store (verified through
    the public list endpoint — no direct engine access inside the test)."""
    before = {e["event_id"] for e in (await client.get("/api/v1/events?limit=100")).json()}
    rejected = _event_body(source="auth-suite")
    r = await client.post("/api/v1/events", json=rejected, headers={"X-API-Key": "wrong-key"})
    assert r.status_code == 401
    after = {e["event_id"] for e in (await client.get("/api/v1/events?limit=100")).json()}
    assert rejected["event_id"] not in after
    assert not (after - before), "rejected events must not be persisted"


@pytest.mark.asyncio
async def test_auth_failure_does_not_update_analytics(client, auth_on, fake_redis):
    from app.services.analytics_service import get_metrics, reset_metrics

    await reset_metrics()
    r = await _post(client, headers={"X-API-Key": "nope"})
    assert r.status_code == 401
    metrics = await get_metrics()
    assert metrics["total"] == 0, "rejected event must not touch analytics"
    await reset_metrics()


@pytest.mark.asyncio
async def test_public_endpoints_remain_usable_while_auth_on(client, auth_on):
    assert (await client.get("/health")).status_code == 200
    assert (await client.get("/api/v1/health")).status_code == 200
    ready = await client.get("/ready")
    assert ready.status_code != 401  # readiness state depends on deps, not auth
    assert (await client.get("/metrics")).status_code == 200
    assert (await client.get("/analytics")).status_code == 200
    assert (await client.get("/api/v1/analytics")).status_code == 200
    # dashboard REST reads stay public
    assert (await client.get("/api/v1/events")).status_code == 200


@pytest.mark.asyncio
async def test_auth_disabled_by_default_backwards_compatible(client, monkeypatch):
    """Empty configuration = open ingestion (existing behavior preserved)."""
    monkeypatch.delenv("PULSESTREAM_API_KEYS", raising=False)
    get_settings.cache_clear()
    try:
        r = await _post(client)  # no key at all
        assert r.status_code == 201
    finally:
        get_settings.cache_clear()
