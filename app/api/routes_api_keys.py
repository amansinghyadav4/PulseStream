"""API-key lifecycle endpoints (Increment C, backend only).

Authenticated humans manage their organization's ingest credentials here. Every
route resolves the caller's organization SERVER-SIDE from the session cookie
(never from the client) via ``get_or_create_user_organization`` and scopes all
work to that tenant, so one org can never see or revoke another's keys.

Mutating routes require CSRF (double-submit) exactly like the other cookie-auth
endpoints. The raw secret is returned only once, from POST "".
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes_auth import get_current_user
from app.core.csrf import require_csrf
from app.core.errors import DomainError
from app.db.session import get_db
from app.models.api_credential import ApiCredential
from app.models.user import User
from app.schemas.api_key import ApiKeyCreatedOut, ApiKeyCreateIn, ApiKeyOut
from app.services import tenant_service

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


@router.post("", response_model=ApiKeyCreatedOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_csrf)])
async def create_api_key(
    body: ApiKeyCreateIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> ApiKeyCreatedOut:
    org = await tenant_service.get_or_create_user_organization(session, user)
    raw_key, key_prefix, hashed_secret = tenant_service.generate_api_key()
    cred = ApiCredential(
        organization_id=org.id,
        name=body.name,
        key_prefix=key_prefix,
        hashed_secret=hashed_secret,
        created_by_user_id=user.id,
    )
    session.add(cred)
    await session.commit()
    await session.refresh(cred)
    # The ONLY time the raw key leaves the server. It is not stored anywhere.
    out = ApiKeyOut.model_validate(cred).model_dump()
    return ApiKeyCreatedOut(**out, api_key=raw_key)


@router.get("", response_model=list[ApiKeyOut])
async def list_api_keys(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[ApiKeyOut]:
    org = await tenant_service.get_or_create_user_organization(session, user)
    result = await session.execute(
        select(ApiCredential)
        .where(ApiCredential.organization_id == org.id)
        .order_by(ApiCredential.created_at.desc(), ApiCredential.id.desc())
    )
    return [ApiKeyOut.model_validate(c) for c in result.scalars().all()]


@router.post("/{key_id}/revoke", response_model=ApiKeyOut,
             dependencies=[Depends(require_csrf)])
async def revoke_api_key(
    key_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> ApiKeyOut:
    org = await tenant_service.get_or_create_user_organization(session, user)
    # Scope the lookup to the caller's org: a key belonging to another tenant is
    # indistinguishable from a nonexistent one (404, no cross-tenant signal).
    cred = (
        await session.execute(
            select(ApiCredential).where(
                ApiCredential.id == key_id,
                ApiCredential.organization_id == org.id,
            )
        )
    ).scalar_one_or_none()
    if cred is None:
        raise DomainError(status_code=404, code="api_key_not_found", message="API key not found")
    if cred.revoked_at is None:
        cred.revoked_at = tenant_service._now()
        await session.commit()
        await session.refresh(cred)
    return ApiKeyOut.model_validate(cred)
