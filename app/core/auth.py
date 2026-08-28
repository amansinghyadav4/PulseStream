"""API-key authentication + tenant resolution for external event ingestion.

Design:
- The dependency RESOLVES a presented credential to the owning organization id
  and RETURNS it, so ingestion can stamp every event with its tenant server-side.
- Two credential sources, checked in order:
    1. Shared configuration keys (PULSESTREAM_API_KEYS, comma-separated) map to
       the reserved **Demo** organization — this preserves the existing shared-key
       / Simulator / Demo Store behavior byte-for-byte.
    2. Otherwise a DB-backed, organization-owned `api_credentials` row (prefix
       lookup + constant-time hash verify + revocation check), resolving to that
       row's organization.
- An EMPTY configuration with NO key presented disables auth and resolves to the
  Demo org (local development / existing open deployments keep working).
- Comparison is constant-time; failures raise the project-wide DomainError
  envelope, never echo the presented key, and log only safe metadata.
- Applied ONLY to event-ingestion (write) endpoints. Reads resolve their tenant
  separately (optional session auth, Demo fallback) — see tenant_context.py.
"""
from __future__ import annotations

import logging
import secrets
import uuid

from fastapi import Depends, Security
from fastapi.security import APIKeyHeader
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import DomainError
from app.db.session import get_db
from app.models.organization import DEMO_ORGANIZATION_ID
from app.services import tenant_service

logger = logging.getLogger(__name__)

# auto_error=False: a MISSING header becomes our own 401 envelope instead of
# FastAPI's generic 403, keeping every error response shape consistent.
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def _reject(code: str, message: str) -> DomainError:
    # Uses the project-wide structured envelope; no WWW-Authenticate challenge
    # header because DomainError responses are uniform JSON envelopes.
    return DomainError(status_code=401, code=code, message=message)


async def require_ingest_api_key(
    api_key: str | None = Security(_api_key_header),
    session: AsyncSession = Depends(get_db),
) -> uuid.UUID:
    """Resolve the ingestion credential to an organization id.

    Returns the owning organization's UUID (Demo for the shared-key / disabled
    path). Raises 401 for missing / malformed / unknown / revoked keys.
    """
    configured = get_settings().api_key_list

    if api_key is None:
        # No credential presented: open mode when nothing is configured, else 401.
        if not configured:
            return DEMO_ORGANIZATION_ID
        logger.warning("ingest rejected: missing API key")
        raise _reject("missing_api_key", "authentication required: provide X-API-Key header")

    if api_key != api_key.strip():
        # Whitespace-padded keys are rejected uniformly (clients must send exact
        # keys); never accept a padded value even if it would match after strip().
        logger.warning("ingest rejected: malformed API key formatting")
        raise _reject("malformed_api_key", "malformed API key")

    # Shared configuration keys → reserved Demo org (existing behavior preserved).
    if configured and any(secrets.compare_digest(api_key, k) for k in configured):
        return DEMO_ORGANIZATION_ID

    # DB-backed, organization-owned credential.
    org_id = await tenant_service.resolve_api_key_to_org(session, api_key)
    if org_id is not None:
        return org_id

    logger.warning("ingest rejected: invalid API key", extra={"key_length": len(api_key)})
    raise _reject("invalid_api_key", "invalid API key")
