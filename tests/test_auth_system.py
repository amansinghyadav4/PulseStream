"""Server-side authentication tests (Increment B).

Integration tests: they exercise the real app against the Dockerized Postgres
(same pattern as test_api_integration) and skip cleanly when it is unreachable.
Cover: signup, login, invalid credentials, /auth/me, logout, expired/revoked
sessions, protected routes, CSRF, rate limiting, and the password-reset flow.
The API-key ingestion path is asserted unchanged at the end.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text, update

from app.core.config import get_settings
from app.core.rate_limit import reset_rate_limits
from app.db.base import Base
from app.db.session import SessionFactory, engine
from app.models.session import Session as SessionRow


@pytest.fixture(scope="module", autouse=True)
async def database():
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("PostgreSQL unavailable; skipping auth integration tests")
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


@pytest.fixture(autouse=True)
def _reset_limits():
    reset_rate_limits()
    get_settings.cache_clear()
    yield
    reset_rate_limits()
    get_settings.cache_clear()


def _email() -> str:
    return f"user-{uuid.uuid4().hex}@example.com"


PASSWORD = "correct horse battery staple"


async def _signup(client, email=None, password=PASSWORD, full_name="Test User"):
    body = {"email": email or _email(), "password": password}
    if full_name is not None:
        body["full_name"] = full_name
    return await client.post("/api/v1/auth/signup", json=body)


async def _login(client, email, password=PASSWORD):
    return await client.post("/api/v1/auth/login", json={"email": email, "password": password})


def _csrf_header(client):
    return {"X-CSRF-Token": client.cookies.get("ps_csrf", "")}


def _set_cookies(response):
    return [v for k, v in response.headers.multi_items() if k.lower() == "set-cookie"]


@pytest.mark.asyncio
async def test_signup_creates_user_and_sets_secure_cookies(client):
    email = _email()
    r = await _signup(client, email=email)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == email
    assert body["is_active"] is True
    assert "password" not in body and "password_hash" not in body
    cookies = "\n".join(_set_cookies(r))
    assert "ps_session" in cookies and "ps_csrf" in cookies
    # Session cookie must be httpOnly; CSRF cookie must be readable by JS.
    session_line = next(c for c in _set_cookies(r) if c.startswith("ps_session"))
    csrf_line = next(c for c in _set_cookies(r) if c.startswith("ps_csrf"))
    assert "HttpOnly" in session_line
    assert "HttpOnly" not in csrf_line
    assert "SameSite=lax" in session_line.lower() or "samesite=lax" in session_line.lower()


@pytest.mark.asyncio
async def test_signup_duplicate_email_conflict(client):
    email = _email()
    assert (await _signup(client, email=email)).status_code == 201
    dup = await _signup(client, email=email)
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "email_exists"


@pytest.mark.asyncio
async def test_signup_weak_password_rejected(client):
    r = await _signup(client, email=_email(), password="short")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


@pytest.mark.asyncio
async def test_login_success_issues_session(client):
    email = _email()
    await _signup(client, email=email)
    # Drop cookies from signup auto-login so this exercises login cleanly.
    client.cookies.clear()
    r = await _login(client, email)
    assert r.status_code == 200, r.text
    assert r.json()["email"] == email
    assert "ps_session" in "\n".join(_set_cookies(r))


@pytest.mark.asyncio
async def test_login_wrong_password_rejected(client):
    email = _email()
    await _signup(client, email=email)
    client.cookies.clear()
    r = await _login(client, email, password="wrong-password-value")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_credentials"


@pytest.mark.asyncio
async def test_login_unknown_email_same_generic_error(client):
    r = await _login(client, _email())
    assert r.status_code == 401
    # Identical code/message to a wrong password (anti-enumeration).
    assert r.json()["error"]["code"] == "invalid_credentials"


@pytest.mark.asyncio
async def test_me_requires_authentication(client):
    r = await client.get("/api/v1/auth/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "not_authenticated"


@pytest.mark.asyncio
async def test_me_returns_current_user_when_authenticated(client):
    email = _email()
    await _signup(client, email=email)  # auto-login leaves cookies on the client
    r = await client.get("/api/v1/auth/me")
    assert r.status_code == 200
    assert r.json()["email"] == email


@pytest.mark.asyncio
async def test_logout_requires_csrf_token(client):
    await _signup(client, email=_email())
    # No X-CSRF-Token header -> CSRF check fails even with a valid session cookie.
    r = await client.post("/api/v1/auth/logout")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "csrf_failed"


@pytest.mark.asyncio
async def test_logout_revokes_session_and_clears_cookies(client):
    email = _email()
    await _signup(client, email=email)
    r = await client.post("/api/v1/auth/logout", headers=_csrf_header(client))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"
    # Cookie cleared (max-age=0) and the protected route now rejects.
    cleared = "\n".join(_set_cookies(r))
    assert "ps_session" in cleared
    me = await client.get("/api/v1/auth/me")
    assert me.status_code == 401


@pytest.mark.asyncio
async def test_revoked_session_token_rejected(client):
    email = _email()
    await _signup(client, email=email)
    token = client.cookies.get("ps_session")
    csrf = client.cookies.get("ps_csrf")
    # Revoke via logout.
    assert (await client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})).status_code == 200
    # Re-present the now-revoked raw token explicitly (logout cleared the jar).
    client.cookies.set("ps_session", token)
    r = await client.get("/api/v1/auth/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "not_authenticated"


@pytest.mark.asyncio
async def test_expired_session_rejected(client):
    email = _email()
    await _signup(client, email=email)
    token = client.cookies.get("ps_session")
    # Force the session to be expired directly in the DB.
    from app.core.security import hash_token

    async with SessionFactory() as db:
        await db.execute(
            update(SessionRow)
            .where(SessionRow.token_hash == hash_token(token))
            .values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        )
        await db.commit()
    r = await client.get("/api/v1/auth/me")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_password_reset_full_flow(client):
    email = _email()
    await _signup(client, email=email)
    forgot = await client.post("/api/v1/auth/forgot-password", json={"email": email})
    assert forgot.status_code == 200
    token = forgot.json()["reset_token"]
    assert token

    new_password = "a brand new passphrase 2026"
    reset = await client.post(
        "/api/v1/auth/reset-password", json={"token": token, "new_password": new_password}
    )
    assert reset.status_code == 200, reset.text

    # Pre-reset sessions were revoked → the client's cookie no longer works.
    assert (await client.get("/api/v1/auth/me")).status_code == 401
    client.cookies.clear()

    # Old password fails, new password works.
    assert (await _login(client, email, password=PASSWORD)).status_code == 401
    assert (await _login(client, email, password=new_password)).status_code == 200


@pytest.mark.asyncio
async def test_reset_token_single_use(client):
    email = _email()
    await _signup(client, email=email)
    token = (await client.post("/api/v1/auth/forgot-password", json={"email": email})).json()["reset_token"]
    pw = "another good passphrase here"
    assert (await client.post("/api/v1/auth/reset-password", json={"token": token, "new_password": pw})).status_code == 200
    again = await client.post("/api/v1/auth/reset-password", json={"token": token, "new_password": pw})
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "invalid_reset_token"


@pytest.mark.asyncio
async def test_forgot_password_unknown_email_is_generic(client):
    r = await client.post("/api/v1/auth/forgot-password", json={"email": _email()})
    assert r.status_code == 200
    assert r.json().get("reset_token") is None


@pytest.mark.asyncio
async def test_reset_with_invalid_token_rejected(client):
    r = await client.post(
        "/api/v1/auth/reset-password",
        json={"token": "not-a-real-token", "new_password": "some valid passphrase"},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_reset_token"


@pytest.mark.asyncio
async def test_login_rate_limited(client, monkeypatch):
    monkeypatch.setenv("AUTH_RATE_LIMIT_MAX", "3")
    get_settings.cache_clear()
    reset_rate_limits()
    email = _email()
    for _ in range(3):
        assert (await _login(client, email)).status_code == 401
    r = await _login(client, email)
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"


@pytest.mark.asyncio
async def test_api_key_ingestion_unaffected_by_auth(client):
    """The existing (open) event-ingestion path must keep working unchanged."""
    assert get_settings().api_key_list == []  # default: PULSESTREAM_API_KEYS empty
    event = {
        "event_id": str(uuid.uuid4()),
        "event_type": "auth.increment.check",
        "source": "auth-b-suite",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {},
        "schema_version": 1,
    }
    r = await client.post("/api/v1/events", json=event)
    assert r.status_code == 201, r.text
    assert r.json()["event_type"] == "auth.increment.check"
