import { clampDuration, clampRate, generateEvent, LIMITS } from "./eventFactory";
import type { SimulatorEventConfig } from "./eventFactory";

export interface SimulatorStats {
  running: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Events acknowledged over the trailing 2s window (actual observed rate). */
  currentRate: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
}

const RATE_WINDOW_MS = 2000;
const EMIT_INTERVAL_MS = 200;

/**
 * Traffic engine for the Event Simulator.
 *
 * - Paces sends on a fixed schedule (rate events/sec) with a BOUNDED worker
 *   pool, so the browser never fires unbounded parallel requests and never
 *   blocks the UI.
 * - Counts only real HTTP outcomes (2xx = success).
 * - stop() halts scheduling cleanly; in-flight requests still settle and are
 *   counted.
 * - Continuous mode is bounded by LIMITS.maxTotalEvents as a safety net.
 */
export class Simulator {
  private stats: SimulatorStats = {
    running: false,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    currentRate: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  };

  private listeners = new Set<(s: SimulatorStats) => void>();
  private ackTimes: number[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private runTasks: Promise<void>[] = [];

  subscribe(fn: (s: SimulatorStats) => void): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  getSnapshot(): SimulatorStats {
    return { ...this.stats };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    this.listeners.forEach((fn) => fn(snap));
  }

  private record(success: boolean, error: string | null): void {
    this.stats.attempted += 1;
    if (success) {
      this.stats.succeeded += 1;
      this.ackTimes.push(Date.now());
    } else {
      this.stats.failed += 1;
      if (error) this.stats.lastError = error;
    }
  }

  private pruneAckTimes(now: number): void {
    while (this.ackTimes.length > 0 && now - this.ackTimes[0] > RATE_WINDOW_MS) {
      this.ackTimes.shift();
    }
  }

  /** Send exactly one event; resolves true on 2xx. Safe to call while idle.
   *  When `apiKey` is a non-empty string it is sent as the `X-API-Key` header so
   *  the backend attributes the event to that key's organization; otherwise no
   *  key is sent and the backend resolves the reserved Demo org (the existing
   *  shared-key / Demo-environment behavior, unchanged). */
  async sendOne(config: SimulatorEventConfig, apiKey?: string | null): Promise<boolean> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey && apiKey.trim() !== "") headers["X-API-Key"] = apiKey.trim();
    try {
      // Body generation lives INSIDE the try: if it ever throws (e.g. a missing
      // WebCrypto primitive in an exotic context) the attempt is still counted
      // and the reason surfaced, rather than silently rejecting the promise and
      // leaving the counters frozen at zero.
      const body = generateEvent(config);
      const r = await fetch("/api/v1/events", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const ok = r.ok;
      this.record(ok, ok ? null : `HTTP ${r.status}`);
      this.emit();
      return ok;
    } catch (e) {
      this.record(false, e instanceof Error ? e.message : "network error");
      this.emit();
      return false;
    }
  }

  isRunning(): boolean {
    return this.stats.running;
  }

  /**
   * Start paced traffic. durationSec=null means continuous until stop() —
   * still hard-capped at LIMITS.maxTotalEvents sent in total per run.
   */
  start(rawConfig: SimulatorEventConfig & { ratePerSec: number; durationSec: number | null; apiKey?: string | null }): void {
    if (this.stats.running) return;

    const apiKey = rawConfig.apiKey ?? null;
    const ratePerSec = clampRate(rawConfig.ratePerSec);
    const durationSec = clampDuration(rawConfig.durationSec);
    const intervalMs = 1000 / ratePerSec;
    // Total scheduled events for this run (safety-capped).
    const totalEvents =
      durationSec === null
        ? LIMITS.maxTotalEvents
        : Math.min(Math.ceil(durationSec * ratePerSec), LIMITS.maxTotalEvents);

    this.stats = {
      running: true,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      currentRate: 0,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
    };
    this.ackTimes = [];
    this.emit();

    let stopRequested = false;
    this.stopFn = () => {
      stopRequested = true;
    };

    // Bounded concurrency: enough workers to keep up with the pace, never more.
    const concurrency = Math.min(Math.max(2, Math.ceil(ratePerSec)), 24);
    const t0 = Date.now();

    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, Math.max(0, ms)));

    const worker = async (workerIndex: number): Promise<void> => {
      let index = workerIndex;
      while (!stopRequested && index < totalEvents) {
        const due = t0 + index * intervalMs;
        await sleep(due - Date.now());
        if (stopRequested) return;
        await this.sendOne(rawConfig, apiKey);
        index += concurrency;
      }
    };

    this.runTasks = Array.from({ length: concurrency }, (_, i) => worker(i));

    // Rolling actual-rate + UI updates while running.
    this.ticker = setInterval(() => {
      const now = Date.now();
      this.pruneAckTimes(now);
      this.stats.currentRate = Math.round((this.ackTimes.length / (RATE_WINDOW_MS / 1000)) * 10) / 10;
      this.emit();
    }, EMIT_INTERVAL_MS);

    void Promise.all(this.runTasks).then(() => {
      if (this.ticker !== null) {
        clearInterval(this.ticker);
        this.ticker = null;
      }
      const now = Date.now();
      this.pruneAckTimes(now);
      this.stats.running = false;
      this.stats.finishedAt = now;
      this.stats.currentRate =
        Math.round((this.ackTimes.length / (RATE_WINDOW_MS / 1000)) * 10) / 10;
      this.stopFn = null;
      this.runTasks = [];
      this.emit();
    });
  }

  private stopFn: (() => void) | null = null;

  /** Request a clean stop; already-in-flight requests settle and are counted. */
  stop(): void {
    this.stopFn?.();
  }

  /** Resolves when the current run fully settles (used by tests). */
  async waitUntilIdle(): Promise<void> {
    while (this.stats.running) {
      await new Promise((res) => setTimeout(res, 20));
    }
    await Promise.allSettled(this.runTasks);
  }
}
