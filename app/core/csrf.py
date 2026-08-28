"""CSRF protection for cookie-authenticated, state-changing requests.

Why this exists: session auth rides an httpOnly cookie the browser attaches
automatically, which is exactly what makes it forgeable cross-site. The API-key
ingestion path is unaffected — it authenticates with a custom `X-API-Key` header
(never auto-sent cross-origin) and no cookie, so it is inherently CSRF-safe and
this dependency is deliberately NOT applied to it.

Mechanism: double-submit token. At session creation we set a NON-httpOnly
`csrf` cookie holding a random token; the browser JS reads it and echoes it in
the `X-CSRF-Token` header on every state-changing (POST/PUT/PATCH/DELETE)
authenticated request. An attacker's cross-site page can cause the cookie to be
sent but cannot read it to populate the header (same-origin policy), so the
values won't match. Comparison is constant-time.
"""
from __future__ import annotations

from fastapi import Request

from app.core.config import get_settings
from app.core.errors import DomainError
from app.core.security import generate_token, tokens_equal


def new_csrf_token() -> str:
    return generate_token(32)


async def require_csrf(request: Request) -> None:
    """Reject state-changing requests whose CSRF header/cookie don't match.

    Safe methods (GET/HEAD/OPTIONS) are never challenged."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    settings = get_settings()
    cookie_token = request.cookies.get(settings.csrf_cookie_name)
    header_token = request.headers.get(settings.csrf_header_name)
    if not cookie_token or not header_token or not tokens_equal(cookie_token, header_token):
        raise DomainError(
            status_code=403,
            code="csrf_failed",
            message="missing or invalid CSRF token",
        )
