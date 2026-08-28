"""SQLAlchemy ORM models.

Importing this package registers every model on ``Base.metadata`` (import
order matters: organizations/users are referenced by later foreign keys).
Alembic's ``env.py`` imports this package so autogenerate/metadata sees the
full schema.
"""

from app.models.organization import Organization
from app.models.user import User
from app.models.membership import Membership
from app.models.api_credential import ApiCredential
from app.models.session import Session
from app.models.password_reset import PasswordResetToken
from app.models.event import Event
from app.models.event_failure import EventFailure

__all__ = [
    "Organization",
    "User",
    "Membership",
    "ApiCredential",
    "Session",
    "PasswordResetToken",
    "Event",
    "EventFailure",
]
