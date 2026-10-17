import { useHealth } from "../hooks/useHealth";
import { nodeStatus } from "../lib/serviceDetails";
import { formatCount } from "../lib/format";
import { statusLabel, toneForStatus } from "../ui/Badge";
import { IconAlertTriangle, IconCheckCircle, IconPulse } from "./icons";

/**
 * The answer to "is PulseStream healthy?", stated once at the top of the
 * overview: a verdict, the reasons behind it, and the readings it was derived
 * from. Nothing is inferred — a dependency that has not reported says so.
 */

const DEPENDENCIES = ["API", "PostgreSQL", "Kafka", "Redis", "Persistence Worker", "Analytics Worker", "WebSocket"];

/** One honest reading per dependency, straight from /ready. */
function reading(name, snap, ctx) {
  const deps = snap.ready?.dependencies;
  switch (name) {
    case "API":
      return snap.apiReachable === null ? "—" : snap.apiReachable ? `${ctx.rate} ev/s` : "not responding";
    case "PostgreSQL": {
      const ms = deps?.postgres?.latency_ms;
      return ms === undefined || ms === null ? "—" : `${ms} ms`;
    }
    case "Kafka":
      return deps?.kafka?.detail ?? "—";
    case "Redis":
      return deps?.redis?.detail ?? "—";
    case "Persistence Worker":
    case "Analytics Worker": {
      const hb = deps?.workers?.[name === "Persistence Worker" ? "persistence_worker" : "analytics_worker"];
      if (!hb?.lag) return "—";
      const total = Object.values(hb.lag).reduce((a, b) => a + b, 0);
      return total === 0 ? "lag 0" : `lag ${formatCount(total)}`;
    }
    case "WebSocket":
      return ctx.wsConnected ? `${ctx.clients} client${ctx.clients === 1 ? "" : "s"}` : "REST fallback";
    default:
      return "—";
  }
}

function MarkIcon({ tone }) {
  if (tone === "ok") return <IconCheckCircle size={16} />;
  if (tone === "neutral") return <IconPulse size={16} />;
  return <IconAlertTriangle size={16} />;
}

/**
 * Derives the verdict from reported facts only, ordered by operational
 * severity: a hard dependency failure outranks a soft degradation, and an
 * unknown state is stated plainly rather than assumed healthy.
 */
function deriveVerdict(snap, tones, wsConnected, metrics) {
  if (snap.apiReachable === false) {
    return {
      tone: "error",
      icon: "error",
      title: "Ingestion API is unreachable",
      reason:
        "The dashboard cannot reach /health, so no events are being accepted right now. The metrics below are the last values received before the connection dropped.",
    };
  }

  if (!snap.ready && snap.apiReachable === null) {
    return {
      tone: "neutral",
      icon: "neutral",
      title: "Checking system health…",
      reason: "Waiting for the first reading from the readiness endpoint.",
    };
  }

  if (tones.PostgreSQL === "error") {
    return {
      tone: "error",
      title: "PostgreSQL is not accepting queries",
      reason:
        "PostgreSQL holds the stored events, so ingestion persistence and the Events explorer are both affected. Investigate the database first — everything else depends on it.",
    };
  }

  const soft = ["Kafka", "Redis", "Persistence Worker", "Analytics Worker"].filter((n) => tones[n] !== "ok");
  if (soft.length > 0) {
    return {
      tone: "warn",
      title: soft.length === 1 ? `${soft[0]} is degraded` : `${soft.length} dependencies are degraded`,
      reason: `${soft.join(", ")} ${soft.length === 1 ? "is" : "are"} not reporting fully healthy. Ingestion continues where it can, but the affected stage may fall behind — open the pipeline to see which stage is holding it back.`,
    };
  }

  const lag = typeof metrics?.consumer_lag === "number" ? metrics.consumer_lag : null;
  const parts = [];
  if (metrics) {
    parts.push(
      `Ingesting ${formatCount(metrics.events_per_second ?? 0)} events/sec; ${formatCount(metrics.events_processed_total ?? metrics.total ?? 0)} processed in total.`
    );
  }
  if (lag === null) {
    parts.push("Consumer lag has not been reported by the workers yet.");
  } else if (lag === 0) {
    parts.push("Workers are caught up — no consumer backlog.");
  } else {
    parts.push(
      `Workers are ${formatCount(lag)} events behind, so processing is not keeping up with ingestion.`
    );
  }
  const failed = metrics?.events_failed_total;
  if (typeof failed === "number" && failed > 0) {
    parts.push(`${formatCount(failed)} events have been dead-lettered.`);
  }

  if (!wsConnected) {
    return {
      tone: "warn",
      title: "Healthy, but the live socket is down",
      reason:
        "Every dependency reports healthy. This dashboard is reading metrics over REST polling instead of the WebSocket stream, so updates may arrive a second late.",
    };
  }

  return {
    tone: "ok",
    title: "All dependencies reporting healthy",
    reason: parts.join(" "),
  };
}

export function SystemVerdict({ wsConnected, metrics, selected, onSelect, onOpenHealth, onOpenPipeline }) {
  const snap = useHealth();
  const clients = snap.ready?.dependencies?.broadcaster?.websocket_clients ?? 0;
  const ctx = { wsConnected, clients, rate: formatCount(metrics?.events_per_second ?? 0) };

  const tones = Object.fromEntries(
    DEPENDENCIES.map((name) => [name, toneForStatus(nodeStatus(name, snap, wsConnected))])
  );
  const readings = DEPENDENCIES.map((name) => ({
    name,
    status: nodeStatus(name, snap, wsConnected),
    tone: tones[name],
    value: reading(name, snap, ctx),
  }));

  const verdict = deriveVerdict(snap, tones, wsConnected, metrics);

  return (
    <section className={`verdict tone-${verdict.tone}`} aria-label="System health summary">
      <span className="verdict-mark" aria-hidden>
        <MarkIcon tone={verdict.icon ?? verdict.tone} />
      </span>

      <div className="verdict-body">
        <h2 className="verdict-title">{verdict.title}</h2>
        <p className="verdict-reason">{verdict.reason}</p>

        <div className="verdict-deps">
          {readings.map((r) => (
            <button
              key={r.name}
              type="button"
              className={`dep ${selected === r.name ? "is-selected" : ""}`}
              onClick={() => onSelect?.(selected === r.name ? null : r.name)}
              aria-pressed={selected === r.name}
              aria-label={`${r.name}: ${statusLabel(r.status)}, ${r.value}. Show dependency detail.`}
            >
              <span className="dep-name">
                <span className={`dep-dot tone-${r.tone}`} aria-hidden />
                {r.name}
              </span>
              <span className="dep-meta">
                {statusLabel(r.status)} · {r.value}
              </span>
            </button>
          ))}
        </div>
      </div>

      {onOpenHealth || onOpenPipeline ? (
        <div className="verdict-actions">
          {onOpenPipeline ? (
            <button type="button" className="btn ghost sm" onClick={onOpenPipeline}>
              Open pipeline →
            </button>
          ) : null}
          {onOpenHealth ? (
            <button type="button" className="btn ghost sm" onClick={onOpenHealth}>
              All dependencies →
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
