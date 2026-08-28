"""Phase 7 unit tests: loadgen percentile math + metrics lag parsing."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "load-tests"))

from benchmark import parse_lag_from_metrics  # noqa: E402
from loadgen import make_event, percentile  # noqa: E402


def test_percentile_exact_and_interpolated():
    assert percentile([], 50) == 0.0
    assert percentile([5.0], 50) == 5.0
    assert percentile([1.0, 2.0, 3.0, 4.0], 50) == 2.5
    ordered = [float(i) for i in range(101)]  # 0..100
    assert percentile(ordered, 50) == 50.0
    assert percentile(ordered, 95) == 95.0
    assert percentile(ordered, 99) == 99.0


def test_percentile_small_sample_interpolation():
    # p50 of two values is their midpoint
    assert percentile([10.0, 20.0], 50) == 15.0
    # p99 of [0,100] interpolates near the top
    assert percentile([0.0, 100.0], 99) == 99.0


def test_make_event_unique_ids_and_schema():
    events = [make_event(i) for i in range(50)]
    ids = {e["event_id"] for e in events}
    assert len(ids) == 50
    for e in events:
        assert set(e.keys()) == {
            "event_id", "event_type", "source", "timestamp",
            "user_id", "request_id", "payload", "schema_version",
        }
        assert e["event_type"].split(".")[0] in {"order", "payment", "page", "user", "shipment"}


def test_parse_lag_from_metrics_exposition():
    exposition = (
        '# HELP pulsestream_consumer_lag Consumer lag by group and partition\n'
        '# TYPE pulsestream_consumer_lag gauge\n'
        'pulsestream_consumer_lag{group="persistence-workers",partition="0"} 42.0\n'
        'pulsestream_consumer_lag{group="persistence-workers",partition="1"} 7.0\n'
        'pulsestream_consumer_lag{group="analytics-workers",partition="0"} 0.0\n'
        'pulsestream_http_requests_total{method="POST",path="/api/v1/events",status="201"} 10.0\n'
    )
    lag = parse_lag_from_metrics(exposition)
    assert lag == {"persistence-workers": 42, "analytics-workers": 0}
    assert parse_lag_from_metrics("no gauges here") == {}
