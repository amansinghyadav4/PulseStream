

/** Map an honest backend status string to a visual tone. Never guesses "ok". */
export function toneForStatus(status) {
  switch (status) {
    case "healthy":
    case "ready":
    case "running":
    case "connected":
      return "ok";
    case "degraded":
    case "disabled":
      return "warn";
    case "unhealthy":
    case "unavailable":
    case "not_ready":
    case "stopped":
      return "error";
    default:
      return "neutral";
  }
}

const LABELS = {
  healthy: "Healthy",
  ready: "Ready",
  running: "Running",
  connected: "Connected",
  degraded: "Degraded",
  disabled: "Disabled",
  unhealthy: "Unhealthy",
  unavailable: "Unavailable",
  not_ready: "Not ready",
  stopped: "Stopped",
};

/** Human wording for a raw backend status string. Single source of truth. */
export function statusLabel(status) {
  return LABELS[String(status)] ?? (status === undefined || status === null ? "Unknown" : String(status));
}

export function Badge({
  status,
  label,
  pulse = false,
  dotOnly = false,
}) {
  const tone = toneForStatus(status);
  const text = label ?? statusLabel(status);
  return (
    <span className={`badge ${tone} ${dotOnly ? "badge-dot-only" : ""}`} aria-label={dotOnly ? text : undefined}>
      <span
        className={`dot ${pulse ? "pulse-dot pulsing" : ""}`}
        style={tone === "ok" ? { color: "var(--ok)" } : undefined}
        aria-hidden
      />
      {dotOnly ? null : text}
    </span>
  );
}
