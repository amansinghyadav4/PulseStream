"""Google sign-in (OAuth 2.0 authorization-code flow) for PulseStream.

Design constraints, and how each is met:

* **No hardcoded secrets.** Client id/secret come from settings (environment).
  When they are absent the provider is simply reported as unavailable — there is
  no mock login path anywhere.
* **Secure state validation.** The `state` is a nonce + expiry + requested
  destination, signed with HMAC-SHA256 keyed by the client secret, and it must
  also match an httpOnly, SameSite=Lax cookie set when the flow started. A
  forged or replayed state fails both checks (constant-time comparison).
* **No open redirect.** Only the redirect URI from configuration is ever sent to
  Google, and the post-handshake destination is `frontend_base_url` plus a fixed
  route allowlist.
* **Trusted token validation.** The `id_token` is obtained by exchanging the
  code *directly with Google's token endpoint over TLS* using our client secret,
  so it cannot have been supplied by the browser. Its claims are still checked:
  issuer, audience, expiry, `email_verified` and a present email. (Signature
  verification against Google's JWKS would additionally require the
  `cryptography` dependency; the direct-exchange trust boundary is documented in
  docs/google-oauth.md as the deliberate trade-off.)
* **Safe account handling.** An existing local account with the same verified
  email is LINKED (Google has proven control of that mailbox), never silently
  duplicated; a disabled account is refused; the link is idempotent and safe
  under concurrent first-time sign-ins.
* **Session security unchanged.** The same `create_session` + cookie helpers used
  by password login are reused — no parallel session mechanism.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import security
from app.core.config import Settings
from app.models.user import User
from app.models.user_identity import UserIdentity

logger = logging.getLogger(__name__)

PROVIDER = "google"
AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
SCOPES = "openid email profile"
VALID_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
# Destinations the handshake may return to. Anything else falls back to "login".
ALLOWED_NEXT = {"login", "signup", "landing"}
HTTP_TIMEOUT_SECONDS = 10.0


# --------------------------------------------------------------------------- state


def _state_key(settings: Settings) -> bytes:
    """HMAC key derived from the client secret: high-entropy, already required
    in production, and rotated whenever the OAuth client credentials are."""
    material = f"{settings.google_oauth_client_secret}|{settings.google_oauth_client_id}"
    return hashlib.sha256(material.encode("utf-8")).digest()


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def build_state(next_route: str, settings: Settings, *, nonce: str | None = None) -> str:
    """Signed, expiring state: `<payload>.<hmac>`. The payload is not secret
    (nonce, expiry, destination) — the signature is what makes it unforgeable."""
    route = next_route if next_route in ALLOWED_NEXT else "login"
    payload = {
        "n": nonce or security.generate_token(16),
        "e": int(time.time()) + max(60, settings.google_oauth_state_ttl_seconds),
        "r": route,
    }
    body = _b64e(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(_state_key(settings), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64e(signature)}"


def parse_state(state: str, settings: Settings) -> dict | None:
    """Return the payload of a valid state, else None (bad shape, bad signature,
    or expired). Never raises on hostile input."""
    if not state or state.count(".") != 1:
        return None
    body, signature = state.split(".", 1)
    try:
        expected = hmac.new(_state_key(settings), body.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64d(signature)):
            return None
        payload = json.loads(_b64d(body).decode("utf-8"))
    except Exception:  # noqa: BLE001 — any malformed input is simply invalid
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("e"), int):
        return None
    if payload["e"] < int(time.time()):
        return None
    return payload


def authorize_url(settings: Settings, state: str) -> str:
    query = urlencode(
        {
            "client_id": settings.google_oauth_client_id,
            "redirect_uri": settings.google_oauth_redirect_uri,
            "response_type": "code",
            "scope": SCOPES,
            "state": state,
            "access_type": "online",
            "include_granted_scopes": "true",
            "prompt": "select_account",
        }
    )
    return f"{AUTHORIZE_ENDPOINT}?{query}"


# ---------------------------------------------------------------------- exchange


async def exchange_code(code: str, settings: Settings) -> dict:
    """Trade the authorization code for tokens at Google's token endpoint.
    Raises httpx.HTTPError / ValueError on failure; callers map that to a
    user-facing error code."""
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.post(
            TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": settings.google_oauth_client_id,
                "client_secret": settings.google_oauth_client_secret,
                "redirect_uri": settings.google_oauth_redirect_uri,
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
    if response.status_code != 200:
        raise ValueError(f"token endpoint returned {response.status_code}")
    payload = response.json()
    if not isinstance(payload, dict) or not payload.get("id_token"):
        raise ValueError("token response contained no id_token")
    return payload


def claims_from_id_token(id_token: str) -> dict:
    """Decode the JWT payload. The signature is not re-verified here because the
    token was received directly from Google's TLS token endpoint in exchange for
    our client secret (see module docstring); the claims are validated by
    `validate_claims` regardless."""
    parts = id_token.split(".")
    if len(parts) != 3:
        raise ValueError("malformed id_token")
    payload = json.loads(_b64d(parts[1]).decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("malformed id_token claims")
    return payload


def validate_claims(
    claims: dict, settings: Settings, *, now: int | None = None
) -> tuple[bool, str | None]:
    """(ok, error_code). Checks issuer, audience, expiry and verified email."""
    now = int(time.time()) if now is None else now
    if claims.get("iss") not in VALID_ISSUERS:
        return False, "oauth_failed"
    if claims.get("aud") != settings.google_oauth_client_id:
        return False, "oauth_failed"
    exp = claims.get("exp")
    if not isinstance(exp, int) or exp <= now:
        return False, "oauth_failed"
    if not claims.get("sub"):
        return False, "oauth_failed"
    email = (claims.get("email") or "").strip().lower()
    if not email:
        return False, "oauth_email_conflict"
    # Google reports "true"/True depending on the endpoint/version.
    verified = claims.get("email_verified")
    if verified is not True and str(verified).lower() != "true":
        return False, "oauth_email_unverified"
    return True, None


# ------------------------------------------------------------------------- users


async def _find_identity(session: AsyncSession, subject: str) -> UserIdentity | None:
    result = await session.execute(
        select(UserIdentity).where(
            UserIdentity.provider == PROVIDER, UserIdentity.subject == subject
        )
    )
    return result.scalar_one_or_none()


async def _link_identity(
    session: AsyncSession, user: User, subject: str, email: str
) -> UserIdentity:
    identity = UserIdentity(user_id=user.id, provider=PROVIDER, subject=subject, email=email)
    session.add(identity)
    await session.commit()
    return identity


async def resolve_user(
    session: AsyncSession, claims: dict
) -> tuple[User | None, str | None]:
    """Map validated Google claims onto a local user, creating or linking only
    when that is safe. Returns (user, error_code).

    Order of checks:
      1. an existing link for this Google subject  → that user (idempotent log-in)
      2. an existing local account for the email   → link + log in (Google has
         verified the mailbox, so this is the same human; documented behaviour)
      3. otherwise                                 → create the account
    """
    subject = str(claims["sub"])
    email = str(claims["email"]).strip().lower()
    full_name = claims.get("name") or None

    existing_link = await _find_identity(session, subject)
    if existing_link is not None:
        user = (
            await session.execute(select(User).where(User.id == existing_link.user_id))
        ).scalar_one_or_none()
        if user is None or not user.is_active:
            return None, "oauth_disabled_account"
        return user, None

    user = (
        await session.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()

    if user is not None:
        if not user.is_active:
            return None, "oauth_disabled_account"
        try:
            await _link_identity(session, user, subject, email)
        except IntegrityError:
            # Concurrent first sign-in for the same Google account: the other
            # request already linked it — fall through to the identity lookup.
            await session.rollback()
            await session.commit()
            if await _find_identity(session, subject) is None:
                return None, "oauth_failed"
        logger.info("google identity linked", extra={"user_id": str(user.id)})
        return user, None

    # New account. `password_hash` is NOT NULL and password login stays exactly
    # as it was, so the account is given a random, never-disclosed password hash:
    # there is no known plaintext that could authenticate against it.
    new_user = User(
        email=email,
        password_hash=security.hash_password(security.generate_token(32)),
        full_name=full_name[:255] if isinstance(full_name, str) else None,
    )
    session.add(new_user)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        user = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None or not user.is_active:
            return None, "oauth_failed"
        new_user = user
    await session.refresh(new_user)
    try:
        await _link_identity(session, new_user, subject, email)
    except IntegrityError:
        await session.rollback()
    logger.info("user created via google", extra={"user_id": str(new_user.id)})
    return new_user, None


def error_redirect(settings: Settings, code: str, next_route: str = "login") -> str:
    route = next_route if next_route in ALLOWED_NEXT else "login"
    return f"{settings.frontend_origin}/#/{route}?{urlencode({'oauth_error': code})}"


def success_redirect(settings: Settings) -> str:
    return f"{settings.frontend_origin}/#/overview"
