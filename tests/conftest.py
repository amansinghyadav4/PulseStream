import pytest
from fakeredis import FakeAsyncRedis
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def fake_redis():
    """Shared FakeAsyncRedis injected as the app's redis client."""
    from app.redis.client import _reset_for_tests, _set_redis_for_tests

    redis = FakeAsyncRedis(decode_responses=True)
    _set_redis_for_tests(redis)
    yield redis
    await redis.flushall()
    await redis.aclose()
    _reset_for_tests()
