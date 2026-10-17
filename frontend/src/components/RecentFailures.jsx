import { useEffect, useState } from "react";
import { Card } from "../ui/Card";
import { SkeletonLines } from "../ui/Skeleton";
import { formatClock, timeAgo } from "../lib/format";
import { IconAlertTriangle } from "./icons";
import { FailureDetailDrawer } from "./FailuresView";

/**
 * Recent failures — the newest terminal outcomes, on the overview, because a
 * failure count alone cannot tell an operator whether anything is happening
 * right now. Rows are the same records the Failures page serves; clicking one
 * opens the same detail drawer, so the overview never grows a second story
 * about the same event.
 */
export function RecentFailures() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/v1/failures?limit=5&offset=0");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!Array.isArray(data) || cancelled) return;
        setRows(data);
        setError(null);
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "request failed");
        setStatus((s) => (s === "loading" ? "error" : s));
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <Card
      title="Recent failures"
      hint="terminal outcomes only · dead-lettered after retries"
      actions={
        <button type="button" className="btn" onClick={() => (window.location.hash = "/failures")}>
          All failures →
        </button>
      }
    >
      {status === "loading" ? (
        <SkeletonLines rows={4} lastWidth="62%" />
      ) : status === "error" && rows.length === 0 ? (
        <div className="error-banner" role="alert">
          <span>
            <IconAlertTriangle size={13} /> Could not load failures. Last error: {error}
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <span className="empty-title">No terminal failures recorded</span>
          <span>
            Nothing has been dead-lettered. Transient errors that succeeded on retry are not listed here.
          </span>
        </div>
      ) : (
        <div className="recent-failures" aria-live="polite">
          {rows.map((f) => (
            <button
              key={f.id}
              type="button"
              className="rf-row"
              onClick={() => setSelected(f)}
              aria-label={`Open failure ${f.event_type ?? "malformed message"} from ${f.source ?? "unknown source"}`}
            >
              <span className={`sev-dot sev-${f.final_status.replace("dlq_", "")}`} aria-hidden />
              <span className="rf-body">
                <span className="rf-main">
                  <span className="rf-type">{f.event_type ?? "Malformed message"}</span>
                  <span className="rf-meta mono">{f.source ?? "source n/a"}</span>
                </span>
                <span className="rf-error" title={f.error}>
                  {f.error}
                </span>
              </span>
              <span className="rf-time">
                {timeAgo(f.failed_at) ?? formatClock(f.failed_at)}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected ? <FailureDetailDrawer failure={selected} onClose={() => setSelected(null)} /> : null}
    </Card>
  );
}
