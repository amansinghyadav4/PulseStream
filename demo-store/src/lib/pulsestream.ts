/**
 * The ONLY way the demo store talks to PulseStream: HTTP POST to the public
 * events API, exactly like any external customer application would.
 *
 * No PostgreSQL. No Redis. No Kafka. No internal services. If you are looking
 * for a data store in this app, there isn't one — PulseStream is the backend.
 */

/** Mirrors the server-side EventIn contract (app/schemas/event.py). */
export interface EventIn {
  event_id: string;
  event_type: string;
  source: string;
  timestamp: string;
  user_id: string | null;
  request_id: string | null;
  payload: Record<string, unknown>;
  schema_version: number;
}

export interface ClientStats {
  /** POSTs that returned 2xx */
  sent: number;
  /** POSTs that failed (network error or non-2xx) */
  failed: number;
  lastEventType: string | null;
  lastError: string | null;
  /** Outcome of the most recent submission attempt */
  lastOutcome: "idle" | "ok" | "fail";
}

const INITIAL: ClientStats = {
  sent: 0,
  failed: 0,
  lastEventType: null,
  lastError: null,
  lastOutcome: "idle",
};

type Listener = (s: ClientStats) => void;

/**
 * Tiny observable client. One instance per app; stats reflect REAL request
 * outcomes only — nothing is counted as sent unless the API answered 2xx.
 */
export class PulseStreamClient {
  private stats: ClientStats = { ...INITIAL };
  private listeners = new Set<Listener>();

  constructor(private baseUrl: string = "/api/v1") {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getStats());
    return () => {
      this.listeners.delete(fn);
    };
  }

  getStats(): ClientStats {
    return { ...this.stats };
  }

  private emit(): void {
    const snap = this.getStats();
    this.listeners.forEach((fn) => fn(snap));
  }

  /** Submit one event. Resolves true iff the API accepted it (2xx). */
  async send(event: EventIn): Promise<boolean> {
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
          const body = (await r.json()) as { error?: { message?: string } };
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
export function defaultBaseUrl(): string {
  // Vite injects VITE_* vars at build time; empty/undefined falls back safely.
  return import.meta.env.VITE_PULSESTREAM_API || "/api/v1";
}
