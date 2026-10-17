import { useHealth } from "../hooks/useHealth";
import { nodeStatus } from "../lib/serviceDetails";
import { formatCount } from "../lib/format";
import { statusLabel, toneForStatus } from "../ui/Badge";

/**
 * Pipeline strip — the event path as one line, with a real reading per stage.
 *
 * Orientation: events enter from the left and reach this browser on the right.
 * The strip does not re-create the topology (the Pipeline page owns that, with
 * its fork into persistence and analytics lanes); it answers the overview
 * question "which stage needs attention" without inventing a single number.
 *
 * Each stage's second line is either a number the backend reported or the
 * status word itself. Storage is the point where the two lanes split, so it
 * names both stores instead of pretending there is one.
 */

function Stage({ label, status, tone, detail, note, onOpen }) {
  return (
    <button
      type="button"
      className={`ps-stage tone-${tone}`}
      onClick={onOpen}
      aria-label={`${label}: ${statusLabel(status)}${detail ? `, ${detail}` : ""}. Open pipeline.`}
    >
      <span className="ps-stage-name">
        <span className={`dep-dot tone-${tone}`} aria-hidden />
        {label}
      </span>
      <span className="ps-stage-reading">{detail ?? statusLabel(status)}</span>
      {note ? <span className="ps-stage-note">{note}</span> : null}
    </button>
  );
}

export function PipelineStrip({ wsConnected, metrics, onOpen }) {
  const snap = useHealth();
  const deps = snap.ready?.dependencies;
  const rate = metrics?.events_per_second;

  const workers = [
    deps?.workers?.persistence_worker,
    deps?.workers?.analytics_worker,
  ].filter(Boolean);
  const workerStatus = workers.length === 0
    ? undefined
    : workers.some((w) => w.status !== "running" && w.status !== "healthy")
      ? "degraded"
      : "running";
  const workerLag = workers.length === 0
    ? undefined
    : workers.reduce(
        (sum, w) => sum + (w.lag ? Object.values(w.lag).reduce((a, b) => a + b, 0) : 0),
        0
      );

  const wsTone = toneForStatus(nodeStatus("WebSocket", snap, wsConnected));

  const stages = [
    {
      label: "Sources",
      status: metrics ? "healthy" : undefined,
      detail: metrics ? `${formatCount(metrics.active_producers)} active` : undefined,
      note: "clients sending events",
    },
    {
      label: "API",
      status: nodeStatus("API", snap, wsConnected),
      detail: metrics && rate !== undefined ? `${formatCount(rate)} ev/s` : undefined,
      note: "ingest endpoint",
    },
    {
      label: "Kafka",
      status: deps?.kafka?.status,
      detail: deps?.kafka?.status === "healthy" ? "accepting" : deps?.kafka?.detail,
      note: "durable log",
    },
    {
      label: "Workers",
      status: workerStatus,
      detail:
        workers.length > 0
          ? workerLag === 0
            ? "caught up"
            : `lag ${formatCount(workerLag)}`
          : undefined,
      note: "persist · analyze",
    },
    {
      label: "Storage",
      status:
        deps?.postgres?.status && deps?.redis?.status
          ? deps.postgres.status === "healthy" && deps.redis.status === "healthy"
            ? "healthy"
            : deps.postgres.status !== "healthy"
              ? deps.postgres.status
              : deps.redis.status
          : deps?.postgres?.status,
      detail:
        deps?.postgres?.latency_ms !== undefined && deps?.redis
          ? `PG ${deps.postgres.latency_ms} ms · Redis`
          : undefined,
      note: "PostgreSQL · Redis",
    },
    {
      label: "Dashboard",
      status: wsConnected ? "connected" : nodeStatus("WebSocket", snap, wsConnected),
      detail: wsConnected
        ? `${formatCount(deps?.broadcaster?.websocket_clients ?? 0)} client${
            (deps?.broadcaster?.websocket_clients ?? 0) === 1 ? "" : "s"
          }`
        : "REST polling",
      note: "live over WebSocket",
      tone: wsTone,
    },
  ];

  return (
    <section className="pipeline-strip" aria-label="Event path">
      <div className="pipeline-strip-head">
        <h2>Event path</h2>
        <span className="hint">
          sources → API → Kafka → workers → storage → this browser · readings from
          /api/v1/ready and the live snapshot
        </span>
        <button type="button" className="btn ghost sm" onClick={onOpen}>
          Full topology →
        </button>
      </div>
      <div className="ps-track">
        {stages.map((s, i) => (
          <div className="ps-cell" key={s.label}>
            <Stage
              {...s}
              tone={s.tone ?? toneForStatus(s.status)}
              onOpen={onOpen}
            />
            {i < stages.length - 1 ? (
              <span
                className={`ps-link ${s.status === "healthy" || s.status === "connected" ? "is-live" : ""}`}
                aria-hidden
              >
                →
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
