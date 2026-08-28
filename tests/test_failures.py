"""Failed-event visibility: recorder, retry-hook wiring, and the failures API."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.failure_recorder import record_failure


def _event(**overrides):
    base = {
        "event_id": str(uuid.uuid4()),
        "event_type": "order.created",
        "source": "fail-suite",
        "user_id": "u-1",
        "payload": {"amount": 10},
    }
    base.update(overrides)
    return base


@pytest.fixture
def captured(monkeypatch):
    """Capture EventFailure inserts via a mocked session factory."""
    rows: list = []

    class _FakeSession:
        def __init__(self):
            self.added = None

        def add(self, row):
            self.added = row
            rows.append(row)

        async def commit(self):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    import app.services.failure_recorder as rec

    monkeypatch.setattr(rec, "SessionFactory", lambda: _FakeSession())
    return rows


@pytest.mark.asyncio
async def test_record_failure_persists_event_context(captured):
    ok = await record_failure(_event(), error="redis pipeline failed", attempts=3, final_status="dlq_retry_exhausted")
    assert ok is True
    row = captured[0]
    assert row.event_type == "order.created"
    assert row.source == "fail-suite"
    assert row.attempts == 3
    assert row.final_status == "dlq_retry_exhausted"
    assert row.payload == {"amount": 10}
    assert "redis" in row.error


@pytest.mark.asyncio
async def test_malformed_failure_has_no_invented_fields(captured):
    ok = await record_failure(None, error="malformed json", attempts=0, final_status="dlq_malformed")
    assert ok is True
    row = captured[0]
    assert row.event_id is None
    assert row.event_type is None
    assert row.source is None
    assert row.payload is None
    assert row.attempts == 0
    assert row.final_status == "dlq_malformed"


@pytest.mark.asyncio
async def test_recorder_never_raises_on_bad_input(captured, monkeypatch):
    # even a broken SessionFactory must not propagate (best-effort auditing)
    import app.services.failure_recorder as rec

    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(rec, "SessionFactory", _boom)
    ok = await record_failure(_event(), "err", 1, "dlq_permanent")
    assert ok is False


@pytest.mark.asyncio
async def test_retry_hook_records_terminal_failures_with_accurate_attempts(monkeypatch):
    """with_retry_and_dlq must audit with real invocation counts and status."""
    from app.kafka.retry import with_retry_and_dlq

    recorded: list[tuple] = []
    import app.services.failure_recorder as rec

    async def fake_record(event, error, attempts, final_status):
        recorded.append((event, error, attempts, final_status))

    dlq = MagicMock()
    dlq.send = AsyncMock()
    flaky = AsyncMock(side_effect=RuntimeError("db down"))

    monkeypatch.setattr(rec, "record_failure", fake_record)
    await with_retry_and_dlq(flaky, _event(), b"raw", dlq)

    dlq.send.assert_awaited_once()
    event, error, attempts, final_status = recorded[0]
    assert attempts == 3  # MAX_ATTEMPTS handler invocations
    assert final_status == "dlq_retry_exhausted"
    assert "db down" in error

    # permanent failure: single invocation, no retries
    recorded.clear()
    permanent = AsyncMock(side_effect=ValueError("bad field"))
    monkeypatch.setattr(rec, "record_failure", fake_record)
    await with_retry_and_dlq(permanent, _event(), b"raw", dlq)
    _, _, attempts2, status2 = recorded[0]
    assert attempts2 == 1
    assert status2 == "dlq_permanent"


@pytest.mark.asyncio
async def test_failures_api_list_newest_first(client):
    """API returns recorded failures; empty state is [] not error."""
    try:
        from sqlalchemy import text

        from app.db.session import engine

        # ensure the audit table exists in the test database (idempotent)
        from app.db.base import Base
        from app.models import event_failure  # noqa: F401

        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("PostgreSQL unavailable; skipping failures API test")
        return
    # real persistence (no mocks): write through the recorder, read via the API
    from datetime import datetime, timedelta, timezone

    older = _event(event_type="older.type")
    newer = _event(event_type="newer.type")
    await record_failure(older, "e1", 3, "dlq_retry_exhausted")
    await record_failure(newer, "e2", 1, "dlq_permanent")

    r = await client.get("/api/v1/failures?limit=100")
    assert r.status_code == 200
    items = r.json()
    assert isinstance(items, list)
    mine = {i["event_type"]: i for i in items if i["source"] == "fail-suite" and i["event_type"] in ("older.type", "newer.type")}
    assert set(mine.keys()) == {"older.type", "newer.type"}
    # newest-first ordering: 'newer' must appear before 'older' in the list
    ids = [i["event_type"] for i in items]
    assert ids.index("newer.type") < ids.index("older.type")
    sample = mine["newer.type"]
    assert set(sample.keys()) >= {
        "id", "event_id", "event_type", "source", "user_id",
        "payload", "error", "attempts", "final_status", "failed_at",
    }
    assert sample["attempts"] == 1 and sample["final_status"] == "dlq_permanent"


@pytest.mark.asyncio
async def test_failures_api_limit_validation(client):
    r = await client.get("/api/v1/failures?limit=500")
    assert r.status_code == 422
