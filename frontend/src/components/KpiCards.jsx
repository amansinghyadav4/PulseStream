import { formatCount } from "../lib/format";
import { StatRow, StatRows } from "../ui/Stat";
import { Skeleton } from "../ui/Skeleton";

/**
 * Key metrics — the supporting numbers, presented as a dense aligned list
 * rather than a grid of identical cards.
 *
 * Rationale: seven equally sized boxes communicate "these are all equally
 * important", which is never true. Only one number on this page can be the
 * headline (see Throughput); everything else is a reading. Values come only
 * from the real metrics snapshot — a metric the backend has not reported
 * renders as Unavailable with the reason, never as 0.
 */
export function Overview({ metrics, onMetric, exclude = [] }) {
  const loading = !metrics;

  const items = [
    {
      metricKey: "total",
      label: "Total events",
      value: metrics ? formatCount(metrics.total) : null,
      note: metrics ? "acknowledged by the ingestion API" : undefined,
    },
    {
      metricKey: "eventsPerSecond",
      label: "Events / sec",
      value: metrics ? formatCount(metrics.events_per_second ?? 0) : null,
      note: metrics ? "instantaneous rate" : undefined,
    },
    {
      metricKey: "eventsPerMinute",
      label: "Events / min",
      value: metrics ? formatCount(metrics.events_per_minute) : null,
      note: metrics ? "sliding one-minute window" : undefined,
    },
    {
      metricKey: "processed",
      label: "Processed",
      tone: "ok",
      value:
        !metrics || metrics.events_processed_total === undefined
          ? null
          : formatCount(metrics.events_processed_total),
      unavailableNote: metrics ? "not reported in this snapshot" : undefined,
      note: metrics ? "persisted and analytics-counted" : undefined,
    },
    {
      metricKey: "failed",
      label: "Failed",
      tone: metrics && (metrics.events_failed_total ?? 0) > 0 ? "danger" : undefined,
      value:
        !metrics || metrics.events_failed_total === undefined
          ? null
          : formatCount(metrics.events_failed_total),
      unavailableNote: metrics ? "not reported in this snapshot" : undefined,
      note: metrics ? "sent to the dead-letter queue" : undefined,
    },
    {
      metricKey: "latency",
      label: "Processing latency",
      unit: metrics?.processing_latency_avg_ms != null ? "ms" : undefined,
      value:
        metrics?.processing_latency_avg_ms != null ? String(metrics.processing_latency_avg_ms) : null,
      unavailableNote: metrics ? "no counted events yet" : undefined,
      note: metrics ? "per event, weighted average" : undefined,
    },
    {
      metricKey: "producers",
      label: "Active producers",
      value: metrics ? String(metrics.active_producers) : null,
      note: metrics ? "distinct sources seen" : undefined,
    },
    {
      metricKey: "lag",
      label: "Consumer lag",
      value: metrics?.consumer_lag != null ? formatCount(metrics.consumer_lag) : null,
      unavailableNote: metrics ? "workers not reporting yet" : undefined,
      note: metrics ? "sum across worker groups" : undefined,
    },
  ].filter((it) => !exclude.includes(it.metricKey));

  if (loading) {
    return (
      <StatRows ariaLabel="Key metrics">
        {items.map((it) => (
          <div className="stat-row" key={it.metricKey}>
            <span className="stat-row-label">{it.label}</span>
            <Skeleton width={54} height={14} />
          </div>
        ))}
      </StatRows>
    );
  }

  return (
    <StatRows ariaLabel="Key metrics">
      {items.map((it) => {
        const unavailable = it.value === null;
        const clickable = !!onMetric && !unavailable;

        return (
          <StatRow
            key={it.metricKey}
            label={it.label}
            value={it.value}
            unit={it.unit}
            tone={it.tone}
            note={unavailable ? it.unavailableNote : it.note}
            onClick={clickable ? () => onMetric(it.metricKey) : undefined}
            ariaLabel={`${it.label} — open details`}
          />
        );
      })}
    </StatRows>
  );
}
