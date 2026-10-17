import { Card } from "../ui/Card";
import { SkeletonLines } from "../ui/Skeleton";

/**
 * Processing latency — server-side measured duration of processing one
 * consumed event in the analytics worker (dedup gate + counter pipeline),
 * monotonic clock, averaged over unique counted events.
 *
 * It deliberately does NOT use client-supplied event timestamps and it is
 * NOT end-to-end pipeline latency (API→publish→consume is not measured).
 */
export function Latency({ metrics }) {
  return (
    <Card title="Processing latency" hint="analytics worker · per consumed event">
      {!metrics ? (
        <SkeletonLines rows={3} lastWidth="40%" />
      ) : metrics.processing_latency_avg_ms === null ? (
        <div className="empty-state">
          <span className="empty-title">Unavailable</span>
          <span>Latency is averaged over counted events; none have been recorded yet.</span>
        </div>
      ) : (
        <>
          <div className="big-number" aria-live="polite">
            {metrics.processing_latency_avg_ms}
            <span className="value-unit">ms avg</span>
          </div>
          <p className="metric-definition">
            Server-measured time to process one event in the analytics worker
            (dedup check + counter write), averaged over uniquely counted events.
            Measured with a monotonic clock — client-supplied event timestamps are
            not used. This does not include API ingest or Kafka queue time and is
            not an end-to-end pipeline measurement.
          </p>
        </>
      )}
    </Card>
  );
}
