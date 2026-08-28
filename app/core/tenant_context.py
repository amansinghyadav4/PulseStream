"""Read-path tenant resolution (optional authentication).

Write ingestion resolves its tenant from an API key (app/core/auth.py). Read
endpoints (`/events`, `/analytics`, `/failures`) instead resolve the tenant from
the caller's *session cookie* when present, and fall back to the reserved Demo
organization when it is absent or invalid.

This dependency NEVER raises 401: the dashboard REST reads are intentionally
public (unauthenticated callers see the Demo tenant's data, preserving existing
behavior), while an authenticated user sees ONLY their own organization's data —
the organization id is derived server-side from the session and is never read
from the client, so it cannot be used to reach another tenant.
"""
from __future__ import annotations

import uuid

from fastapi import Depends, Request, WebSocket
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import SessionFactory, get_db
from app.models.organization import DEMO_ORGANIZATION_ID
from app.services import auth_service, tenant_service


async def resolve_read_organization(
    request: Request, session: AsyncSession = Depends(get_db)
) -> uuid.UUID:
    """Organization id for a read request: the session's org, else Demo."""
    token = request.cookies.get(get_settings().session_cookie_name)
    if not token:
        return DEMO_ORGANIZATION_ID
    row = await auth_service.get_valid_session(session, token)
    if row is None:
        return DEMO_ORGANIZATION_ID
    user = await auth_service.get_user_for_session(session, row)
    if user is None:
        return DEMO_ORGANIZATION_ID
    org = await tenant_service.get_or_create_user_organization(session, user)
    return org.id


async def resolve_ws_organization(websocket: WebSocket) -> uuid.UUID | None:
    """Organization id for a WebSocket, or ``None`` when unauthenticated.

    Unlike the read path this NEVER falls back to Demo: the dashboard's live
    socket now requires a real session, so a missing/invalid cookie yields
    ``None`` and the caller closes the handshake. The org is derived only from
    the session cookie — query params, headers and any client-supplied org id
    are ignored, so a socket can never be steered onto another tenant.

    Uses its own short-lived session (WebSocket routes have no request-scoped
    ``get_db``); it opens on the caller's event loop, so no cross-loop reuse.
    """
    token = websocket.cookies.get(get_settings().session_cookie_name)
    if not token:
        return None
    async with SessionFactory() as session:
        row = await auth_service.get_valid_session(session, token)
        if row is None:
            return None
        user = await auth_service.get_user_for_session(session, row)
        if user is None:
            return None
        org = await tenant_service.get_or_create_user_organization(session, user)
        return org.id
