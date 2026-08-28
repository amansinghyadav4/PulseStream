import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from app.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _find_dep(payload: dict, path: list[str]) -> dict:
    cur = payload["dependencies"]
    for p in path:
        cur = cur[p]
    return cur


@pytest.mark.asyncio
async def test_health_is_liveness_only(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_ready_all_healthy(client):
    # Patch dependency probes: postgres ok (default Depends uses real session -> patch execute),
    # redis ping ok via injected fakeredis-like mock.
    fake_redis = AsyncMock()
    fake_redis.ping = AsyncMock(return_value=True)
    fake_redis.ttl = AsyncMock(return_value=20)

    class FakeSession:
        async def execute(self, *_a, **_k):
            return True

    async def override_db():
        yield FakeSession()

    app.dependency_overrides[None] = None  # no-op guard
    from app.db.session import get_db

    app.dependency_overrides[get_db] = override_db
    try:
        with (
            patch("app.redis.client.get_redis", new=AsyncMock(return_value=fake_redis)),
            patch("app.api.routes_health.get_redis", new=AsyncMock(return_value=fake_redis)),
            patch("app.services.kafka_publisher.publisher._producer", new=object()),
        ):
            from app.services.broadcaster import start_broadcaster

            await start_broadcaster(interval=5)
            r = await client.get("/api/v1/ready")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ready"
        assert body["dependencies"]["postgres"]["status"] == "healthy"
        assert body["dependencies"]["redis"]["status"] == "healthy"
        assert body["dependencies"]["kafka"]["status"] in ("healthy", "degraded", "disabled")
        assert "broadcaster" in body["dependencies"]
        assert "workers" in body["dependencies"]
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_ready_postgres_down_is_not_ready_503(client):
    class BadSession:
        async def execute(self, *_a, **_k):
            raise RuntimeError("pg down")

    async def override_db():
        yield BadSession()

    from app.db.session import get_db

    app.dependency_overrides[get_db] = override_db
    try:
        r = await client.get("/ready")
        assert r.status_code == 503
        body = r.json()
        assert body["status"] == "not_ready"
        assert body["dependencies"]["postgres"]["status"] == "unhealthy"
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_ready_redis_down_is_degraded_not_503(client):
    class FakeSession:
        async def execute(self, *_a, **_k):
            return True

    async def override_db():
        yield FakeSession()

    from app.db.session import get_db

    app.dependency_overrides[get_db] = override_db
    try:
        with (
            patch("app.redis.client.get_redis", new=AsyncMock(return_value=None)),
            patch("app.api.routes_health.get_redis", new=AsyncMock(return_value=None)),
        ):
            r = await client.get("/api/v1/ready")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "degraded"
        assert body["dependencies"]["redis"]["status"] == "unavailable"
        # worker status honestly unknown when redis is down
        assert body["dependencies"]["workers"]["persistence_worker"]["status"] == "unknown"
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_ready_kafka_degraded_keeps_200(client):
    from app.services.kafka_publisher import publisher

    class FakeSession:
        async def execute(self, *_a, **_k):
            return True

    async def override_db():
        yield FakeSession()

    fake_redis = AsyncMock()
    fake_redis.ping = AsyncMock(return_value=True)
    fake_redis.ttl = AsyncMock(return_value=5)

    from app.db.session import get_db

    app.dependency_overrides[get_db] = override_db
    orig_producer = publisher._producer
    try:
        publisher._producer = None  # simulate producer not started
        with (
            patch("app.api.routes_health.get_redis", new=AsyncMock(return_value=fake_redis)),
        ):
            r = await client.get("/api/v1/ready")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "degraded"
        assert body["dependencies"]["kafka"]["status"] == "degraded"
    finally:
        publisher._producer = orig_producer
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_worker_heartbeat_roundtrip():
    from fakeredis import FakeAsyncRedis

    from app.redis.client import _reset_for_tests, _set_redis_for_tests
    from app.services.heartbeat import beat, read_heartbeat

    redis = FakeAsyncRedis(decode_responses=True)
    _set_redis_for_tests(redis)
    try:
        await beat("persistence")
        status = await read_heartbeat("persistence")
        assert status["status"] == "healthy"
        assert 0 < status["heartbeat_ttl_s"] <= 30
        keys = await redis.keys("*worker_heartbeat*")
        await redis.delete(*keys)
        status2 = await read_heartbeat("persistence")
        assert status2["status"] == "unhealthy"
    finally:
        await redis.aclose()
        _reset_for_tests()


