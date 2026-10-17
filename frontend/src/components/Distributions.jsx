import { formatCount, formatPercent, percentOf } from "../lib/format";
import { Card } from "../ui/Card";
import { SkeletonLines } from "../ui/Skeleton";

const MAX_ROWS = 8;

/** Share bar widths are relative to the largest entry, not a percentage. */
function barWidth(count, max) {
  if (!Number.isFinite(count) || max <= 0) return 0;
  return Math.max(2, (count / max) * 100);
}

/**
 * Aligned share table for events_by_type / events_by_source.
 *
 * A table rather than a set of progress bars: the name, the bar, the count and
 * the share all line up on shared column edges, so two of these panels can sit
 * side by side and be compared without the eye re-anchoring on every row.
 * Percentages are computed from reported counts only — never estimated.
 */
export function DistributionList({ entries, onDrill, nameHeader = "Value" }) {
  const total = entries.reduce((sum, [, c]) => sum + c, 0);
  const max = Math.max(...entries.map(([, c]) => c), 1);
  const shown = entries.slice(0, MAX_ROWS);
  const hidden = entries.length - shown.length;

  return (
    <>
      <table className="share-table">
        <thead>
          <tr>
            <th scope="col">{nameHeader}</th>
            <th scope="col" className="share-bar-cell">
              Distribution
            </th>
            <th scope="col" className="num">
              Events
            </th>
            <th scope="col" className="num">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map(([name, count]) => (
            <tr key={name}>
              <td className="share-name" title={name}>
                {onDrill ? (
                  <button
                    type="button"
                    className="share-link"
                    onClick={() => onDrill(name)}
                    title={`View ${name} events`}
                  >
                    {name}
                  </button>
                ) : (
                  name
                )}
              </td>
              <td className="share-bar-cell" aria-hidden>
                <span className="share-bar-track">
                  <span className="share-bar-fill" style={{ width: `${barWidth(count, max)}%` }} />
                </span>
              </td>
              <td className="num share-count">{formatCount(count)}</td>
              <td className="num share-pct">{formatPercent(percentOf(count, total))}</td>
            </tr>
          ))}
        </tbody>
        {hidden > 0 ? (
          <tfoot>
            <tr>
              <td className="share-more" colSpan={2}>
                +{hidden} more below the top {MAX_ROWS}
              </td>
              <td className="num share-count">{formatCount(total)}</td>
              <td className="num share-pct">100%</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </>
  );
}

function DistributionPanel({ id, title, hint, nameHeader, entries, onDrill }) {
  return (
    <Card title={title} id={id} hint={hint}>
      {entries === null ? (
        <SkeletonLines rows={5} lastWidth="55%" />
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
        <DistributionList
          entries={[...entries].sort((a, b) => b[1] - a[1])}
          onDrill={onDrill}
          nameHeader={nameHeader}
        />
      )}
    </Card>
  );
}

export function EventTypes({ metrics, onDrill }) {
  const entries = metrics ? Object.entries(metrics.events_by_type) : null;
  return (
    <DistributionPanel
      title="Event types"
      hint="share of processed events, by count"
      nameHeader="Event type"
      entries={entries}
      onDrill={onDrill}
    />
  );
}

export function EventSources({ metrics, onDrill }) {
  const entries = metrics ? Object.entries(metrics.events_by_source) : null;
  return (
    <DistributionPanel
      title="Event sources"
      hint="share of processed events, by count"
      nameHeader="Source"
      entries={entries}
      onDrill={onDrill}
    />
  );
}
