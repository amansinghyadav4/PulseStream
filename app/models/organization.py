import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, event, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# Reserved tenant that owns all pre-existing (single-tenant era) data and the
# shared PULSESTREAM_API_KEYS ingestion flow. Fixed, well-known UUID so both the
# ORM defaults and the Alembic migration reference the exact same row.
DEMO_ORGANIZATION_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")
DEMO_ORGANIZATION_SLUG = "demo"
DEMO_ORGANIZATION_NAME = "Demo"


class Organization(Base):
    """A tenant. All tenant-scoped data (events, failures, credentials, members)
    hangs off an organization. The reserved Demo org (fixed id above) is seeded
    on schema creation so existing data and the shared key have a home."""

    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    is_reserved: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


@event.listens_for(Organization.__table__, "after_create")
def _seed_demo_organization(target, connection, **kw) -> None:
    """Seed the reserved Demo org whenever the table is created via
    Base.metadata.create_all (development startup + test fixtures). Idempotent.
    The Alembic migration seeds the same row explicitly for real deployments."""
    connection.execute(
        pg_insert(target)
        .values(
            id=DEMO_ORGANIZATION_ID,
            name=DEMO_ORGANIZATION_NAME,
            slug=DEMO_ORGANIZATION_SLUG,
            is_reserved=True,
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )
