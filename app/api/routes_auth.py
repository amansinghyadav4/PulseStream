"""Server-side authentication endpoints (Increment B).

Cookie-based, DB-backed sessions with CSRF (double-submit) and per-endpoint rate
limiting. This is the ONLY auth surface added in this increment; the API-key
event-ingestion flow (app/core/auth.py) is untouched and keeps working exactly
as before — it uses a header credential and no cookies, so CSRF does not apply.

Endpoints: signup, login, logout, me, forgot-password, reset-password.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import security
from app.core.config import get_settings
from app.core.csrf import new_csrf_token, require_csrf
from app.core.errors import DomainError
from app.core.rate_limit import rate_limit
from app.db.session import get_db
from app.models.session import Session as SessionRow
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordIn,
    LoginIn,
    MeOut,
    MessageOut,
    OrganizationOut,
    ProvidersOut,
    ResetPasswordIn,
    SignupIn,
    UserOut,
)
from app.services import auth_service, google_oauth, tenant_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Short-lived, httpOnly state cookie for the Google handshake. Path-scoped to
# the OAuth endpoints so it is never sent with ordinary API traffic.
OAUTH_STATE_COOKIE = "ps_oauth_state"
OAUTH_COOKIE_PATH = "/api/v1/auth/google"


def _set_session_cookies(response: Response, session_token: str, csrf_value: str) -> None:
    settings = get_settings()
    common = {
        "max_age": settings.session_ttl_seconds,
        "secure": settings.session_cookie_secure_effective,
        "samesite": settings.session_cookie_samesite,
        "domain": settings.session_cookie_domain,
        "path": "/",
    }
    # Session token: httpOnly so JS can never read it (XSS can't exfiltrate it).
    response.set_cookie(settings.session_cookie_name, session_token, httponly=True, **common)
    # CSRF token: readable by JS so the SPA can echo it back in the header.
    response.set_cookie(settings.csrf_cookie_name, csrf_value, httponly=False, **common)


def _clear_session_cookies(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(settings.session_cookie_name, path="/", domain=settings.session_cookie_domain)
    response.delete_cookie(settings.csrf_cookie_name, path="/", domain=settings.session_cookie_domain)


def _unauthorized() -> DomainError:
    return DomainError(status_code=401, code="not_authenticated", message="authentication required")


async def get_current_context(
    request: Request, session: AsyncSession = Depends(get_db)
) -> tuple[SessionRow, User]:
    """Protected-route dependency: resolve the session cookie to a live session
    and its active user, or raise 401. Depends(get_db) is request-cached, so the
    same session is shared with the route handler."""
    token = request.cookies.get(get_settings().session_cookie_name)
    if not token:
        raise _unauthorized()
    row = await auth_service.get_valid_session(session, token)
    if row is None:
        raise _unauthorized()
    user = await auth_service.get_user_for_session(session, row)
    if user is None:
        raise _unauthorized()
    return row, user


async def get_current_user(
    ctx: tuple[SessionRow, User] = Depends(get_current_context),
) -> User:
    return ctx[1]


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


@router.post("/signup", response_model=UserOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(rate_limit("signup"))])
async def signup(
    body: SignupIn, request: Request, response: Response, session: AsyncSession = Depends(get_db)
) -> UserOut:
    try:
        user = await auth_service.create_user(
            session, email=body.email, password=body.password, full_name=body.full_name
        )
    except auth_service.EmailAlreadyRegisteredError:
        raise DomainError(
            status_code=status.HTTP_409_CONFLICT,
            code="email_exists",
            message="an account with this email already exists",
        ) from None
    # Auto-login: issue a session so the new account is immediately usable.
    _, raw_token = await auth_service.create_session(
        session, user=user, ttl_seconds=get_settings().session_ttl_seconds,
        user_agent=request.headers.get("user-agent"), ip_address=_client_ip(request),
    )
    _set_session_cookies(response, raw_token, new_csrf_token())
    return UserOut.model_validate(user)


@router.post("/login", response_model=UserOut, dependencies=[Depends(rate_limit("login"))])
async def login(
    body: LoginIn, request: Request, response: Response, session: AsyncSession = Depends(get_db)
) -> UserOut:
    user = await auth_service.authenticate(session, email=body.email, password=body.password)
    if user is None:
        # Generic message — never reveal whether the email exists or the password
        # was wrong or the account is inactive (anti-enumeration).
        raise DomainError(
            status_code=401, code="invalid_credentials", message="invalid email or password"
        )
    _, raw_token = await auth_service.create_session(
        session, user=user, ttl_seconds=get_settings().session_ttl_seconds,
        user_agent=request.headers.get("user-agent"), ip_address=_client_ip(request),
    )
    _set_session_cookies(response, raw_token, new_csrf_token())
    return UserOut.model_validate(user)


@router.post("/logout", response_model=MessageOut, dependencies=[Depends(require_csrf)])
async def logout(
    response: Response,
    ctx: tuple[SessionRow, User] = Depends(get_current_context),
    session: AsyncSession = Depends(get_db),
) -> MessageOut:
    row, _user = ctx
    await auth_service.revoke_session(session, row)
    _clear_session_cookies(response)
    return MessageOut(message="logged out")


@router.get("/me", response_model=MeOut)
async def me(
    ctx: tuple[SessionRow, User] = Depends(get_current_context),
    session: AsyncSession = Depends(get_db),
) -> MeOut:
    _row, user = ctx
    # Resolve (provisioning if necessary) the user's primary organization so the
    # dashboard shell can label the authenticated workspace. Org is derived
    # server-side from the session — never from client-supplied state.
    org = await tenant_service.get_or_create_user_organization(session, user)
    return MeOut(
        **UserOut.model_validate(user).model_dump(),
        organization=OrganizationOut.model_validate(org),
    )


@router.post("/forgot-password", response_model=MessageOut,
             dependencies=[Depends(rate_limit("forgot"))])
async def forgot_password(
    body: ForgotPasswordIn, session: AsyncSession = Depends(get_db)
) -> MessageOut:
    settings = get_settings()
    generic = MessageOut(
        message="if an account exists for that email, a reset link has been sent"
    )
    user = await auth_service.get_user_by_email(session, body.email)
    if user is None or not user.is_active:
        return generic  # identical response whether or not the account exists
    raw_token = await auth_service.create_password_reset_token(
        session, user=user, ttl_seconds=settings.password_reset_ttl_seconds
    )
    # Production delivers this by email (out of scope for this increment). In
    # non-production we surface the token so the flow is testable end-to-end.
    if settings.app_env != "production":
        generic.reset_token = raw_token
    return generic


@router.post("/reset-password", response_model=MessageOut,
             dependencies=[Depends(rate_limit("reset"))])
async def reset_password(
    body: ResetPasswordIn, session: AsyncSession = Depends(get_db)
) -> MessageOut:
    ok = await auth_service.reset_password(
        session, raw_token=body.token, new_password=body.new_password
    )
    if not ok:
        raise DomainError(
            status_code=400, code="invalid_reset_token",
            message="reset token is invalid or has expired",
        )
    return MessageOut(message="password has been reset")


# ---------------------------------------------------------------------------
# Optional OAuth provider (Google). Additive: password signup/login above are
# untouched, and the whole surface stays dark unless credentials are configured.
# ---------------------------------------------------------------------------


@router.get("/providers", response_model=ProvidersOut)
async def providers() -> ProvidersOut:
    """Report which optional sign-in providers are configured. Unauthenticated
    and side-effect free: the SPA uses it to decide whether to render a Google
    button at all, so an unconfigured deployment never shows a dead button."""
    return ProvidersOut(google=get_settings().google_oauth_enabled)


def _clear_oauth_state(response: Response) -> None:
    response.delete_cookie(OAUTH_STATE_COOKIE, path=OAUTH_COOKIE_PATH)


def _oauth_unavailable() -> DomainError:
    return DomainError(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        code="oauth_unavailable",
        message="Google sign-in is not configured on this deployment",
    )


def _oauth_redirect(code: str, next_route: str = "login") -> RedirectResponse:
    response = RedirectResponse(url=google_oauth.error_redirect(get_settings(), code, next_route), status_code=302)
    _clear_oauth_state(response)
    return response


@router.get("/google/start", dependencies=[Depends(rate_limit("google_start"))])
async def google_start(next: str = Query(default="login")) -> RedirectResponse:
    """Begin the Google handshake: set the signed state cookie and send the
    browser to Google. Only the configured redirect URI is ever used."""
    settings = get_settings()
    if not settings.google_oauth_enabled or not settings.google_oauth_redirect_uri_valid:
        raise _oauth_unavailable()
    state = google_oauth.build_state(next, settings)
    response = RedirectResponse(url=google_oauth.authorize_url(settings, state), status_code=302)
    response.set_cookie(
        OAUTH_STATE_COOKIE,
        state,
        max_age=max(60, settings.google_oauth_state_ttl_seconds),
        httponly=True,
        secure=settings.session_cookie_secure_effective,
        samesite="lax",  # sent on Google's top-level redirect back to us
        path=OAUTH_COOKIE_PATH,
    )
    return response


@router.get("/google/callback")
async def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Complete the Google handshake. Any failure redirects back to the SPA with
    an `oauth_error` code and NO session — a failed sign-in never half-succeeds."""
    settings = get_settings()
    if not settings.google_oauth_enabled or not settings.google_oauth_redirect_uri_valid:
        raise _oauth_unavailable()

    payload = google_oauth.parse_state(state or "", settings)
    next_route = str((payload or {}).get("r") or "login")

    if error:
        logger.info("google sign-in cancelled", extra={"provider": "google"})
        return _oauth_redirect("oauth_failed", next_route)

    # State must be signed, unexpired AND identical to the cookie we set.
    cookie_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if payload is None or not cookie_state or not security.tokens_equal(cookie_state, state or ""):
        logger.warning("google sign-in rejected: invalid state")
        return _oauth_redirect("oauth_state_invalid", next_route)

    if not code:
        return _oauth_redirect("oauth_failed", next_route)

    try:
        tokens = await google_oauth.exchange_code(code, settings)
        claims = google_oauth.claims_from_id_token(tokens["id_token"])
    except Exception:  # noqa: BLE001 — any transport/parse failure is the same outcome
        logger.warning("google token exchange failed", exc_info=True)
        return _oauth_redirect("oauth_exchange_failed", next_route)

    ok, error_code = google_oauth.validate_claims(claims, settings)
    if not ok:
        return _oauth_redirect(error_code or "oauth_failed", next_route)

    user, error_code = await google_oauth.resolve_user(session, claims)
    if user is None:
        return _oauth_redirect(error_code or "oauth_failed", next_route)

    # Same session mechanism as password login — cookie + CSRF, nothing new.
    _, raw_token = await auth_service.create_session(
        session, user=user, ttl_seconds=settings.session_ttl_seconds,
        user_agent=request.headers.get("user-agent"), ip_address=_client_ip(request),
    )
    response = RedirectResponse(url=google_oauth.success_redirect(settings), status_code=302)
    _clear_oauth_state(response)
    _set_session_cookies(response, raw_token, new_csrf_token())
    return response
