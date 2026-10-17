import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageHeader, PAGE_GROUP } from "./PageHeader";
import { RecentFailures } from "./RecentFailures";
import { PipelineStrip } from "./PipelineStrip";

const READY = {
  status: "ready",
  dependencies: {
    postgres: { status: "healthy", latency_ms: 2 },
    kafka: { status: "healthy", detail: "producer started" },
    redis: { status: "healthy" },
    workers: {
      persistence_worker: { status: "healthy", lag: { "0": 0 } },
      analytics_worker: { status: "healthy", lag: { "0": 0 } },
    },
    broadcaster: { status: "running", websocket_clients: 2 },
  },
};

const METRICS = {
  total: 10,
  events_processed_total: 10,
  events_failed_total: 0,
  events_by_type: { "order.created": 10 },
  events_by_source: { "demo-store": 10 },
  events_per_minute: 120,
  events_per_second: 2,
  processing_latency_avg_ms: 12,
  active_producers: 1,
  consumer_lag: 0,
};

const FAILURES = [
  {
    id: 7,
    event_id: "11111111-1111-4111-8111-111111111111",
    event_type: "order.created",
    source: "demo-store",
    user_id: null,
    payload: { amount: 1 },
    error: "redis pipeline failed",
    attempts: 3,
    final_status: "dlq_retry_exhausted",
    failed_at: new Date(Date.now() - 60_000).toISOString(),
  },
];

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/v1/health")) return jsonResponse({ status: "ok" });
    if (url.includes("/api/v1/ready")) return jsonResponse(READY);
    if (url.includes("/api/v1/failures")) return jsonResponse([]);
    return jsonResponse({});
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("page header", () => {
  it("states the title, description and navigation group", () => {
    render(<PageHeader title="Overview" description="Verdict first." group={PAGE_GROUP.overview} />);
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(screen.getByText("Monitoring")).toBeTruthy();
    expect(screen.getByText("Verdict first.")).toBeTruthy();
  });

  it("maps every dashboard route to a group", () => {
    for (const route of [
      "overview",
      "analytics",
      "events",
      "failures",
      "sources",
      "pipeline",
      "health",
      "simulator",
      "api-keys",
      "integrations",
      "account",
    ]) {
      expect(PAGE_GROUP[route], route).toBeTruthy();
    }
  });
});

describe("pipeline strip", () => {
  it("renders the event path in flow order with reported readings", async () => {
    render(<PipelineStrip wsConnected metrics={METRICS} onOpen={() => {}} />);
    expect(await screen.findByText("Event path")).toBeTruthy();
    const stages = screen.getAllByRole("button", { name: /open pipeline/i });
    const names = stages.map((el) => el.querySelector(".ps-stage-name").textContent);
    expect(names).toEqual(["Sources", "API", "Kafka", "Workers", "Storage", "Dashboard"]);
    expect(screen.getByText("1 active")).toBeTruthy();
    expect(screen.getByText("2 ev/s")).toBeTruthy();
    expect(screen.getByText("PG 2 ms · Redis")).toBeTruthy();
  });

  it("says REST polling rather than claiming a live socket", async () => {
    render(<PipelineStrip wsConnected={false} metrics={METRICS} onOpen={() => {}} />);
    expect(await screen.findByText("REST polling")).toBeTruthy();
  });
});

describe("recent failures", () => {
  it("shows an honest empty state when nothing is dead-lettered", async () => {
    render(<RecentFailures />);
    expect(await screen.findByText("No terminal failures recorded")).toBeTruthy();
    expect(screen.getByText(/transient errors that succeeded on retry/i)).toBeTruthy();
  });

  it("lists real rows and opens the failure drawer", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/v1/failures")) return jsonResponse(FAILURES);
      return jsonResponse({});
    });
    render(<RecentFailures />);
    const row = await screen.findByRole("button", { name: /open failure order\.created/i });
    expect(screen.getByText("redis pipeline failed")).toBeTruthy();
    row.click();
    expect(await screen.findByText(/retries exhausted/i)).toBeTruthy();
  });
});
