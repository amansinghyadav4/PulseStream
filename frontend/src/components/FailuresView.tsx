import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { formatClock, formatDate, formatCount, timeAgo } from "../lib/format";
import type { Metrics } from "../types/metrics";
import { Card } from "../ui/Card";
import { Drawer, DetailRow } from "../ui/Drawer";
import { CopyButton } from "../ui/CopyButton";
import { Segmented } from "../ui/Segmented";
import { IconAlertTriangle } from "./icons";

const PAGE_SIZE = 20;
const STATUS_LABELS: Record<string, string> = {
  dlq_permanent: "DLQ — permanent error (no retry)",
  dlq_retry_exhausted: "DLQ — retries exhausted",
  dlq_malformed: "DLQ — malformed message",
};

type StatusTab = "all" | "dlq_permanent" | "dlq_retry_exhausted" | "dlq_malformed";

interface FailureRow {
  id: number;
  event_id: string | null;
  event_type: string | null;
  source: string | null;
  user_id: string | null;
  payload: Record<string, unknown> | null;
  error: string;
  attempts: number;
  final_status: string;
  failed_at: string;
}

/**
 * Failures — incident investigation over terminal DLQ outcomes.
 * The audit table is written only after terminal handling succeeded; fields
 * that don't exist for a message render as honest "Not available".
 */
