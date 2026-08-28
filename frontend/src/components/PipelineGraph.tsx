import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHealth } from "../hooks/useHealth";
import { nodeStatus } from "../lib/serviceDetails";
import { Badge } from "../ui/Badge";

export type PipeService =
  | "API"
  | "Kafka"
  | "Persistence Worker"
  | "Analytics Worker"
  | "PostgreSQL"
  | "Redis"
  | "WebSocket";

type Snap = ReturnType<typeof useHealth>;

interface NodeDef {
  service: PipeService;
  area: string;
  detail?: (snap: Snap, evs: number, ws: boolean) => string | undefined;
}

function workerLag(s: Snap, which: "persist" | "analytics"): string | undefined {
  const w = s.ready?.dependencies?.workers;
  const hb = which === "persist" ? w?.persistence_worker : w?.analytics_worker;
  if (!hb?.lag) return undefined;
  return `lag ${Object.values(hb.lag).reduce((a, b) => a + b, 0)}`;
}

/**
 * Node order reflects the REAL topology (verified against the backend):
 *   API → Kafka → Persistence Worker → PostgreSQL      (persistence lane)
 *                → Analytics Worker → Redis → WebSocket (analytics lane)
 * The two lanes branch at Kafka and never re-merge — the persistence worker
 * writes PostgreSQL, the analytics worker writes Redis, and the broadcaster
 * streams the Redis aggregates over the WebSocket. Grid areas place the nodes;
 * the DOM order is independent of the visual placement.
 */
const NODES: NodeDef[] = [
  { service: "API", area: "api", detail: (_s, evs) => `ingesting ${evs} ev/s` },
  { service: "Kafka", area: "kafka", detail: (_s, evs) => `buffering ${evs} ev/s` },
  { service: "Persistence Worker", area: "persist", detail: (s) => workerLag(s, "persist") },
  { service: "Analytics Worker", area: "analytics", detail: (s) => workerLag(s, "analytics") },
  {
    service: "PostgreSQL",
    area: "pg",
    detail: (s) =>
      s.ready?.dependencies?.postgres?.latency_ms !== undefined
        ? `query ${s.ready.dependencies.postgres.latency_ms} ms`
        : undefined,
  },
  { service: "Redis", area: "redis" },
  { service: "WebSocket", area: "ws", detail: (_s, _e, ws) => (ws ? "streaming live" : "REST polling") },
];

interface Edge {
  x1: number;
  x2: number;
  cy: number;
}

interface Geo {
  w: number;
  h: number;
  edges: Partial<Record<PipeService, Edge>>;
}

// PLACEHOLDER_BODY

/**
 * Topology pipeline with a MEASURED SVG connector layer.
 *
 * Nodes live on a two-row CSS grid (persistence lane on top, analytics lane on
 * the bottom); an absolutely-positioned SVG draws edge-to-edge connectors from
 * live bounding-box measurements, so every line starts and ends exactly on a
 * node edge. The flow forks at Kafka into the two lanes and never re-merges.
 * Flow dashes animate downstream (start→end of each path) only when ev/s > 0.
 * Clicking or Enter/Space on a node selects it for the right-rail inspector.
 */
