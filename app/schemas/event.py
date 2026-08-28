import re
import uuid
from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_validator

_EVENT_TYPE_RE = re.compile(r"^[a-z][a-z0-9_.]*$")


class EventIn(BaseModel):
    event_id: uuid.UUID | None = None
    event_type: str = Field(min_length=1, max_length=255)
    source: str = Field(min_length=1, max_length=255)
    timestamp: datetime | None = None
    user_id: str | None = Field(default=None, max_length=255)
    request_id: str | None = Field(default=None, max_length=255)
    payload: dict = Field(default_factory=dict)
    schema_version: int = Field(default=1, ge=1)

    @field_validator("event_type", "source")
    @classmethod
    def _strip_nonempty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("event_type")
    @classmethod
    def _validate_event_type_format(cls, value: str) -> str:
        if not _EVENT_TYPE_RE.match(value):
            raise ValueError("event_type must match ^[a-z][a-z0-9_.]*$")
        return value

    @field_validator("user_id", "request_id")
    @classmethod
    def _blank_to_none(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            return None
        return value

    @field_validator("timestamp")
    @classmethod
    def _require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("timestamp must include a UTC offset")
        return value

    def resolved_event_id(self) -> uuid.UUID:
        return self.event_id if self.event_id is not None else uuid.uuid4()

    def resolved_timestamp(self) -> datetime:
        ts = self.timestamp if self.timestamp is not None else datetime.now(timezone.utc)
        return ts.astimezone(timezone.utc)


class EventBatchIn(BaseModel):
    events: list[EventIn] = Field(min_length=1)


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: uuid.UUID
    event_type: str
    source: str
    timestamp: datetime
    user_id: str | None
    request_id: str | None
    payload: dict
    schema_version: int
    created_at: datetime
