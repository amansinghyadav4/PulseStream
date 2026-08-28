"""Phase 8 unit tests: production settings fail-fast on development defaults."""
import pytest
from pydantic import ValidationError

from app.core.config import Settings


def _prod(**overrides):
    """Production settings with real endpoints, isolated from host env/.env."""
    base = dict(
        app_env="production",
        database_url="postgresql+asyncpg://u:p@db.internal:5432/pulsestream",
        kafka_bootstrap_servers="kafka:29092",
        redis_url="redis://cache.internal:6379/0",
    )
    base.update(overrides)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg]


def test_production_with_real_endpoints_passes():
    s = _prod()
    assert s.app_env == "production"


def test_production_rejects_default_database_url():
    with pytest.raises(ValidationError) as exc:
        _prod(database_url="postgresql+asyncpg://pulsestream:pulsestream@localhost:5432/pulsestream")
    assert "DATABASE_URL" in str(exc.value)


def test_production_rejects_default_kafka_and_redis_together():
    with pytest.raises(ValidationError) as exc:
        _prod(
            kafka_bootstrap_servers="localhost:9092",
            redis_url="redis://localhost:6379/0",
        )
    message = str(exc.value)
    assert "KAFKA_BOOTSTRAP_SERVERS" in message and "REDIS_URL" in message


def test_production_allows_alternative_loopback_spelling():
    # The gate rejects the development DEFAULT strings only; operators who
    # genuinely mean loopback can spell it differently (escape hatch).
    s = _prod(kafka_bootstrap_servers="127.0.0.1:9092", redis_url="redis://127.0.0.1:6379/0")
    assert s.kafka_bootstrap_servers == "127.0.0.1:9092"


def test_development_defaults_still_allowed():
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.app_env == "development"
