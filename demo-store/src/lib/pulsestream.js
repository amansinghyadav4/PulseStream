/**
 * The ONLY way the demo store talks to PulseStream: HTTP POST to the public
 * events API, exactly like any external customer application would.
 *
 * No PostgreSQL. No Redis. No Kafka. No internal services. If you are looking
 * for a data store in this app, there isn't one — PulseStream is the backend.
 */

const INITIAL = {
  sent: 0,
  failed: 0,
  lastEventType: null,
  lastError: null,
  lastOutcome: "idle",
};

/**
 * Tiny observable client. One instance per app; stats reflect REAL request
 * outcomes only — nothing is counted as sent unless the API answered 2xx.
 */
export class PulseStreamClient {
  stats = { ...INITIAL };
  listeners = new Set();

  constructor(baseUrl = "/api/v1") {
    this.baseUrl = baseUrl;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.getStats());
    return () => {
      this.listeners.delete(fn);
    };
  }

  getStats() {
    return { ...this.stats };
  }

  emit() {
    const snap = this.getStats();
    this.listeners.forEach((fn) => fn(snap));
  }

  /** Submit one event. Resolves true iff the API accepted it (2xx). */
  async send(event) {
    try {
      const r = await fetch(`${this.baseUrl}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!r.ok) {
        // Read the structured error body for display, but never trust it as success.
        let detail = `HTTP ${r.status}`;
        try {
          const body = await r.json();
          if (body?.error?.message) detail = `${detail}: ${body.error.message}`;
        } catch {
          /* non-JSON error body is fine */
        }
        this.stats = {
          ...this.stats,
          failed: this.stats.failed + 1,
          lastEventType: event.event_type,
          lastError: detail,
          lastOutcome: "fail",
        };
        this.emit();
        return false;
      }
      this.stats = {
        ...this.stats,
        sent: this.stats.sent + 1,
        lastEventType: event.event_type,
        lastError: null,
        lastOutcome: "ok",
      };
      this.emit();
      return true;
    } catch (e) {
      this.stats = {
        ...this.stats,
        failed: this.stats.failed + 1,
        lastEventType: event.event_type,
        lastError: e instanceof Error ? e.message : "network error",
        lastOutcome: "fail",
      };
      this.emit();
      return false;
    }
  }
}

/** Base URL is configurable for deployment; same-origin default works everywhere. */
export function defaultBaseUrl() {
  // Vite injects VITE_* vars at build time; empty/undefined falls back safely.
  return import.meta.env.VITE_PULSESTREAM_API || "/api/v1";
}
