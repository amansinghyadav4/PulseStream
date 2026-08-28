import { useHealth, type HealthSnapshot } from "../hooks/useHealth";
import { nodeStatus } from "../lib/serviceDetails";
import { Badge } from "../ui/Badge";

interface StripItem {
  name: string;
  metric?: (s: HealthSnapshot) => string;
  statusOverride?: (s: HealthSnapshot, ws: boolean) => string | undefined;
}

const ITEMS: StripItem[] = [
  { name: "API", metric: (_s) => "" },
  {
    name: "PostgreSQL",
    metric: (s) =>
      s.ready?.dependencies?.postgres?.latency_ms !== undefined
        ? `${s.ready.dependencies.postgres.latency_ms} ms`
        : "",
  },
  { name: "Kafka" },
  { name: "Redis" },
  {
    name: "Persistence Worker",
    metric: workerMetric("persistence_worker"),
  },
  {
    name: "Analytics Worker",
    metric: workerMetric("analytics_worker"),
  },
  { name: "WebSocket" },
];

function workerMetric(field: "persistence_worker" | "analytics_worker") {
  return (s: HealthSnapshot) => {
    const hb = s.ready?.dependencies?.workers?.[field];
    if (!hb?.lag) return "";
    return `lag ${Object.values(hb.lag).reduce((a, b) => a + b, 0)}`;
  };
}

/**
 * Compact horizontal service-health strip for the Overview. Clicking a chip
 * selects the corresponding pipeline node (opens the right-side inspector).
 */
export function SystemHealthStrip({
  wsConnected,
  eventsPerSecond = 0,
  selected,
  onSelect,
}: {
  wsConnected: boolean;
  eventsPerSecond?: number;
  selected?: string | null;
  onSelect?: (service: string) => void;
}) {
  const snap = useHealth();

  return (
    <div className="svc-strip">
      {ITEMS.map(({ name, metric, statusOverride }) => {
        const status = statusOverride ? statusOverride(snap, wsConnected) : nodeStatus(name, snap, wsConnected);
        let line = metric?.(snap) ?? "";
        if (name === "API" && eventsPerSecond !== undefined) line = `${eventsPerSecond} ev/s`;
        if (name === "WebSocket") line = wsConnected ? "live" : snap.ready?.dependencies?.broadcaster?.status === "running" ? "polling" : "down";
        return (
          <button
            key={name}
            type="button"
            className={`svc-chip ${selected === name ? "selected" : ""}`}
            onClick={() => onSelect?.(name)}
            aria-label={`${name}: ${status ?? "unknown"}${line ? `, ${line}` : ""}`}
          >
            <span className="sc-name">
              <Badge status={status ?? undefined} dotOnly />
              {name}
            </span>
            <span className="sc-status">{statusLabel(status)}</span>
            {line ? <span className="sc-metric">{line}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function statusLabel(status: string | undefined): string {
  if (!status) return "unknown";
  const map: Record<string, string> = {
    healthy: "Healthy",
    connected: "Connected",
    degraded: "Degraded",
    unavailable: "Unavailable",
    unhealthy: "Unhealthy",
    stopped: "Stopped",
    running: "Running",
    disabled: "Disabled",
    unknown: "Unknown",
  };
  return map[status] ?? status;
}
