import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserIdentity(Base):
    """An external identity (OAuth provider account) linked to a local user.

    Kept as a separate table rather than extra columns on ``users`` on purpose:

    * A user can have several external identities over time (Google today,
      another provider later) without a widening nullable column set.
    * The existing ``users`` schema — including the NOT NULL ``password_hash`` —
      is untouched, so password login and every existing row keep working
      byte-for-byte.

    ``(provider, subject)`` is unique: one Google account maps to exactly one
    local user. ``(user_id, provider)`` is unique: one local user has at most one
    Google identity, which makes the link operation idempotent.
    """

    __tablename__ = "user_identities"
    __table_args__ = (
        UniqueConstraint("provider", "subject", name="uq_user_identity_provider_subject"),
        UniqueConstraint("user_id", "provider", name="uq_user_identity_user_provider"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    # The provider's stable user id (`sub` claim). Never the email: emails are
    # mutable at the provider, the subject is not.
    subject: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
