import { useEffect, useRef, useState } from "react";
import { Card } from "../ui/Card";
import { SkeletonLines } from "../ui/Skeleton";
import { formatClockMs, shortId } from "../lib/format";
import { IconAlertTriangle } from "./icons";
import { EventDetailWorkspace } from "./EventDetailWorkspace";

/**
 * LATEST EVENTS — dense newest-first table (real stored events, ✓ delivered).
 * Millisecond timestamps per the reference layout; click opens the event
 * workspace. Failed messages are not part of this dataset — see Failures.
 */
export function ActivityFeed() {
  const [rows, setRows] = useState([]);
  const [freshIds, setFreshIds] = useState(new Set());
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const knownRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/v1/events?limit=8");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json());
        if (!Array.isArray(data) || cancelled) return;

        if (knownRef.current === null) {
          knownRef.current = new Set(data.map((d) => d.event_id));
        } else {
          const fresh = new Set(
            data.filter((d) => !knownRef.current.has(d.event_id)).map((d) => d.event_id)
          );
          knownRef.current = new Set(data.map((d) => d.event_id));
          if (fresh.size > 0) setFreshIds(fresh);
        }
        setRows(data);
        setError(null);
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        // Keep last known rows, but surface the failure instead of masking it
        // as an empty state on the very first load.
        setError(e instanceof Error ? e.message : "request failed");
        setStatus((s) => (s === "loading" ? "error" : s));
      }
    };
    void load();
    const id = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (freshIds.size === 0) return;
    const t = setTimeout(() => setFreshIds(new Set()), 1500);
    return () => clearTimeout(t);
  }, [freshIds]);

  return (
    <Card
      title="Latest events"
      hint="newest first · every row here is persisted; failed messages live under Failures"
      actions={
        <button type="button" className="btn" onClick={() => (window.location.hash = "/events")}>
          Open explorer →
        </button>
      }
    >
      {status === "loading" ? (
        <SkeletonLines rows={5} lastWidth="70%" />
      ) : status === "error" && rows.length === 0 ? (
        <div className="error-banner" role="alert">
          <span>
            <IconAlertTriangle size={13} /> Could not load recent events. Last error: {error}
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <span className="empty-title">No events stored yet</span>
          <span>
            Nothing has been persisted. Send real traffic from the Traffic Generator or the Demo Store and it will
            appear here within a second.
          </span>
        </div>
      ) : (
        <div className="latest-table" aria-live="polite">
          <div className="latest-head" aria-hidden>
            <span>Time</span>
            <span>Event type</span>
            <span>Source</span>
            <span>User</span>
            <span className="num">Event</span>
          </div>
          {rows.map((e) => (
            <div
              key={e.event_id}
              className={`latest-row ${freshIds.has(e.event_id) ? "fresh" : ""}`}
              tabIndex={0}
              role="button"
              onClick={() => setSelected(e)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  setSelected(e);
                }
              }}
              title={`${e.event_id}\n${formatClockMs(e.timestamp)}`}
              aria-label={`${e.event_type} from ${e.source} at ${formatClockMs(e.timestamp)} — open event details`}
            >
              <span className="lt-time">{formatClockMs(e.timestamp)}</span>
              <span className="lt-type">{e.event_type}</span>
              <span className="st-src">{e.source}</span>
              <span className="st-user">{e.user_id ?? "—"}</span>
              <span className="lt-id num mono" title={e.event_id}>
                {shortId(e.event_id)}
              </span>
            </div>
          ))}
        </div>
      )}

      {selected ? <EventDetailWorkspace event={selected} onClose={() => setSelected(null)} /> : null}
    </Card>
  );
}

/** Compact persistent status bar: environment · connections · last update. */
export function StatusBar({
  wsConnected,
  apiUp,
  updatedAt,
}) {
  const env = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "LOCAL" : "REMOTE";
  return (
    <footer className="statusbar">
      <span>
        ENVIRONMENT: <b>{env}</b>
      </span>
      <span>
        WEBSOCKET{" "}
        <b className={wsConnected ? "sb-ok" : "sb-warn"}>{wsConnected ? "connected" : "polling/offline"}</b>
      </span>
      <span>
        API{" "}
        <b className={apiUp === false ? "sb-bad" : apiUp ? "sb-ok" : ""}>
          {apiUp === null ? "checking" : apiUp ? "up" : "down"}
        </b>
      </span>
      <span className="statusbar-right">
        LAST UPDATE <b>{updatedAt ?? "—"}</b> · v0.1.0
      </span>
    </footer>
  );
}
