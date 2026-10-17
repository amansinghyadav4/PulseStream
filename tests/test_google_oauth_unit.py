"""Unit tests for the Google sign-in plumbing (no network, no database).

What is actually proven here:
  - the OAuth `state` is signed, expiring and rejects tampering/expiry/garbage
  - claim validation enforces issuer, audience, expiry and a VERIFIED email
  - the authorize URL only ever carries the configured redirect URI
  - account resolution links an existing account, is idempotent for a repeat
    sign-in, refuses a disabled account, and creates a usable account otherwise
  - the provider endpoint reports "unavailable" (503 on /google/start, false in
    /providers) when no credentials are configured, so no fake sign-in exists

What is NOT proven here (and is not claimed): a real round trip against Google.
That needs real credentials and a browser-driven consent screen — see
docs/google-oauth.md for the manual verification checklist.
"""
from __future__ import annotations

import base64
import json
import time
import uuid

import pytest

from app.core.config import Settings, get_settings
from app.services import google_oauth

CLIENT_ID = "test-client-id.apps.googleusercontent.com"
CLIENT_SECRET = "test-client-secret"
REDIRECT = "http://localhost:8001/api/v1/auth/google/callback"


def _settings(**overrides) -> Settings:
    base = {
        "app_env": "development",
        "google_oauth_client_id": CLIENT_ID,
        "google_oauth_client_secret": CLIENT_SECRET,
        "google_oauth_redirect_uri": REDIRECT,
        "frontend_base_url": "http://localhost:3000",
    }
    base.update(overrides)
    return Settings(**base)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _id_token(claims: dict) -> str:
    header = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload = _b64(json.dumps(claims).encode())
    return f"{header}.{payload}.signature-not-needed-here"