export function FailuresView({ metrics }: { metrics: Metrics | null }) {
  const [rows, setRows] = useState<FailureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FailureRow | null>(null);
  const [tab, setTab] = useState<StatusTab>("all");

  const fetchPage = useCallback(async (offset: number): Promise<FailureRow[] | null> => {
    try {
      const r = await fetch(`/api/v1/failures?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data)) throw new Error("unexpected response");
      return data as FailureRow[];
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load failures");
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const page = await fetchPage(0);
      if (!cancelled && page !== null) {
        setRows((prev) => [...page, ...prev.slice(page.length)]);
        setError(null);
        setLoading(false);
      } else if (!cancelled) setLoading(false);
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchPage]);

  const total = metrics?.total ?? 0;
  const failedCounter = metrics?.events_failed_total;
  const ratePct = total > 0 && failedCounter !== undefined ? Math.round((failedCounter / total) * 1000) / 10 : null;

  const filteredRows = useMemo(
    () => (tab === "all" ? rows : rows.filter((r) => r.final_status === tab)),
    [rows, tab]
  );

  const latest = rows[0] ?? null;
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    rows.forEach((r) => {
      counts[r.final_status] = (counts[r.final_status] ?? 0) + 1;
    });
    return counts;
  }, [rows]);

  return (
    <Card title="Failures" hint="incident investigation · terminal DLQ audit">
      {/* incident banner — real counters only */}
      <div className={`incident-banner ${failedCounter ? "" : "all-clear"}`}>
        <div className="incident-head">
          <span>
            <span className={`incident-count ${failedCounter ? "" : "clear"}`}>
              {failedCounter !== undefined ? formatCount(failedCounter) : "—"}
            </span>{" "}
            <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
              {failedCounter ? "events require attention" : "no failures recorded"}
            </span>
          </span>
          <span className="incident-rate">
            failure rate{" "}
            <b>{ratePct !== null ? `${ratePct}%` : "No data"}</b>
          </span>
        </div>
        <div
          className="proportion"
          role="img"
          aria-label={`Failure proportion ${ratePct ?? 0}% of ${formatCount(total)} processed events`}
        >
          <span className="prop-fail" style={{ width: `${Math.min(100, ratePct ?? 0)}%` }} />
          <span className="prop-ok" />
        </div>
        <div className="incident-meta">
          <span>
            processed <b>{metrics ? formatCount(metrics.events_processed_total ?? metrics.total) : "—"}</b>
          </span>
          <span>
            latest failure{" "}
            <b>{latest ? timeAgo(latest.failed_at) ?? formatDate(latest.failed_at) : "—"}</b>
          </span>
        </div>
      </div>

      {error ? (
        <div className="error-banner" role="alert">
          <span>
            <IconAlertTriangle size={13} /> Couldn’t load failures — {error}
          </span>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      ) : null}

      <Segmented<StatusTab>
        ariaLabel="Filter failures by final status"
        value={tab}
        onChange={setTab}
        options={[
          { value: "all", label: `All (${rows.length})` },
          {
            value: "dlq_permanent",
            label: `Permanent (${tabCounts["dlq_permanent"] ?? 0})`,
          },
          {
            value: "dlq_retry_exhausted",
            label: `Retry exhausted (${tabCounts["dlq_retry_exhausted"] ?? 0})`,
          },
          { value: "dlq_malformed", label: `Malformed (${tabCounts["dlq_malformed"] ?? 0})` },
        ]}
      />

      <div style={{ height: 12 }} />

      <div className="fail-rows">
        {loading ? (
          Array.from({ length: 3 }, (_, i) => (
            <div key={`sk-${i}`} className="fail-skeleton" aria-hidden>
              <span className="skeleton skeleton-text" style={{ width: "70%" }} />
            </div>
          ))
        ) : filteredRows.length === 0 && !error ? (
          <div className="empty-state">
            <span className="empty-title">All systems operational</span>
            <span>No failed events detected in this view.</span>
          </div>
        ) : (
          filteredRows.map((f) => (
            <div
              key={f.id}
              className="stream-row fail-row"
              tabIndex={0}
              role="button"
              onClick={() => setSelected(f)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(f);
                }
              }}
              aria-label={`Open failure details for ${f.event_type ?? "malformed message"}`}
            >
              <span className={`sev-dot sev-${f.final_status.replace("dlq_", "")}`} aria-hidden />
              <span style={{ minWidth: 0 }}>
                <span className="fail-main">
                  <span className="fail-type">{f.event_type ?? "Not available"}</span>
                  <span className="fail-meta mono">{f.source ?? "source n/a"}</span>
                  <span className="fail-meta">· {timeAgo(f.failed_at) ?? formatClock(f.failed_at)}</span>
                  <span className="fail-meta">· retries {Math.max(0, f.attempts - 1)}</span>
                </span>
                <span className="fail-error" title={f.error}>{f.error}</span>
              </span>
              <span className="badge neutral" style={{ justifySelf: "end" }}>
                {f.final_status === "dlq_retry_exhausted"
                  ? "retry exhausted"
                  : f.final_status === "dlq_permanent"
                    ? "permanent"
                    : "malformed"}
              </span>
            </div>
          ))
        )}
      </div>

      {selected ? <FailureDetailDrawer failure={selected} onClose={() => setSelected(null)} /> : null}
    </Card>
  );
}

export function FailureDetailDrawer({ failure, onClose }: { failure: FailureRow; onClose: () => void }) {
  const Na = () => <span className="detail-value na">Not available</span>;
  const attempts = failure.attempts;

  // Timeline derived ONLY from real data: the attempt count and the DLQ moment.
  // Per-attempt timestamps are not retained by the pipeline — stated openly.
  const nodes: Array<{ label: ReactNode; cls?: string }> = [];
  nodes.push({ label: <>Message consumed</> });
  if (attempts === 0) {
    nodes.push({
      label: (
        <>
          Could not be deserialized — <b>malformed message</b>
        </>
      ),
      cls: "done",
    });
  } else {
    for (let i = 1; i <= attempts; i++) {
      nodes.push({ label: <>Attempt {i}{i < attempts ? " — failed (transient)" : attempts > 1 ? " — failed" : ""}</>, cls: "done" });
    }
  }
  nodes.push({
    label: (
      <>
        Sent to <b>dead-letter-events</b> · {formatDate(failure.failed_at)} {formatClock(failure.failed_at)}
      </>
    ),
    cls: "dlq",
  });

  return (
    <Drawer
      title={
        <>
          {failure.event_id ? failure.event_id.slice(0, 8) : "malformed"}
          {failure.event_id ? <CopyButton value={failure.event_id} label="event id" /> : null}
        </>
      }
      subtitle={STATUS_LABELS[failure.final_status] ?? failure.final_status}
      onClose={onClose}
    >
      <p className="drawer-section">Event</p>
      <DetailRow label="Event ID">
        {failure.event_id ? <span className="mono">{failure.event_id}</span> : <Na />}
      </DetailRow>
      <DetailRow label="Type">{failure.event_type ?? <Na />}</DetailRow>
      <DetailRow label="Source">{failure.source ?? <Na />}</DetailRow>
      <DetailRow label="User">{failure.user_id ?? <Na />}</DetailRow>

      <p className="drawer-section">Failure</p>
      <DetailRow label="Error">
        <span className="mono">{failure.error}</span>
      </DetailRow>

      <p className="drawer-section">Retry history</p>
      <div className="timeline" aria-label="Processing timeline">
        {nodes.map((n, i) => (
          <div key={i} className={`timeline-node ${n.cls ?? ""}`}>
            <div className="timeline-rail">
              <span className="timeline-dot" />
              {i < nodes.length - 1 ? <span className="timeline-line" /> : null}
            </div>
            <span className="timeline-label">{n.label}</span>
          </div>
        ))}
        <p className="timeline-note">Per-attempt timestamps and error messages are not retained by the pipeline.</p>
      </div>

      <p className="drawer-section">Final outcome</p>
      <DetailRow label="Status">{STATUS_LABELS[failure.final_status] ?? failure.final_status}</DetailRow>
      <DetailRow label="Handler attempts">{attempts}</DetailRow>
      <DetailRow label="Retry count">{Math.max(0, attempts - 1)}</DetailRow>
      <DetailRow label="Failed at">
        <span className="mono">
          {formatDate(failure.failed_at)} {formatClock(failure.failed_at)}
        </span>
      </DetailRow>

      <p className="drawer-section">Payload context</p>
      {failure.payload ? (
        <pre className="payload-block">{JSON.stringify(failure.payload, null, 2)}</pre>
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 12.5 }}>Not available — malformed messages could not be parsed into an event.</p>
      )}
    </Drawer>
  );
}
