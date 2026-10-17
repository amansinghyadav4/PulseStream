# AGENTS.md

Session operating instructions for the PulseStream repository. These rules apply to every session working in this repo.

## Document hierarchy

1. `PulseStream_PROJECT_SPEC.md` — source of truth. Never modify it. Read it fully before starting any new phase.
2. `PulseStream_LEARNING.md` — living engineering log. Update continuously during development: decisions made, why, trade-offs, problems encountered, fixes, concepts to learn, deviations from spec.
3. This file — session operating rules.

## Hard rules

- **Git:** NEVER run `git push`, `git commit`, publish, release, or modify GitHub in any way. The user handles all Git operations personally.
- **Attribution:** never add co-author, generator, or automation attribution tags to commits, source files, comments, README, documentation, or metadata.
- **Scope:** Implement only the currently approved phase. Do not start the next phase until explicitly told to. Do not add technologies purely for resume keywords.
- **Honesty:** Never invent performance or benchmark numbers. Report only measurements actually taken, with methodology noted.
- **Architecture:** Do not silently change the documented architecture. Any necessary decision the spec does not cover goes into LEARNING.md with reasoning and trade-offs.
- **Teaching:** Briefly explain important concepts and decisions while implementing. The goal is that the user understands the system, not just receives generated code.
- **Planning:** Prefer implementation over extended planning; once a task is approved, execute and verify it rather than re-asking for permission.
- **Communication:** Keep explanations concise; explain only important engineering concepts.

## Phase status

- Phase 1 (in progress): FastAPI + PostgreSQL event ingestion service.
- Later phases — do NOT touch until explicitly approved: Kafka, stream workers, Redis, WebSockets, React dashboard, Prometheus/Grafana, AWS deployment, load testing.

See PROJECT_SPEC for the authoritative phase breakdown and acceptance criteria.

## Development commands (Windows, PowerShell)

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
docker compose up -d postgres
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
.venv\Scripts\python.exe -m pytest tests -v
```

## Code conventions

- Python 3.11+, type hints throughout, SQLAlchemy 2.x async style (`Mapped` / `mapped_column`), Pydantic v2.
- Configuration via pydantic-settings from environment / `.env` (template in `.env.example`). Never hardcode credentials.
- Every error response uses the structured envelope: `{ "error": { "code": "...", "message": "...", "details": ... } }`.
- Duplicate `event_id` returns HTTP 409. Batch ingestion is all-or-nothing, max 1000 events per batch.
- Request body size is limited; oversized payloads return HTTP 413.
- Logging: log `event_id`, `event_type`, `source` only. Never log payload contents or credentials.
- Tests: unit tests always run; integration tests use the Dockerized Postgres and skip cleanly when it is unreachable.