export function PipelineGraph({
  wsConnected,
  active,
  eventsPerSecond = 0,
  selected,
  onSelect,
}: {
  wsConnected: boolean;
  active: boolean;
  eventsPerSecond?: number;
  selected?: string | null;
  onSelect?: (service: PipeService) => void;
}) {
  const snap = useHealth();
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Partial<Record<PipeService, HTMLDivElement | null>>>({});
  const [geo, setGeo] = useState<Geo>({ w: 0, h: 0, edges: {} });

  const measure = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const cb = c.getBoundingClientRect();
    const edges: Geo["edges"] = {};
    for (const [service, el] of Object.entries(nodeRefs.current)) {
      if (!el) continue;
      const b = el.getBoundingClientRect();
      edges[service as PipeService] = {
        x1: b.left - cb.left,
        x2: b.right - cb.left,
        cy: b.top - cb.top + b.height / 2,
      };
    }
    setGeo({ w: cb.width, h: cb.height, edges });
  }, []);

  useLayoutEffect(() => {
    measure();
    let ro: ResizeObserver | undefined;
    // ResizeObserver is unavailable in some environments (jsdom) — fall back to
    // window resize only, so the component still renders/tests.
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      if (containerRef.current) ro.observe(containerRef.current);
    }
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // Re-measure when the content that can change a node's size changes (status
  // badges, ev/s label, worker lag), so connectors stay pinned to the edges.
  useEffect(() => {
    measure();
  }, [measure, eventsPerSecond, wsConnected, snap.ready, active]);

  const e = geo.edges;
  const has = (k: PipeService): boolean => !!e[k];

  const straight = (a: PipeService, b: PipeService): string =>
    has(a) && has(b) ? `M ${e[a]!.x2} ${e[a]!.cy} L ${e[b]!.x1} ${e[b]!.cy}` : "";

  // A smooth S-curve from Kafka's right edge (fork point, vertically centred
  // between the lanes) up/down to a worker's left edge.
  const fork = (to: PipeService): string => {
    if (!has("Kafka") || !has(to)) return "";
    const kx = e["Kafka"]!.x2;
    const ky = e["Kafka"]!.cy;
    const tx = e[to]!.x1;
    const ty = e[to]!.cy;
    const splitX = kx + (tx - kx) * 0.38; // short horizontal stub off Kafka
    const mx = (splitX + tx) / 2; // control-point x for the S-curve
    return `M ${kx} ${ky} L ${splitX} ${ky} C ${mx} ${ky}, ${mx} ${ty}, ${tx} ${ty}`;
  };

  // Connectors in flow order. Each is drawn upstream→downstream so the dash
  // animation (dashoffset 20→0) travels in the real event-flow direction.
  const connectors: string[] = [
    straight("API", "Kafka"),
    fork("Persistence Worker"),
    fork("Analytics Worker"),
    straight("Persistence Worker", "PostgreSQL"),
    straight("Analytics Worker", "Redis"),
    straight("Redis", "WebSocket"),
  ].filter(Boolean);

  const forkPoint = has("Kafka") ? { x: e["Kafka"]!.x2, y: e["Kafka"]!.cy } : null;

  return (
    <div className={`pipe-topo ${active ? "active" : ""}`} ref={containerRef}>
      {geo.w > 0 && (
        <svg
          className="pt-svg"
          width={geo.w}
          height={geo.h}
          viewBox={`0 0 ${geo.w} ${geo.h}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {connectors.map((d, i) => (
            <path key={`c${i}`} className="pt-conn-path" d={d} />
          ))}
          {active &&
            connectors.map((d, i) => <path key={`f${i}`} className="pt-flow" d={d} />)}
          {forkPoint && <circle cx={forkPoint.x} cy={forkPoint.y} r="3.5" className="pt-fork-dot" />}
        </svg>
      )}

      {NODES.map((node) => {
        const status = nodeStatus(node.service, snap, wsConnected);
        return (
          <div
            key={node.service}
            ref={(el) => {
              nodeRefs.current[node.service] = el;
            }}
            role="button"
            tabIndex={0}
            style={{ gridArea: node.area }}
            className={`pt-node ${selected === node.service ? "selected" : ""}`}
            onClick={() => onSelect?.(node.service)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect?.(node.service);
              }
            }}
            aria-label={`Inspect ${node.service}`}
          >
            <span className="pt-name">
              {node.service}
              <Badge status={status} pulse={status === "healthy"} />
            </span>
            <span className="pt-detail">{node.detail?.(snap, eventsPerSecond, wsConnected) ?? statusLabel(status)}</span>
          </div>
        );
      })}
    </div>
  );
}

function statusLabel(status: string | undefined): string {
  if (!status) return "unknown";
  const map: Record<string, string> = {
    healthy: "healthy",
    connected: "connected",
    degraded: "degraded",
    disabled: "disabled",
    unavailable: "unavailable",
    unhealthy: "unhealthy",
    stopped: "stopped",
    running: "running",
    unknown: "unknown",
  };
  return map[status] ?? status;
}
