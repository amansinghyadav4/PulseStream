"""multi-tenant foundation: tenant tables + organization_id on events/failures

Introduces the multi-tenant schema without destroying existing data:
- new tables: organizations, users, memberships, api_credentials, sessions
- reserved "Demo" organization seeded and used to backfill all existing rows
- organization_id added to events and event_failures
- events uniqueness moves from global event_id to composite (organization_id, event_id)

The migration is guarded (inspects the live schema) so it is safe to run whether
the base tables were first created by Base.metadata.create_all (dev/tests) or by
Alembic on a fresh database.

Revision ID: 0001_multitenant_foundation
Revises:
Create Date: 2026-08-28
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_multitenant_foundation"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001"
DEMO_DEFAULT = sa.text(f"'{DEMO_ORG_ID}'::uuid")


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return name in _inspector().get_table_names()


def _has_column(table: str, column: str) -> bool:
    return _has_table(table) and any(c["name"] == column for c in _inspector().get_columns(table))


def _has_index(table: str, name: str) -> bool:
    return _has_table(table) and any(ix["name"] == name for ix in _inspector().get_indexes(table))


def _seed_demo_org() -> None:
    op.get_bind().execute(
        sa.text(
            "INSERT INTO organizations (id, name, slug, is_reserved, created_at) "
            "VALUES (:id, 'Demo', 'demo', true, now()) ON CONFLICT (id) DO NOTHING"
        ),
        {"id": DEMO_ORG_ID},
    )


def upgrade() -> None:
    # ---- organizations (+ seed reserved Demo org) ----
    if not _has_table("organizations"):
        op.create_table(
            "organizations",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("slug", sa.String(255), nullable=False),
            sa.Column("is_reserved", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        )
        op.create_index("ix_organizations_slug", "organizations", ["slug"], unique=True)
    _seed_demo_org()

    # ---- users ----
    if not _has_table("users"):
        op.create_table(
            "users",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("email", sa.String(320), nullable=False),
            sa.Column("password_hash", sa.String(255), nullable=False),
            sa.Column("full_name", sa.String(255), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        )
        op.create_index("ix_users_email", "users", ["email"], unique=True)

    # ---- memberships ----
    if not _has_table("memberships"):
        op.create_table(
            "memberships",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("organization_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("role", sa.String(32), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.UniqueConstraint("user_id", "organization_id", name="uq_membership_user_org"),
        )
        op.create_index("ix_memberships_user_id", "memberships", ["user_id"])
        op.create_index("ix_memberships_organization_id", "memberships", ["organization_id"])

    # ---- api_credentials (raw secret never stored; hash + prefix only) ----
    if not _has_table("api_credentials"):
        op.create_table(
            "api_credentials",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("organization_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("key_prefix", sa.String(32), nullable=False),
            sa.Column("hashed_secret", sa.String(255), nullable=False),
            sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_api_credentials_organization_id", "api_credentials", ["organization_id"])
        op.create_index("ix_api_credentials_key_prefix", "api_credentials", ["key_prefix"])

    # ---- sessions (server-side session foundation; token stored hashed) ----
    if not _has_table("sessions"):
        op.create_table(
            "sessions",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("token_hash", sa.String(255), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("user_agent", sa.String(512), nullable=True),
            sa.Column("ip_address", sa.String(64), nullable=True),
        )
        op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
        op.create_index("ix_sessions_token_hash", "sessions", ["token_hash"], unique=True)
        op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"])

    _upgrade_events()
    _upgrade_event_failures()


def _upgrade_events() -> None:
    if not _has_table("events"):
        # Fresh (Alembic-only) database — create with tenancy built in.
        op.create_table(
            "events",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("organization_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, server_default=DEMO_DEFAULT),
            sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("event_type", sa.String(255), nullable=False),
            sa.Column("source", sa.String(255), nullable=False),
            sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
            sa.Column("user_id", sa.String(255), nullable=True),
            sa.Column("request_id", sa.String(255), nullable=True),
            sa.Column("payload", postgresql.JSONB(), nullable=False),
            sa.Column("schema_version", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.UniqueConstraint("organization_id", "event_id", name="uq_events_org_event_id"),
        )
        op.create_index("ix_events_organization_id", "events", ["organization_id"])
        op.create_index("ix_events_event_id", "events", ["event_id"])
        op.create_index("ix_events_timestamp", "events", ["timestamp"])
        op.create_index("ix_events_created_at", "events", ["created_at"])
        op.create_index("ix_events_org_created_at", "events", ["organization_id", "created_at"])
        return
    if _has_column("events", "organization_id"):
        return  # already tenant-scoped (e.g. created by the new-model create_all)

    # Existing single-tenant table with data — additive, non-destructive upgrade.
    op.add_column("events", sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=True, server_default=DEMO_DEFAULT))
    op.get_bind().execute(sa.text("UPDATE events SET organization_id = :id WHERE organization_id IS NULL"), {"id": DEMO_ORG_ID})
    op.alter_column("events", "organization_id", nullable=False)
    op.create_foreign_key("fk_events_organization", "events", "organizations", ["organization_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_events_organization_id", "events", ["organization_id"])
    # Swap global uniqueness (unique index on event_id) for tenant-scoped composite.
    if _has_index("events", "ix_events_event_id"):
        op.drop_index("ix_events_event_id", table_name="events")
    op.create_index("ix_events_event_id", "events", ["event_id"])  # non-unique lookup index
    op.create_unique_constraint("uq_events_org_event_id", "events", ["organization_id", "event_id"])
    op.create_index("ix_events_org_created_at", "events", ["organization_id", "created_at"])


def _upgrade_event_failures() -> None:
    if not _has_table("event_failures"):
        op.create_table(
            "event_failures",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("organization_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, server_default=DEMO_DEFAULT),
            sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("event_type", sa.String(255), nullable=True),
            sa.Column("source", sa.String(255), nullable=True),
            sa.Column("user_id", sa.String(255), nullable=True),
            sa.Column("payload", postgresql.JSONB(), nullable=True),
            sa.Column("error", sa.String(1024), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False),
            sa.Column("final_status", sa.String(32), nullable=False),
            sa.Column("failed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        )
        op.create_index("ix_event_failures_organization_id", "event_failures", ["organization_id"])
        op.create_index("ix_event_failures_event_id", "event_failures", ["event_id"])
        op.create_index("ix_event_failures_failed_at", "event_failures", ["failed_at"])
        op.create_index("ix_event_failures_org_failed_at", "event_failures", ["organization_id", "failed_at"])
        return
    if _has_column("event_failures", "organization_id"):
        return

    op.add_column("event_failures", sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=True, server_default=DEMO_DEFAULT))
    op.get_bind().execute(sa.text("UPDATE event_failures SET organization_id = :id WHERE organization_id IS NULL"), {"id": DEMO_ORG_ID})
    op.alter_column("event_failures", "organization_id", nullable=False)
    op.create_foreign_key("fk_event_failures_organization", "event_failures", "organizations", ["organization_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_event_failures_organization_id", "event_failures", ["organization_id"])
    op.create_index("ix_event_failures_org_failed_at", "event_failures", ["organization_id", "failed_at"])


def downgrade() -> None:
    # Reverse tenant scope on events (restore global unique index on event_id).
    if _has_column("events", "organization_id"):
        if _has_index("events", "ix_events_org_created_at"):
            op.drop_index("ix_events_org_created_at", table_name="events")
        try:
            op.drop_constraint("uq_events_org_event_id", "events", type_="unique")
        except Exception:
            pass
        if _has_index("events", "ix_events_event_id"):
            op.drop_index("ix_events_event_id", table_name="events")
        op.create_index("ix_events_event_id", "events", ["event_id"], unique=True)
        try:
            op.drop_constraint("fk_events_organization", "events", type_="foreignkey")
        except Exception:
            pass
        if _has_index("events", "ix_events_organization_id"):
            op.drop_index("ix_events_organization_id", table_name="events")
        op.drop_column("events", "organization_id")

    if _has_column("event_failures", "organization_id"):
        if _has_index("event_failures", "ix_event_failures_org_failed_at"):
            op.drop_index("ix_event_failures_org_failed_at", table_name="event_failures")
        try:
            op.drop_constraint("fk_event_failures_organization", "event_failures", type_="foreignkey")
        except Exception:
            pass
        if _has_index("event_failures", "ix_event_failures_organization_id"):
            op.drop_index("ix_event_failures_organization_id", table_name="event_failures")
        op.drop_column("event_failures", "organization_id")

    for tbl in ("sessions", "api_credentials", "memberships", "users", "organizations"):
        if _has_table(tbl):
            op.drop_table(tbl)

