import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.organization import DEMO_ORGANIZATION_ID


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        # Multi-tenant identity: event_id is unique WITHIN an organization, not
        # globally. Two tenants may legitimately send the same event_id.
        UniqueConstraint("organization_id", "event_id", name="uq_events_org_event_id"),
        # Tenant-scoped recency reads (list newest events for one org).
        Index("ix_events_org_created_at", "organization_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Owning tenant. Defaults to the reserved Demo org so the existing shared-key
    # ingestion path (which does not yet resolve a tenant) keeps working; explicit
    # per-tenant resolution arrives in a later increment.
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=False,
        default=DEMO_ORGANIZATION_ID,
        server_default=text("'00000000-0000-0000-0000-000000000001'::uuid"),
        index=True,
    )
    # event_id is indexed for point lookups but NO LONGER globally unique — the
    # uniqueness guarantee is the composite (organization_id, event_id) above.
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(255), nullable=False)
    source: Mapped[str] = mapped_column(String(255), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
