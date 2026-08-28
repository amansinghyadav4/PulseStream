"""Request/response schemas for the authentication endpoints (Increment B).

Password strength is validated centrally (min length from settings) so signup
and reset share one rule. Error messages avoid revealing whether an email is
registered (anti-enumeration): the routes return generic responses; schema-level
validation only concerns format and password policy.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.config import get_settings


def _validate_password_strength(value: str) -> str:
    min_len = get_settings().password_min_length
    if len(value) < min_len:
        raise ValueError(f"password must be at least {min_len} characters")
    if value.strip() != value:
        raise ValueError("password must not have leading or trailing whitespace")
    return value


class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)
    full_name: str | None = Field(default=None, max_length=255)

    @field_validator("password")
    @classmethod
    def _password_strength(cls, value: str) -> str:
        return _validate_password_strength(value)

    @field_validator("full_name")
    @classmethod
    def _blank_to_none(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            return None
        return value


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)


class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    new_password: str = Field(min_length=1, max_length=1024)

    @field_validator("new_password")
    @classmethod
    def _password_strength(cls, value: str) -> str:
        return _validate_password_strength(value)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str | None
    is_active: bool
    created_at: datetime


class OrganizationOut(BaseModel):
    """The workspace/tenant a user belongs to. Surfaced so the dashboard shell
    can label the authenticated workspace."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str


class MeOut(UserOut):
    """`/auth/me` response: the current user PLUS their resolved organization.

    Additive superset of ``UserOut`` — existing consumers that read only user
    fields keep working; the frontend reads ``organization`` for the shell."""

    organization: OrganizationOut


class MessageOut(BaseModel):
    """Generic success envelope for flows that must not leak state (e.g. forgot
    password). In non-production a `reset_token` may be attached for developer
    testing — see routes_auth for the guard."""

    status: str = "ok"
    message: str
    reset_token: str | None = None
