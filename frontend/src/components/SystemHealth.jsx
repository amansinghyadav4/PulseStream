import { useState } from "react";
import { formatCount } from "../lib/format";
import { useHealth } from "../hooks/useHealth";
import { serviceDetailRows, nodeStatus } from "../lib/serviceDetails";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { SkeletonLines } from "../ui/Skeleton";

const SERVICES = [
  { name: "API", metric: (s) => (s.apiReachable ? "liveness OK" : "not responding") },
  {
    name: "PostgreSQL",
    metric: (s) =>
      s.ready?.dependencies?.postgres?.latency_ms !== undefined
        ? `query ${s.ready.dependencies.postgres.latency_ms} ms`
        : "",
  },
  { name: "Kafka", metric: (s) => s.ready?.dependencies?.kafka?.detail ?? "" },
  {
    name: "Persistence Worker",
    metric: workerLag("persistence_worker"),
  },
  {
    name: "Analytics Worker",
    metric: workerLag("analytics_worker"),
  },
  { name: "Redis", metric: () => "" },
  {
    name: "WebSocket",
    metric: (_s) => "",
  },
];

function workerLag(field) {
  return (s) => {
    const hb = s.ready?.dependencies?.workers?.[field];
    if (!hb?.lag) return "";
    return `lag ${formatCount(Object.values(hb.lag).reduce((a, b) => a + b, 0))}`;
  };
}

/**
 * SYSTEM — infrastructure control plane. Expandable service rows with real
 * reported values; clicking a row reveals every field the backend provides.
 */
export function SystemHealth({ wsConnected }) {
  const snap = useHealth();
  const [open, setOpen] = useState(null);

  const loading = !snap.ready && snap.apiReachable === null;

  return (
    <Card title="Service status" hint="reported by /api/v1/ready · click a row for details · refreshed every 5s">
      {loading ? (
        <SkeletonLines rows={5} />
      ) : (
        <div className="svc-list">
          {SERVICES.map(({ name, metric }) => {
            const status =
              name === "WebSocket"
                ? wsConnected
                  ? "connected"
                  : snap.ready?.dependencies?.broadcaster?.status === "running"
                    ? "degraded"
                    : "stopped"
                : nodeStatus(name, snap, wsConnected);
            const isOpen = open === name;
            return (
              <div key={name}>
                <div
                  className={`svc-row ${isOpen ? "selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpen(isOpen ? null : name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpen(isOpen ? null : name);
                    }
                  }}
                  aria-expanded={isOpen}
                  aria-label={`${name} service details`}
                >
                  <span className="svc-name">{name}</span>
                  <Badge
                    status={status ?? undefined}
                    pulse={status === "healthy"}
                    label={status === undefined ? "Unavailable" : undefined}
                  />
                  <span className="svc-metric">{metric(snap) || "—"}</span>
                  <span className="svc-chevron" aria-hidden>
                    {isOpen ? "▾" : "▸"}
                  </span>
                </div>
                {isOpen ? (
                  <div className="svc-detail">
                    {serviceDetailRows(name, snap, wsConnected).map((row) => (
                      <DetailRowInline key={row.label} label={row.label} value={row.value} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function DetailRowInline({ label, value }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className={`detail-value ${value === "Not available" ? "na" : ""}`}>{value}</span>
    </div>
  );
}
