import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatClockMs, shortId } from "../lib/format";
import { Card } from "../ui/Card";
import { Drawer, DetailRow } from "../ui/Drawer";
import { CopyButton } from "../ui/CopyButton";
import { Segmented } from "../ui/Segmented";
import { EventDetailWorkspace } from "./EventDetailWorkspace";
import { IconAlertTriangle, IconInbox } from "./icons";

const PAGE_SIZE = 20;
const REFRESH_MS = 2000;

/**
 * Event Explorer — the heart of PulseStream investigation.
 * Table and Stream views over GET /api/v1/events (limit/offset).
 * Filters apply to loaded rows (the API supports paging only — stated openly).
 * Row click opens the detail side panel; the list stays visible underneath.
 */
export function EventExplorer({
  initialQuery = "",
  initialType = "",
  initialSource = "",
}) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState(initialQuery);
  const [typeFilter, setTypeFilter] = useState(initialType);
  const [sourceFilter, setSourceFilter] = useState(initialSource || "all");
  const [userFilter, setUserFilter] = useState("all");
  const [mode, setMode] = useState("table");
  const autoRefreshRef = useRef(true);

  const fetchPage = useCallback(async (offset) => {
    try {
      const r = await fetch(`/api/v1/events?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data)) throw new Error("unexpected response");
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load events");
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshFirstPage = async () => {
      const page = await fetchPage(0);
      if (!cancelled && page !== null) {
        setEvents((prev) => {
          const rest = prev.slice(page.length);
          return [...page, ...rest];
        });
        setError(null);
        setLoading(false);
      } else if (!cancelled) {
        setLoading(false);
      }
    };

    void refreshFirstPage();
    const id = setInterval(() => {
      if (autoRefreshRef.current) void refreshFirstPage();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchPage]);

  const loadMore = async () => {
    setLoadingMore(true);
    autoRefreshRef.current = false;
    const page = await fetchPage(events.length);
    if (page !== null) {
      const known = new Set(events.map((e) => e.event_id));
      setEvents((prev) => [...prev, ...page.filter((e) => !known.has(e.event_id))]);
      setHasMore(page.length === PAGE_SIZE);
      setError(null);
    }
    setLoadingMore(false);
  };

  const manualRefresh = async () => {
    setLoading(true);
    autoRefreshRef.current = true;
    const page = await fetchPage(0);
    if (page !== null) {
      setEvents((prev) => [...page, ...prev.slice(page.length)]);
      setError(null);
    }
    setLoading(false);
  };

  const typeOptions = useMemo(() => Array.from(new Set(events.map((e) => e.event_type))).sort(), [events]);
  const sourceOptions = useMemo(() => Array.from(new Set(events.map((e) => e.source))).sort(), [events]);
  const userOptions = useMemo(
    () => Array.from(new Set(events.map((e) => e.user_id).filter((u) => !!u))).sort(),
    [events]
  );

  // client-side filtering over loaded rows (API supports paging only)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (typeFilter && typeFilter !== "all" && e.event_type !== typeFilter) return false;
      if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
      if (userFilter !== "all" && e.user_id !== userFilter) return false;
      if (!q) return true;
      return (
        e.event_id.toLowerCase().includes(q) ||
        e.event_type.toLowerCase().includes(q) ||
        e.source.toLowerCase().includes(q) ||
        (e.user_id ?? "").toLowerCase().includes(q)
      );
    });
  }, [events, query, typeFilter, sourceFilter, userFilter]);

  const activeFilters = [
    typeFilter && typeFilter !== "all" ? `type:${typeFilter}` : null,
    sourceFilter !== "all" ? `source:${sourceFilter}` : null,
    userFilter !== "all" ? `user:${userFilter}` : null,
    query.trim() ? `q:"${query.trim()}"` : null,
  ].filter(Boolean);

  return (
    <Card ariaLabel="Event explorer">
      {error ? (
        <div className="error-banner" role="alert">
          <span>
            <IconAlertTriangle size={13} /> Connection lost — retrying automatically. Last error: {error}
          </span>
          <button type="button" className="btn" onClick={manualRefresh}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="explorer-toolbar">
        <input
          type="search"
          placeholder="Search id, type, source, user…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search events"
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by event type">
          <option value="">All types</option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} aria-label="Filter by source">
          <option value="all">All sources</option>
          {sourceOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label="Filter by user">
          <option value="all">All users</option>
          {userOptions.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          value="stored"
          onChange={(e) => {
            if (e.target.value === "failed") window.location.hash = "/failures";
          }}
          aria-label="Filter by status"
        >
          <option value="stored">Status: stored</option>
          <option value="failed">Status: failed → Failures</option>
        </select>
      </div>

      <div className="table-toolbar">
        <span className="toolbar-meta">
          {filtered.length} of {events.length} loaded
          {activeFilters.length > 0 ? ` · ${activeFilters.join(" · ")}` : ""}
          {autoRefreshRef.current ? " · live-refreshing head" : " · auto-refresh paused"}
        </span>
        <div className="toolbar-actions">
          <Segmented
            ariaLabel="Display mode"
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: "table", label: "Table" },
              { value: "stream", label: "Stream" },
            ]}
          />
          <button type="button" className="btn" onClick={manualRefresh} disabled={loading}>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {mode === "table" ? (
        <TableMode
          loading={loading}
          rows={filtered}
          totalLoaded={events.length}
          error={!!error}
          onOpen={setSelected}
          onLoadMore={loadMore}
          loadingMore={loadingMore}
          hasMore={hasMore}
        />
      ) : (
        <StreamMode
          loading={loading}
          rows={filtered}
          error={!!error}
          onOpen={setSelected}
        />
      )}

      {selected ? <EventDetailWorkspace event={selected} onClose={() => setSelected(null)} /> : null}
    </Card>
  );
}

function TableMode({
  loading,
  rows,
  totalLoaded,
  error,
  onOpen,
  onLoadMore,
  loadingMore,
  hasMore,
}) {
  return (
    <>
      <div className="table-scroll">
        <table className="events-table">
          <caption className="visually-hidden">Ingested events, newest first. Click a row for details.</caption>
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Type</th>
              <th scope="col">Source</th>
              <th scope="col">User</th>
              <th scope="col">Event ID</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              Array.from({ length: 5 }, (_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 6 }, (_, j) => (
                    <td key={j}>
                      <span className="skeleton skeleton-text" style={{ width: `${55 + ((i + j) % 4) * 12}%` }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 && !error ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    <IconInbox size={24} />
                    <span className="empty-title">{totalLoaded === 0 ? "No events yet" : "No matches"}</span>
                    <span>
                      {totalLoaded === 0
                        ? "Send an event from the Traffic Lab or Demo Store to see live activity."
                        : "Adjust the search or filters, or load more rows."}
                    </span>
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((e) => (
                <tr
                  key={e.event_id}
                  className="row-clickable"
                  role="button"
                  onClick={() => onOpen(e)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      onOpen(e);
                    }
                  }}
                  tabIndex={0}
                  aria-label={`Open details for event ${shortId(e.event_id)}`}
                >
                  <td className="cell-mono">{formatClockMs(e.timestamp)}</td>
                  <td className="cell-primary">{e.event_type}</td>
                  <td className="cell-mono">{e.source}</td>
                  <td>{e.user_id ?? <span className="cell-dim">—</span>}</td>
                  <td className="cell-mono cell-dim" title={e.event_id}>
                    {shortId(e.event_id)}
                  </td>
                  <td>
                    <span className="badge ok">
                      <span className="dot" aria-hidden />
                      stored
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && rows.length > 0 ? (
        <div className="table-footer">
          <button type="button" className="btn accent" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load 20 older events"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function StreamMode({
  loading,
  rows,
  error,
  onOpen,
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="event-stream" aria-label="Event stream loading">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="stream-row" aria-hidden>
            <span className="skeleton skeleton-text" style={{ width: 56 }} />
            <span className="skeleton skeleton-text" style={{ width: "60%" }} />
            <span className="skeleton skeleton-text" style={{ width: "40%" }} />
            <span className="skeleton skeleton-text" style={{ width: "30%" }} />
            <span />
          </div>
        ))}
      </div>
    );
  }
  if (rows.length === 0 && !error) {
    return (
      <div className="empty-state">
        <IconInbox size={22} />
        <span className="empty-title">Nothing in the stream</span>
        <span>New events appear here in real time.</span>
      </div>
    );
  }
  return (
    <div className="event-stream" aria-label="Event stream, newest first">
      {rows.map((e) => (
        <div
          key={e.event_id}
          className="stream-row"
          tabIndex={0}
          role="button"
          onClick={() => onOpen(e)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              onOpen(e);
            }
          }}
          title={`${e.event_id}`}
        >
          <span className="st-time">{formatClockMs(e.timestamp)}</span>
          <span className="st-type">{e.event_type}</span>
          <span className="st-src">{e.source}</span>
          <span className="st-user">{e.user_id ?? "—"}</span>
          {/* severity indicator: all stored events are successfully delivered */}
          <span className="severity-dot" aria-label="delivered" />
        </div>
      ))}
    </div>
  );
}
