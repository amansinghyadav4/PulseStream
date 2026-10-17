import { formatCount } from "./format";

/**
 * Every field the backend actually reports for a service, in display form.
 * Missing information becomes "Not available" — never inferred.
 */
export function serviceDetailRows(
  service,
  snap,
  wsConnected
) {
  const deps = snap.ready?.dependencies;

  switch (service) {
    case "API":
      return [
        { label: "Liveness", value: snap.apiReachable ? "responding (HTTP 200)" : "not responding" },
        { label: "Readiness", value: snap.ready?.status ?? "Not available" },
      ];
    case "Kafka":
      return [
        { label: "Status", value: deps?.kafka?.status ?? "Unavailable" },
        { label: "Detail", value: deps?.kafka?.detail ?? "Not available" },
      ];
    case "PostgreSQL":
      return [
        { label: "Status", value: deps?.postgres?.status ?? "Unavailable" },
        {
          label: "Query latency",
          value: deps?.postgres?.latency_ms !== undefined ? `${deps.postgres.latency_ms} ms` : "Not available",
        },
        { label: "Error", value: deps?.postgres?.error ?? "None" },
      ];
    case "Redis":
      return [
        { label: "Status", value: deps?.redis?.status ?? "Unavailable" },
        { label: "Detail", value: deps?.redis?.detail ?? "Not available" },
      ];
    case "Persistence Worker":
    case "Analytics Worker": {
      const hb =
        service === "Persistence Worker" ? deps?.workers?.persistence_worker : deps?.workers?.analytics_worker;
      const lag = hb?.lag ? Object.values(hb.lag).reduce((a, b) => a + b, 0) : undefined;
      return [
        { label: "Status", value: hb?.status ?? "Unknown" },
        {
          label: "Heartbeat TTL",
          value: hb?.heartbeat_ttl_s !== undefined ? `${hb.heartbeat_ttl_s}s remaining` : "Not available",
        },
        { label: "Consumer lag", value: lag !== undefined ? formatCount(lag) : "Not available" },
        { label: "Group", value: hb?.group ?? "Not available" },
      ];
    }
    case "WebSocket":
      return [
        { label: "This dashboard", value: wsConnected ? "connected" : "not connected (REST polling)" },
        { label: "Broadcaster", value: deps?.broadcaster?.status ?? "Unavailable" },
        {
          label: "Clients connected",
          value:
            deps?.broadcaster?.websocket_clients !== undefined
              ? String(deps.broadcaster.websocket_clients)
              : "Not available",
        },
      ];
    default:
      return [];
  }
}

/** Aggregate status string for a pipeline node. */
export function nodeStatus(
  service,
  snap,
  wsConnected
) {
  const deps = snap.ready?.dependencies;
  switch (service) {
    case "API":
      return snap.apiReachable ? "healthy" : "unavailable";
    case "Kafka":
      return deps?.kafka?.status;
    case "PostgreSQL":
      return deps?.postgres?.status;
    case "Redis":
      return deps?.redis?.status;
    case "WebSocket":
      return wsConnected ? "connected" : deps?.broadcaster?.status === "running" ? "degraded" : "stopped";
    case "Persistence Worker":
      return deps?.workers?.persistence_worker?.status;
    case "Analytics Worker":
      return deps?.workers?.analytics_worker?.status;
    default:
      return undefined;
  }
}
