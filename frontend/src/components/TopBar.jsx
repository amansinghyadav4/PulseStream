import { useHealth } from "../hooks/useHealth";
import { Badge } from "../ui/Badge";
import { IconSearch } from "./icons";

/** Aggregate dependency verdict from the real /ready payload. Undefined until
 *  at least one dependency has reported — never guessed as healthy. */
export function aggregateHealth(snap) {
  const deps = snap.ready?.dependencies;
  if (!deps) return undefined;
  const services = [
    deps?.postgres?.status,
    deps?.kafka?.status,
    deps?.redis?.status,
    deps?.workers?.persistence_worker?.status,
    deps?.workers?.analytics_worker?.status,
  ].filter((s) => s !== undefined);

  if (services.length === 0) return undefined;
  if (services.every((s) => s === "healthy")) return "healthy";
  if (services.some((s) => s === "unhealthy" || s === "unavailable")) return "unavailable";
  return "degraded";
}

/**
 * Persistent console header: where you are, how to search, and the state of the
 * connection. Deliberately sparse — the operational detail belongs in the
 * content area, not in the chrome.
 */
export function TopBar({
  route,
  pageTitle,
  crumbExtra,
  wsConnected,
  metricsLoaded,
  updatedAt,
  onOpenPalette,
  onSearch,
}) {
  const snap = useHealth();
  const health = aggregateHealth(snap);

  return (
    <header className="topbar">
      <nav className="crumb" aria-label="Breadcrumb">
        <span className="crumb-root">PulseStream</span>
        <span className="crumb-sep" aria-hidden>
          /
        </span>
        <span className="crumb-current" aria-current="page">
          {pageTitle ?? route}
        </span>
        {crumbExtra ? <span className="crumb-extra">{crumbExtra}</span> : null}
      </nav>

      <div
        className="topbar-search"
        role="search"
        onClick={(e) => {
          const input = e.currentTarget.querySelector("input");
          input?.focus();
        }}
      >
        <IconSearch size={14} />
        <input
          placeholder="Search events by id, type, source or user…"
          aria-label="Global event search"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSearch(e.target.value);
              e.target.blur();
            }
          }}
        />
        <button
          type="button"
          className="kbd-hint"
          onClick={(e) => {
            e.stopPropagation();
            onOpenPalette();
          }}
          aria-label="Open command menu"
          title="Open the command menu"
        >
          ⌘K
        </button>
      </div>

      <div className="topbar-right">
        <span
          className="live-pill"
          title={
            wsConnected
              ? "WebSocket connected — metrics stream live"
              : metricsLoaded
                ? "WebSocket down — falling back to REST polling every second"
                : "No metrics yet — waiting for the first update"
          }
        >
          <span
            className={`pulse-dot ${wsConnected ? "ok pulsing" : metricsLoaded ? "warn" : "down"}`}
            aria-hidden
          />
          {wsConnected ? "Live" : metricsLoaded ? "Polling" : "Offline"}
        </span>

        <span className="health-pill" title="Aggregate dependency health from /api/v1/ready">
          <Badge status={health} label={health === undefined ? "Checking" : undefined} />
        </span>

        <span className="updated-at" title="Last metrics update">
          {updatedAt ? `updated ${updatedAt}` : "waiting…"}
        </span>
      </div>
    </header>
  );
}
