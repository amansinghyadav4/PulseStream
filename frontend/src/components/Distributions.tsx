import type { Metrics } from "../types/metrics";
import { formatCount, formatPercent, percentOf } from "../lib/format";
import { Card } from "../ui/Card";
import { SkeletonLines } from "../ui/Skeleton";

const MAX_ROWS = 8;

/**
 * Shared distribution list for events_by_type / events_by_source.
 * Percentages are computed from the actual reported counts only.
 * Rows optionally drill into the Event Explorer pre-filtered by value.
 */
export function DistributionList({
  entries,
  onDrill,
}: {
  entries: [string, number][];
  onDrill?: (value: string) => void;
}) {
  const total = entries.reduce((sum, [, c]) => sum + c, 0);
  const max = Math.max(...entries.map(([, c]) => c), 1);
  const shown = entries.slice(0, MAX_ROWS);

  return (
    <div className="dist-list">
      {shown.map(([name, count]) => (
        <div
          className={`dist-row ${onDrill ? "clickable" : ""}`}
          key={name}
          onClick={onDrill ? () => onDrill(name) : undefined}
          onKeyDown={
            onDrill
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onDrill(name);
                  }
                }
              : undefined
          }
          role={onDrill ? "button" : undefined}
          tabIndex={onDrill ? 0 : undefined}
          title={onDrill ? `View ${name} events` : undefined}
        >
          <span className="dist-name" title={name}>
            {name}
          </span>
          <span
            className="dist-bar-track"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={count}
            aria-label={`${name}: ${formatCount(count)} events`}
          >
            <span className="dist-bar-fill" style={{ width: `${(count / max) * 100}%` }} />
          </span>
          <span className="dist-count">{formatCount(count)}</span>
          <span className="dist-pct">{formatPercent(percentOf(count, total))}</span>
        </div>
      ))}
      {entries.length > MAX_ROWS ? (
        <div className="dist-more">+{entries.length - MAX_ROWS} more</div>
      ) : null}
    </div>
  );
}

function DistributionPanel({
  id,
  title,
  hint,
  entries,
  onDrill,
}: {
  id?: string;
  title: string;
  hint: string;
  entries: [string, number][] | null;
  onDrill?: (value: string) => void;
}) {
  return (
    <Card title={title} id={id} hint={hint}>
      {entries === null ? (
        <SkeletonLines rows={4} lastWidth="55%" />
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
          </svg>
          <span className="empty-title">No data</span>
          <span>Distributions appear as soon as events are processed.</span>
        </div>
      ) : (
        <DistributionList entries={[...entries].sort((a, b) => b[1] - a[1])} onDrill={onDrill} />
      )}
    </Card>
  );
}

export function EventTypes({
  metrics,
  onDrill,
}: {
  metrics: Metrics | null;
  onDrill?: (type: string) => void;
}) {
  const entries = metrics ? (Object.entries(metrics.events_by_type) as [string, number][]) : null;
  return (
    <DistributionPanel
      title="Event types"
      hint="share of processed events"
      entries={entries}
      onDrill={onDrill}
    />
  );
}

export function EventSources({
  metrics,
  onDrill,
}: {
  metrics: Metrics | null;
  onDrill?: (source: string) => void;
}) {
  const entries = metrics ? (Object.entries(metrics.events_by_source) as [string, number][]) : null;
  return (
    <DistributionPanel
      title="Event sources"
      hint="share of processed events"
      entries={entries}
      onDrill={onDrill}
    />
  );
}
