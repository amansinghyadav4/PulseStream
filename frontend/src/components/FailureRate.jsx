import { formatCount, formatPercent, percentOf } from "../lib/format";
import { Card } from "../ui/Card";
import { SkeletonLines } from "../ui/Skeleton";

/**
 * Failure rate computed ONLY from real counters. With zero processed events
 * there is no meaningful rate — shown as "No data", never 0%.
 */
export function FailureRate({ metrics }) {
  return (
    <Card title="Failure rate" hint="terminal DLQ outcomes vs processed events">
      {!metrics ? (
        <SkeletonLines rows={2} lastWidth="35%" />
      ) : !metrics.total ? (
        <div className="empty-state">
          <span className="empty-title">No data</span>
          <span>A failure rate needs at least one processed event.</span>
        </div>
      ) : (
        <>
          <div className="chart-stats">
            <div className="stat-block">
              <div className="stat-label">Rate</div>
              <div
                className="stat-value"
                style={
                  (metrics.events_failed_total ?? 0) > 0
                    ? { color: "var(--danger-strong)" }
                    : { color: "var(--ok-strong)" }
                }
              >
                {formatPercent(percentOf(metrics.events_failed_total ?? 0, metrics.total))}
              </div>
            </div>
            <div className="stat-block">
              <div className="stat-label">Failed</div>
              <div className="stat-value">{formatCount(metrics.events_failed_total ?? 0)}</div>
            </div>
            <div className="stat-block">
              <div className="stat-label">Processed</div>
              <div className="stat-value">{formatCount(metrics.events_processed_total ?? metrics.total)}</div>
            </div>
          </div>
          <p className="metric-definition">
            Failed = events terminally sent to the dead-letter topic after bounded retries.
            Rate = failed ÷ total acknowledged events.
          </p>
        </>
      )}
    </Card>
  );
}
