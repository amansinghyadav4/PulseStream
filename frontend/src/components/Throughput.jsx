import { Card } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { LiveAreaChart } from "./charts/LiveAreaChart";
import { formatCount } from "../lib/format";

/**
 * Event throughput — the one dominant metric on the overview.
 *
 * The hero number and the plot read from the same session series, so the chart
 * and the figure can never disagree. Peak and mean are computed from samples
 * actually observed in this session; the label says so, because the backend
 * retains no history to average over anything wider.
 */
export function Throughput({ metrics, series, wsConnected = false }) {
  const peak = series.length > 0 ? Math.max(...series.map((p) => p.v)) : null;

  return (
    <Card
      title="Event throughput"
      id="analytics"
      hint={
        wsConnected
          ? "live via WebSocket · sampled in this browser session — the backend retains no time series"
          : "REST polling fallback · sampled in this browser session — the backend retains no time series"
      }
    >
      {!metrics ? (
        <>
          <div className="throughput-head">
            <div className="metric-hero">
              <span className="metric-hero-label">Ingest rate</span>
              <Skeleton width={220} height={44} />
            </div>
          </div>
          <Skeleton width="100%" height={240} />
        </>
      ) : (
        <>
          <div className="throughput-head">
            <div className="metric-hero">
              <span className="metric-hero-label">Ingest rate · now</span>
              <span className="metric-hero-value">
                {formatCount(metrics.events_per_second ?? 0)}
                <span className="value-unit">events/sec</span>
              </span>
              <div className="metric-hero-context">
                <span>
                  this minute <b>{formatCount(metrics.events_per_minute)}</b>
                </span>
                <span>
                  session peak <b>{peak !== null ? formatCount(peak) : "—"}</b>
                </span>
                <span>
                  samples <b>{series.length}</b>
                </span>
              </div>
            </div>
          </div>

          <LiveAreaChart points={series} height={320} />
        </>
      )}
    </Card>
  );
}
