import type { ReactNode } from "react";
import { useHealth } from "../hooks/useHealth";
import { Badge } from "../ui/Badge";

/**
 * Persistent application top bar: breadcrumb context, global search
 * (delegates to the Events explorer — the only honest searchable dataset),
 * live WebSocket status, aggregate system health, and the ⌘K hint.
 */
export function TopBar({
  route,
  crumbExtra,
  wsConnected,
  metricsLoaded,
  updatedAt,
  onOpenPalette,
  onSearch,
}: {
  route: string;
  crumbExtra?: ReactNode;
  wsConnected: boolean;
  metricsLoaded: boolean;
  updatedAt?: string | null;
  onOpenPalette: () => void;
  onSearch: (q: string) => void;
}) {
  const snap = useHealth();
  const deps = snap.ready?.dependencies;

  const services = [
    deps?.postgres?.status,
    deps?.kafka?.status,
    deps?.redis?.status,
    deps?.workers?.persistence_worker?.status,
    deps?.workers?.analytics_worker?.status,
  ];
  const known = services.filter((s) => s !== undefined);
  const health =
    known.length === 0
      ? undefined
      : known.every((s) => s === "healthy")
        ? "healthy"
        : known.some((s) => s === "unhealthy" || s === "unavailable")
          ? "unavailable"
          : "degraded";

  return (
    <div className="topbar">
      <span className="crumb">
        <span className="crumb-root">PulseStream</span>
        <span className="crumb-sep">/</span>
        <span>{route.charAt(0).toUpperCase() + route.slice(1)}</span>
        {crumbExtra ? <span className="crumb-extra">{crumbExtra}</span> : null}
      </span>
      <span className="health-pill" title="Deployment environment (derived from hostname)">
        ENV: <b>{window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "LOCAL" : "REMOTE"}</b>
      </span>

      <div
        className="topbar-search"
        role="search"
        onClick={(e) => {
          const input = (e.currentTarget.querySelector("input") as HTMLInputElement | null);
          input?.focus();
        }}
      >
        <span aria-hidden>⌕</span>
        <input
          placeholder="Search events…"
          aria-label="Global event search"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSearch((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>

      <div className="topbar-right">
        <span className="live-pill" title={wsConnected ? "WebSocket connected — live updates" : "WebSocket down — REST polling fallback"}>
          <span className={`pulse-dot ${wsConnected ? "ok pulsing" : metricsLoaded ? "warn" : "down"}`} aria-hidden />
          {wsConnected ? "Live" : metricsLoaded ? "Polling" : "Offline"}
        </span>

        <span className="health-pill" title="Aggregate dependency health from /api/v1/ready">
          <Badge status={health} />
        </span>

        <span className="updated-at" title="Last metrics update">
          {updatedAt ? `Last updated: ${updatedAt}` : "waiting…"}
        </span>

        <button type="button" className="btn" onClick={onOpenPalette} aria-label="Open command menu">
          ⌘K
        </button>
      </div>
    </div>
  );
}
