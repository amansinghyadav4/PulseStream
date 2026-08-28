"""Server-side authentication endpoints (Increment B).

Cookie-based, DB-backed sessions with CSRF (double-submit) and per-endpoint rate
limiting. This is the ONLY auth surface added in this increment; the API-key
event-ingestion flow (app/core/auth.py) is untouched and keeps working exactly
as before — it uses a header credential and no cookies, so CSRF does not apply.

Endpoints: signup, login, logout, me, forgot-password, reset-password.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

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
    ResetPasswordIn,
    SignupIn,
    UserOut,
)
from app.services import auth_service, tenant_service

router = APIRouter(prefix="/auth", tags=["auth"])


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
