import type { Metrics, SessionPoint } from "../types/metrics";
import { Card } from "../ui/Card";
import { SkeletonLines } from "../ui/Skeleton";
import { LiveAreaChart } from "./charts/LiveAreaChart";
import { formatCount } from "../lib/format";

/**
 * Event throughput. The chart plots ONLY values observed during this session
 * (real updates); the numeric stats show the current real-time values.
 */
export function Throughput({
  metrics,
  series,
}: {
  metrics: Metrics | null;
  series: SessionPoint[];
}) {
  const peak = series.length > 0 ? Math.max(...series.map((p) => p.v)) : null;
  return (
    <Card
      title="Event throughput"
      id="analytics"
      hint="events per second observed this session — no historical data is retained"
    >
      {!metrics ? (
        <SkeletonLines rows={4} lastWidth="45%" />
      ) : (
        <>
          <div className="chart-stats">
            <div className="stat-block">
              <div className="stat-label">Current</div>
              <div className="stat-value">
                {formatCount(metrics.events_per_second ?? 0)}
                <span className="value-unit">ev/s</span>
              </div>
            </div>
            <div className="stat-block">
              <div className="stat-label">Peak · session</div>
              <div className="stat-value">{peak !== null ? formatCount(peak) : "—"}</div>
            </div>
            <div className="stat-block">
              <div className="stat-label">Current minute</div>
              <div className="stat-value">
                {formatCount(metrics.events_per_minute)}
                <span className="value-unit">ev/min</span>
              </div>
            </div>
          </div>
          <LiveAreaChart points={series} />
        </>
      )}
    </Card>
  );
}
