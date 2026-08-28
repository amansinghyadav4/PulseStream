"""Tenant context: API-key credentials and user→organization resolution.

Two responsibilities, both server-side and never trusting client-supplied
organization ids:

1. **API-key lifecycle + resolution** — external producers authenticate with an
   opaque key `psk_<secret>`. Only a SHA-256 hash and a short public prefix are
   stored (the raw key is shown exactly once, at creation). Ingestion resolves a
   presented key to its owning organization by matching the prefix then verifying
   the full hash in constant time, rejecting revoked keys and stamping
   `last_used_at`.
2. **User → organization** — every authenticated human belongs to at least one
   organization (owner membership). `get_or_create_user_organization` lazily
   provisions a personal organization the first time it is needed, so users
   created before this increment (or through any path that didn't create one)
   still resolve to a stable tenant.

The reserved **Demo** organization owns the shared `PULSESTREAM_API_KEYS` flow
and all pre-tenant data; it is never auto-created here (it is seeded with the
schema).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import security
from app.models.api_credential import ApiCredential
from app.models.membership import Membership
from app.models.organization import Organization
from app.models.user import User

logger = logging.getLogger(__name__)

# Public, human-recognisable marker so a leaked key is obviously a PulseStream
# ingest key (and greppable in incident response). The secret after it is the
# high-entropy part that actually authenticates.
API_KEY_PUBLIC_PREFIX = "psk_"
# Length of the stored/public `key_prefix` slice used to locate a credential
# without exposing the secret. Long enough to be selective, short enough to be
# safe to display. Fits the String(32) column.
_KEY_PREFIX_LEN = 12


def _now() -> datetime:
    return datetime.now(timezone.utc)


def generate_api_key() -> tuple[str, str, str]:
    """Mint a new ingest key.

    Returns ``(raw_key, key_prefix, hashed_secret)``:
      * ``raw_key`` — shown to the user exactly once, never stored.
      * ``key_prefix`` — public, stored for display + lookup.
      * ``hashed_secret`` — SHA-256 of the raw key, the only persisted secret.
    """
    raw_key = API_KEY_PUBLIC_PREFIX + security.generate_token(32)
    return raw_key, raw_key[:_KEY_PREFIX_LEN], security.hash_token(raw_key)


async def resolve_api_key_to_org(
    session: AsyncSession, raw_key: str
) -> uuid.UUID | None:
    """Resolve a presented raw API key to its organization id, or None.

    Prefix lookup → constant-time hash verify → revocation check. Updates
    ``last_used_at`` on a successful match. Never logs the key or the secret.
    """
    prefix = raw_key[:_KEY_PREFIX_LEN]
    result = await session.execute(
        select(ApiCredential).where(ApiCredential.key_prefix == prefix)
    )
    candidates = result.scalars().all()
    if not candidates:
        return None

    presented_hash = security.hash_token(raw_key)
    for cred in candidates:
        # Constant-time compare even for revoked rows to avoid leaking, via
        # timing, whether a given secret exists but is revoked vs. never existed.
        matches = security.tokens_equal(presented_hash, cred.hashed_secret)
        if not matches:
            continue
        if cred.revoked_at is not None:
            logger.warning(
                "ingest rejected: revoked API key",
                extra={"key_prefix": prefix, "organization_id": str(cred.organization_id)},
            )
            return None
        cred.last_used_at = _now()
        await session.commit()
        logger.info(
            "api key resolved",
            extra={"key_prefix": prefix, "organization_id": str(cred.organization_id)},
        )
        return cred.organization_id
    return None


def _slug_for_user(user: User) -> str:
    # Deterministic and unique (user.id is unique) so a retry never collides on
    # the organizations.slug unique constraint.
    return f"org-{user.id.hex[:12]}"


def _name_for_user(user: User) -> str:
    if user.full_name and user.full_name.strip():
        return f"{user.full_name.strip()}'s Organization"
    local = user.email.split("@", 1)[0]
    return f"{local}'s Organization"


async def get_or_create_user_organization(
    session: AsyncSession, user: User
) -> Organization:
    """Return the user's primary organization, provisioning one if none exists.

    Idempotent: the earliest membership wins; on a rare concurrent create the
    IntegrityError is absorbed and the now-existing org is re-read.
    """
    org = await _first_membership_org(session, user)
    if org is not None:
        return org

    org = Organization(name=_name_for_user(user), slug=_slug_for_user(user))
    session.add(org)
    try:
        await session.flush()
        session.add(Membership(user_id=user.id, organization_id=org.id, role="owner"))
        await session.commit()
    except IntegrityError:
        await session.rollback()
        existing = await _first_membership_org(session, user)
        if existing is not None:
            return existing
        # Org row may exist (slug clash) without a membership — re-read by slug
        # and attach the missing owner membership.
        by_slug = (
            await session.execute(
                select(Organization).where(Organization.slug == _slug_for_user(user))
            )
        ).scalar_one_or_none()
        if by_slug is not None:
            session.add(
                Membership(user_id=user.id, organization_id=by_slug.id, role="owner")
            )
            await session.commit()
            return by_slug
        raise
    await session.refresh(org)
    logger.info(
        "organization provisioned",
        extra={"organization_id": str(org.id), "user_id": str(user.id)},
    )
    return org


async def _first_membership_org(
    session: AsyncSession, user: User
) -> Organization | None:
    result = await session.execute(
        select(Organization)
        .join(Membership, Membership.organization_id == Organization.id)
        .where(Membership.user_id == user.id)
        .order_by(Membership.created_at.asc(), Membership.id.asc())
        .limit(1)
    )
    return result.scalars().first()