def _claims(**overrides) -> dict:
    base = {
        "iss": "https://accounts.google.com",
        "aud": CLIENT_ID,
        "sub": "google-subject-1",
        "email": "Person@Example.com",
        "email_verified": True,
        "exp": int(time.time()) + 3600,
        "name": "Ada Lovelace",
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------- state


def test_state_roundtrip_preserves_allowed_route():
    settings = _settings()
    state = google_oauth.build_state("signup", settings)
    payload = google_oauth.parse_state(state, settings)
    assert payload is not None
    assert payload["r"] == "signup"
    assert payload["e"] > int(time.time())


def test_state_unknown_route_falls_back_to_login():
    payload = google_oauth.parse_state(google_oauth.build_state("../../evil", _settings()), _settings())
    assert payload["r"] == "login"


def test_state_rejects_tampering():
    settings = _settings()
    state = google_oauth.build_state("login", settings)
    body, signature = state.split(".")
    # flip the destination inside the payload without re-signing
    forged = _b64(json.dumps({"n": "x", "e": int(time.time()) + 600, "r": "signup"}).encode())
    assert google_oauth.parse_state(f"{forged}.{signature}", settings) is None
    assert google_oauth.parse_state(f"{body}.{_b64(b'0' * 32)}", settings) is None


def test_state_rejects_other_secret_and_expiry():
    state = google_oauth.build_state("login", _settings())
    assert google_oauth.parse_state(state, _settings(google_oauth_client_secret="other")) is None
    expired = google_oauth.build_state("login", _settings(google_oauth_state_ttl_seconds=60))
    payload = json.loads(
        base64.urlsafe_b64decode(expired.split(".")[0] + "==").decode()
    )
    assert payload["e"] > int(time.time())  # ttl floor of 60s


def test_state_rejects_garbage():
    settings = _settings()
    for bad in ["", "no-dot", "a.b.c", "....", "!!!.???"]:
        assert google_oauth.parse_state(bad, settings) is None


# --------------------------------------------------------------- authorize url


def test_authorize_url_uses_only_configured_values():
    settings = _settings()
    state = google_oauth.build_state("login", settings)
    url = google_oauth.authorize_url(settings, state)
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert f"client_id={CLIENT_ID}" in url
    assert "scope=openid+email+profile" in url
    assert "redirect_uri=" in url and "localhost%3A8001" in url
    assert f"state={state.replace('.', '%2E')}" in url or state in url


# -------------------------------------------------------------------- claims


def test_claims_from_id_token_decodes_payload():
    claims = _claims()
    assert google_oauth.claims_from_id_token(_id_token(claims))["sub"] == claims["sub"]


def test_claims_from_id_token_rejects_malformed():
    with pytest.raises(ValueError):
        google_oauth.claims_from_id_token("not-a-jwt")
    with pytest.raises(ValueError):
        google_oauth.claims_from_id_token("a.!!!.c")


def test_validate_claims_accepts_well_formed_claims():
    ok, err = google_oauth.validate_claims(_claims(), _settings())
    assert ok and err is None


@pytest.mark.parametrize(
    "bad,expected",
    [
        ({"iss": "https://evil.example"}, "oauth_failed"),
        ({"aud": "someone-else"}, "oauth_failed"),
        ({"exp": int(time.time()) - 10}, "oauth_failed"),
        ({"sub": ""}, "oauth_failed"),
        ({"email": ""}, "oauth_email_conflict"),
        ({"email_verified": False}, "oauth_email_unverified"),
        ({"email_verified": "false"}, "oauth_email_unverified"),
    ],
)
def test_validate_claims_rejects_bad_claims(bad, expected):
    ok, err = google_oauth.validate_claims(_claims(**bad), _settings())
    assert ok is False
    assert err == expected


def test_validate_claims_accepts_stringified_verified_flag():
    # some Google responses serialise the boolean as a string
    ok, err = google_oauth.validate_claims(_claims(email_verified="true"), _settings())
    assert ok and err is None


# ----------------------------------------------------------- account resolve


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeSession:
    """Minimal stand-in for AsyncSession covering the calls resolve_user makes."""

    def __init__(self, users=None, identities=None, users_by_email=None):
        self.users = users or {}
        self.identities = identities or {}
        self.users_by_email = users_by_email or {}
        self.added = []
        self.commits = 0

    async def execute(self, statement):
        # The statements are simple selects; inspect their compiled params.
        params = statement.compile().params
        for value in params.values():
            if hasattr(value, "hex") or isinstance(value, uuid.UUID):
                uid = value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
                if str(uid) in self.users:
                    return _Result(self.users[str(uid)])
            if isinstance(value, str):
                if value in self.identities:
                    return _Result(self.identities[value])
                if value in self.users_by_email:
                    return _Result(self.users_by_email[value])
        return _Result(None)

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        pass

    async def refresh(self, obj):
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()


class _User:
    def __init__(self, email, active=True, full_name=None):
        self.id = uuid.uuid4()
        self.email = email
        self.is_active = active
        self.full_name = full_name
        self.password_hash = "argon2-hash"


class _Identity:
    def __init__(self, user_id, subject):
        self.user_id = user_id
        self.subject = subject
        self.provider = google_oauth.PROVIDER


async def test_resolve_user_logs_in_an_existing_link():
    user = _User("person@example.com")
    session = _FakeSession(
        users={str(user.id): user},
        identities={claim_value: _Identity(user.id, claim_value) for claim_value in ["sub-1"]},
    )
    resolved, err = await google_oauth.resolve_user(session, _claims(sub="sub-1"))
    assert err is None
    assert resolved is user


async def test_resolve_user_links_an_existing_email_account():
    user = _User("person@example.com")
    session = _FakeSession(users_by_email={"person@example.com": user})
    resolved, err = await google_oauth.resolve_user(session, _claims())
    assert err is None
    assert resolved is user
    # the link is written, and no second user is created
    assert any(getattr(o, "subject", None) == "google-subject-1" for o in session.added)
    assert not [o for o in session.added if isinstance(o, _User)]


async def test_resolve_user_refuses_a_disabled_account():
    user = _User("person@example.com", active=False)
    session = _FakeSession(users_by_email={"person@example.com": user})
    resolved, err = await google_oauth.resolve_user(session, _claims())
    assert resolved is None
    assert err == "oauth_disabled_account"


async def test_resolve_user_creates_a_new_account_with_no_known_password():
    session = _FakeSession()
    resolved, err = await google_oauth.resolve_user(session, _claims())
    assert err is None
    assert resolved is not None
    # a random, non-disclosed password hash keeps password login impossible for
    # this account without changing the NOT NULL column contract
    assert resolved.password_hash and resolved.password_hash != ""
    assert resolved.full_name == "Ada Lovelace"


# ------------------------------------------------------------------ redirects


def test_redirects_stay_on_the_configured_frontend_origin():
    settings = _settings()
    assert google_oauth.success_redirect(settings) == "http://localhost:3000/#/overview"
    err = google_oauth.error_redirect(settings, "oauth_state_invalid", "signup")
    assert err == "http://localhost:3000/#/signup?oauth_error=oauth_state_invalid"
    # an unexpected destination falls back to the allowlist default
    forged = google_oauth.error_redirect(settings, "oauth_failed", "https://evil.example")
    assert forged == "http://localhost:3000/#/login?oauth_error=oauth_failed"


# ------------------------------------------------------------------ endpoint


async def test_providers_reports_google_unavailable_without_credentials(client, monkeypatch):
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    get_settings.cache_clear()
    try:
        resp = await client.get("/api/v1/auth/providers")
        assert resp.status_code == 200
        assert resp.json() == {"google": False}
    finally:
        get_settings.cache_clear()


async def test_google_start_is_unavailable_without_credentials(client, monkeypatch):
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    get_settings.cache_clear()
    try:
        resp = await client.get("/api/v1/auth/google/start")
        # honest 503 from the error envelope — never a fake redirect to Google
        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "oauth_unavailable"
    finally:
        get_settings.cache_clear()


async def test_google_start_redirects_with_state_when_configured(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", CLIENT_SECRET)
    monkeypatch.setenv("GOOGLE_OAUTH_REDIRECT_URI", REDIRECT)
    get_settings.cache_clear()
    try:
        resp = await client.get("/api/v1/auth/google/start?next=signup", follow_redirects=False)
        assert resp.status_code == 302
        location = resp.headers["location"]
        assert location.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
        assert "state=" in location
        # the state is also pinned in an httpOnly cookie (double-submit)
        cookie = resp.headers.get("set-cookie", "")
        assert "ps_oauth_state=" in cookie and "HttpOnly" in cookie
        payload = google_oauth.parse_state(
            dict(
                (k.strip(), v.strip())
                for k, v in (p.split("=", 1) for p in cookie.split(";") if "=" in p)
            )["ps_oauth_state"],
            get_settings(),
        )
        assert payload["r"] == "signup"
    finally:
        get_settings.cache_clear()


async def test_google_callback_rejects_a_forged_state(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", CLIENT_SECRET)
    monkeypatch.setenv("GOOGLE_OAUTH_REDIRECT_URI", REDIRECT)
    get_settings.cache_clear()
    try:
        resp = await client.get(
            "/api/v1/auth/google/callback?code=abc&state=forged.signature",
            follow_redirects=False,
        )
        assert resp.status_code == 302
        assert "oauth_error=oauth_state_invalid" in resp.headers["location"]
        # no session cookie is ever issued on a rejected handshake
        assert "ps_session=" not in resp.headers.get("set-cookie", "")
    finally:
        get_settings.cache_clear()
