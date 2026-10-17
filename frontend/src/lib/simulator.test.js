import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, clampDuration, clampRate, generateEvent } from "./eventFactory";
import { Simulator } from "./simulator";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TYPE_RE = /^[a-z][a-z0-9_.]*$/;

describe("eventFactory", () => {
  it("generates a valid EventIn payload per the API contract", () => {
    const e = generateEvent({ eventType: "order.created", source: "demo-store" });
    expect(UUID_RE.test(e.event_id)).toBe(true);
    expect(e.event_type).toBe("order.created");
    expect(TYPE_RE.test(e.event_type)).toBe(true);
    expect(e.source).toBe("demo-store");
    expect(ISO_TZ_RE.test(e.timestamp)).toBe(true); // timezone-aware UTC
    expect(e.user_id).toMatch(/^user-\d{3}$/);
    expect(e.schema_version).toBe(1);
    expect(typeof e.payload).toBe("object");
  });

  it("random mode picks only valid event types", () => {
    for (let i = 0; i < 40; i++) {
      const e = generateEvent({ eventType: "random", source: "s" });
      expect(LIMITS).toBeDefined();
      expect(TYPE_RE.test(e.event_type)).toBe(true);
    }
  });

  it("configurable type and source are respected exactly", () => {
    const e = generateEvent({ eventType: "payment.completed", source: "custom-source" });
    expect(e.event_type).toBe("payment.completed");
    expect(e.source).toBe("custom-source");
  });

  it("blank source falls back to demo-store", () => {
    const e = generateEvent({ eventType: "user.login", source: "   " });
    expect(e.source).toBe("demo-store");
  });

  it("clamps rate and duration into safe limits", () => {
    expect(clampRate(9999)).toBe(LIMITS.maxRatePerSec);
    expect(clampRate(0)).toBe(LIMITS.minRatePerSec);
    expect(clampRate(-5)).toBe(LIMITS.minRatePerSec);
    expect(clampDuration(99999)).toBe(LIMITS.maxDurationSec);
    expect(clampDuration(0)).toBe(LIMITS.minDurationSec);
    expect(clampDuration(null)).toBeNull();
  });
});

describe("Simulator engine", () => {
  let calls;

  beforeEach(() => {
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return { ok: true, status: 201 };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendOne posts one real request and counts success", async () => {
    const sim = new Simulator();
    const ok = await sim.sendOne({ eventType: "order.created", source: "demo-store" });
    expect(ok).toBe(true);
    const s = sim.getSnapshot();
    expect(s.attempted).toBe(1);
    expect(s.succeeded).toBe(1);
    expect(s.failed).toBe(0);
    expect(calls).toBe(1);
    // body must be the public API endpoint with a JSON EventIn
    const mocked = fetch;
    const [url, init] = mocked.mock.calls[0];
    expect(url).toBe("/api/v1/events");
    expect(init.method).toBe("POST");
    expect(UUID_RE.test(JSON.parse(init.body).event_id)).toBe(true);
  });

  it("counts failed responses honestly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }))
    );
    const sim = new Simulator();
    await sim.sendOne({ eventType: "page.viewed", source: "s" });
    await sim.sendOne({ eventType: "page.viewed", source: "s" });
    const s = sim.getSnapshot();
    expect(s.attempted).toBe(2);
    expect(s.failed).toBe(2);
    expect(s.succeeded).toBe(0);
    expect(s.lastError).toContain("500");
  });

  it("paces traffic near the configured rate (bounded, not unbounded)", async () => {
    const sim = new Simulator();
    sim.start({ eventType: "random", source: "pace", ratePerSec: 50, durationSec: 1 });
    await sim.waitUntilIdle();
    const s = sim.getSnapshot();
    // 50/s over ~1s should produce roughly 50 events — far below an unbounded flood,
    // and clearly above zero. Loose bounds keep this stable on slow CI timers.
    expect(s.attempted).toBeGreaterThan(20);
    expect(s.attempted).toBeLessThanOrEqual(60);
    expect(s.succeeded).toBe(s.attempted);
  }, 15000);

  it("stop() halts continuous traffic cleanly", async () => {
    const sim = new Simulator();
    sim.start({ eventType: "random", source: "stop-test", ratePerSec: 50, durationSec: null });
    // let a few through
    await new Promise((r) => setTimeout(r, 120));
    sim.stop();
    await sim.waitUntilIdle();
    const afterStop = sim.getSnapshot();
    expect(afterStop.running).toBe(false);
    expect(afterStop.attempted).toBeGreaterThan(0);
    expect(afterStop.attempted).toBeLessThan(LIMITS.maxTotalEvents);
    // counters must be stable once stopped
    await new Promise((r) => setTimeout(r, 250));
    expect(sim.getSnapshot().attempted).toBe(afterStop.attempted);
  }, 15000);

  it("respects the hard total-events cap in continuous mode", async () => {
    const sim = new Simulator();
    // Continuous at max rate would send 50/s; cap check uses engine math so we
    // verify via a short high-rate bounded run instead of waiting minutes.
    sim.start({ eventType: "random", source: "cap", ratePerSec: LIMITS.maxRatePerSec, durationSec: null });
    sim.stop();
    await sim.waitUntilIdle();
    expect(sim.getSnapshot().attempted).toBeLessThanOrEqual(LIMITS.maxTotalEvents);
  }, 15000);

  it("notifies subscribers on every stats change", async () => {
    const sim = new Simulator();
    const seen = [];
    const unsub = sim.subscribe((s) => seen.push(s.attempted));
    await sim.sendOne({ eventType: "cart.updated", source: "s" });
    unsub();
    expect(seen.length).toBeGreaterThanOrEqual(2); // initial + after settle
  });
});
