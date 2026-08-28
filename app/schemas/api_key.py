"""Pydantic schemas for the API-key lifecycle endpoints.

The raw secret is returned exactly once — in ``ApiKeyCreatedOut`` at creation.
Every other representation (``ApiKeyOut``) exposes only the public prefix and
metadata, never the secret or its hash.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ApiKeyCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class ApiKeyOut(BaseModel):
    id: uuid.UUID
    name: str
    key_prefix: str
    created_at: datetime
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None

    model_config = {"from_attributes": True}


class ApiKeyCreatedOut(ApiKeyOut):
    """Returned only on creation; carries the raw key shown to the user once."""

    api_key: str
