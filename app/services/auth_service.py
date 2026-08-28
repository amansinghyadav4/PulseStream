"""Authentication domain logic: users, sessions, password reset.

Kept separate from the HTTP layer (routes_auth) so the rules — hashing, session
lifetime/revocation, anti-enumeration — live in one place and are unit-testable
without a request. All timestamps are timezone-aware UTC to match the
`DateTime(timezone=True)` columns.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import security
from app.models.password_reset import PasswordResetToken
from app.models.session import Session
from app.models.user import User

logger = logging.getLogger(__name__)

# Precomputed once, lazily: a valid Argon2 hash of a random string. Verifying a
# login for a non-existent email against this keeps response timing similar to a
# real-user miss, blunting username-enumeration by timing.
_DUMMY_HASH: str | None = None


def _dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = security.hash_password(security.generate_token(16))
    return _DUMMY_HASH


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_email(email: str) -> str:
    return email.strip().lower()


class EmailAlreadyRegisteredError(Exception):
    pass


async def get_user_by_email(session: AsyncSession, email: str) -> User | None:
    result = await session.execute(select(User).where(User.email == _normalize_email(email)))
    return result.scalar_one_or_none()


async def create_user(
    session: AsyncSession, *, email: str, password: str, full_name: str | None
) -> User:
    user = User(
        email=_normalize_email(email),
        password_hash=security.hash_password(password),
        full_name=full_name,
    )
    session.add(user)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise EmailAlreadyRegisteredError from None
    await session.refresh(user)
    logger.info("user created", extra={"user_id": str(user.id)})
    return user


async def authenticate(session: AsyncSession, *, email: str, password: str) -> User | None:
    """Return the user on valid credentials, else None. Runs a dummy verify when
    the email is unknown so timing doesn't reveal account existence."""
    user = await get_user_by_email(session, email)
    if user is None:
        security.verify_password(_dummy_hash(), password)
        return None
    if not user.is_active:
        return None
    if not security.verify_password(user.password_hash, password):
        return None
    # Opportunistic upgrade if Argon2 parameters have since strengthened.
    if security.needs_rehash(user.password_hash):
        user.password_hash = security.hash_password(password)
        await session.commit()
    return user


async def create_session(
    session: AsyncSession,
    *,
    user: User,
    ttl_seconds: int,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> tuple[Session, str]:
    """Create a DB-backed session. Returns (row, raw_token). Only the token hash
    is stored; the caller puts the raw token in the httpOnly cookie."""
    raw_token = security.generate_token(32)
    row = Session(
        user_id=user.id,
        token_hash=security.hash_token(raw_token),
        expires_at=_now() + timedelta(seconds=ttl_seconds),
        user_agent=(user_agent or None) and user_agent[:512],
        ip_address=ip_address,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    logger.info("session created", extra={"user_id": str(user.id), "session_id": str(row.id)})
    return row, raw_token


async def get_valid_session(session: AsyncSession, raw_token: str) -> Session | None:
    """Resolve a raw session token to a live (unexpired, unrevoked) session."""
    token_hash = security.hash_token(raw_token)
    result = await session.execute(select(Session).where(Session.token_hash == token_hash))
    row = result.scalar_one_or_none()
    if row is None:
        return None
    if row.revoked_at is not None:
        return None
    if row.expires_at <= _now():
        return None
    return row


async def get_user_for_session(session: AsyncSession, row: Session) -> User | None:
    result = await session.execute(select(User).where(User.id == row.user_id))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        return None
    return user


async def revoke_session(session: AsyncSession, row: Session) -> None:
    if row.revoked_at is None:
        row.revoked_at = _now()
        await session.commit()
    logger.info("session revoked", extra={"session_id": str(row.id)})


async def revoke_all_user_sessions(session: AsyncSession, user_id) -> None:
    await session.execute(
        update(Session)
        .where(Session.user_id == user_id, Session.revoked_at.is_(None))
        .values(revoked_at=_now())
    )
    await session.commit()


async def create_password_reset_token(
    session: AsyncSession, *, user: User, ttl_seconds: int
) -> str:
    raw_token = security.generate_token(32)
    row = PasswordResetToken(
        user_id=user.id,
        token_hash=security.hash_token(raw_token),
        expires_at=_now() + timedelta(seconds=ttl_seconds),
    )
    session.add(row)
    await session.commit()
    logger.info("password reset requested", extra={"user_id": str(user.id)})
    return raw_token


async def reset_password(session: AsyncSession, *, raw_token: str, new_password: str) -> bool:
    """Consume a reset token and set a new password. Returns False if the token
    is unknown, already used, or expired. On success, revokes all sessions."""
    token_hash = security.hash_token(raw_token)
    result = await session.execute(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == token_hash)
    )
    row = result.scalar_one_or_none()
    if row is None or row.used_at is not None or row.expires_at <= _now():
        return False

    user = (
        await session.execute(select(User).where(User.id == row.user_id))
    ).scalar_one_or_none()
    if user is None:
        return False

    user.password_hash = security.hash_password(new_password)
    row.used_at = _now()
    await session.commit()
    # Force re-authentication everywhere after a credential change.
    await revoke_all_user_sessions(session, user.id)
    logger.info("password reset completed", extra={"user_id": str(user.id)})
    return True
