"""user identities table (Google OAuth sign-in)

Adds the external-identity store that links a provider account (Google `sub`) to
a local ``users`` row. Additive and non-destructive: no existing column or table
is altered, so password authentication and every existing row are unaffected.
Guarded (inspects the live schema) so it is safe whether the table was already
created by ``Base.metadata.create_all`` (dev/tests) or is being created by
Alembic on a fresh database.

Revision ID: 0003_user_identities
Revises: 0002_password_reset_tokens
Create Date: 2026-10-17
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_user_identities"
down_revision: Union[str, None] = "0002_password_reset_tokens"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return name in _inspector().get_table_names()


def upgrade() -> None:
    if _has_table("user_identities"):
        return
    op.create_table(
        "user_identities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("provider", "subject", name="uq_user_identity_provider_subject"),
        sa.UniqueConstraint("user_id", "provider", name="uq_user_identity_user_provider"),
    )
    op.create_index("ix_user_identities_user_id", "user_identities", ["user_id"])
    op.create_index("ix_user_identities_provider", "user_identities", ["provider"])
    op.create_index("ix_user_identities_subject", "user_identities", ["subject"])


def downgrade() -> None:
    if _has_table("user_identities"):
        op.drop_table("user_identities")
