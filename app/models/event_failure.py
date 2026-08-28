import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.organization import DEMO_ORGANIZATION_ID


class EventFailure(Base):
    """One terminal processing failure (spec §10 'event_errors' concept).

    Written ONLY after terminal handling succeeded (message sent to DLQ and
    offset committed), so this table is an audit view of the existing DLQ
    semantics — it does not change them. Malformed messages that could not be
    deserialized have NULL event fields and NULL payload; their context lives
    in `error`.
    """

    __tablename__ = "event_failures"
    __table_args__ = (Index("ix_event_failures_org_failed_at", "organization_id", "failed_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Owning tenant. Defaults to the reserved Demo org (same rationale as Event):
    # the failure recorder does not yet resolve a tenant, so terminal DLQ audit
    # rows land in Demo until per-tenant resolution is wired up later.
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=False,
        default=DEMO_ORGANIZATION_ID,
        server_default=text("'00000000-0000-0000-0000-000000000001'::uuid"),
        index=True,
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    event_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str] = mapped_column(String(1024), nullable=False)
    # Handler invocations for this message: 3 = retried twice then DLQ'd,
    # 1 = permanent failure (no retry), 0 = malformed (never reached handler).
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    final_status: Mapped[str] = mapped_column(String(32), nullable=False)  # dlq_permanent | dlq_retry_exhausted | dlq_malformed
    failed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
