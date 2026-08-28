"""Phase 7 unit tests: KafkaEventConsumer.lag_snapshot()."""
from dataclasses import dataclass

import pytest

from app.kafka.consumer import KafkaEventConsumer


@dataclass(frozen=True)
class _TP:
    topic: str
    partition: int


def _tp(partition: int) -> _TP:
    return _TP("application-events", partition)


def _consumer_with(fake):
    c = KafkaEventConsumer(
        bootstrap_servers="localhost:9092",
        topic="application-events",
        group_id="persistence-workers",
    )
    c._consumer = fake
    return c


class _FakeKafkaConsumer:
    def __init__(self, assignment, highwater, position, raise_on=None):
        self._assignment = assignment
        self._highwater = highwater
        self._position = position
        self._raise_on = raise_on or set()

    def assignment(self):
        return self._assignment

    def highwater(self, tp):
        if tp in self._raise_on:
            raise RuntimeError("boom")
        return self._highwater[tp]

    def position(self, tp):
        value = self._position[tp]
        return value


class _FakeAsyncPosition(_FakeKafkaConsumer):
    async def position(self, tp):  # aiokafka version differences: async form
        return self._position[tp]


def _tp(partition: int) -> _TP:
    return _TP("application-events", partition)


@pytest.mark.asyncio
async def test_lag_computed_from_highwatermark_minus_position():
    fake = _FakeKafkaConsumer(
        assignment={_tp(0), _tp(1)},
        highwater={_tp(0): 100, _tp(1): 50},
        position={_tp(0): 97, _tp(1): 50},
    )
    c = _consumer_with(fake)
    lag = await c.lag_snapshot()
    assert lag == {"0": 3, "1": 0}


@pytest.mark.asyncio
async def test_lag_supports_async_position():
    fake = _FakeAsyncPosition(
        assignment={_tp(2)},
        highwater={_tp(2): 10},
        position={_tp(2): 4},
    )
    c = _consumer_with(fake)
    assert await c.lag_snapshot() == {"2": 6}


@pytest.mark.asyncio
async def test_lag_skips_unknown_offsets():
    # hw=-1 (never fetched) and pos=None are unknown -> omitted honestly
    fake = _FakeKafkaConsumer(
        assignment={_tp(0), _tp(1), _tp(2)},
        highwater={_tp(0): -1, _tp(1): 20, _tp(2): 5},
        position={_tp(0): None, _tp(1): -1, _tp(2): 0},
    )
    c = _consumer_with(fake)
    assert await c.lag_snapshot() == {"2": 5}


@pytest.mark.asyncio
async def test_lag_empty_when_kafka_unavailable():
    c = KafkaEventConsumer("localhost:9092", "t", "g")
    c._consumer = None
    assert await c.lag_snapshot() == {}


@pytest.mark.asyncio
async def test_lag_never_raises_and_clamps_negative():
    class _Exploding:
        def assignment(self):
            raise RuntimeError("dead connection")

    c = _consumer_with(_Exploding())
    assert await c.lag_snapshot() == {}

    class _Negative(_FakeKafkaConsumer):
        pass

    weird = _TP("application-events", 0)
    fake = _Negative({weird}, {weird: 3}, {weird: 9})
    c2 = _consumer_with(fake)
    assert await c2.lag_snapshot() == {"0": 0}
