import type { DependencyStatus } from "../types/metrics";

export type BadgeTone = "ok" | "warn" | "error" | "neutral";

/** Map an honest backend status string to a visual tone. Never guesses "ok". */
export function toneForStatus(status: DependencyStatus | undefined | null): BadgeTone {
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

const LABELS: Record<string, string> = {
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

export function Badge({
  status,
  label,
  pulse = false,
  dotOnly = false,
}: {
  /** Backend status string, or undefined for unknown */
  status?: DependencyStatus | null;
  /** Override display text (e.g. "No data") */
  label?: string;
  pulse?: boolean;
  /** Render only the colored status dot (no pill/text); text becomes the aria-label */
  dotOnly?: boolean;
}) {
  const tone = toneForStatus(status);
  const text = label ?? LABELS[String(status)] ?? "Unknown";
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
