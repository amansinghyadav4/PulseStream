import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailuresView } from "./FailuresView";

const METRICS = {
  total: 400,
  events_processed_total: 398,
  events_failed_total: 2,
  events_by_type: {},
  events_by_source: {},
  events_per_minute: 0,
  events_per_second: 0,
  processing_latency_avg_ms: null,
  active_producers: 0,
  consumer_lag: null,
};

const ROWS = [
  {
    id: 2,
    event_id: "11111111-1111-4111-8111-111111111111",
    event_type: "order.created",
    source: "demo-store",
    user_id: "user-9",
    payload: { amount: 42 },
    error: "redis pipeline failed - connection refused",
    attempts: 3,
    final_status: "dlq_retry_exhausted",
    failed_at: "2026-08-26T10:00:00Z",
  },
  {
    id: 1,
    event_id: null,
    event_type: null,
    source: null,
    user_id: null,
    payload: null,
    error: "malformed json: unexpected token",
    attempts: 0,
    final_status: "dlq_malformed",
    failed_at: "2026-08-26T09:59:00Z",
  },
];

function stub(rows) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/v1/failures")) {
        if (rows instanceof Error) throw rows;
        return { ok: true, json: async () => rows };
      }
      return { ok: true, json: async () => METRICS };
    })
  );
}

beforeEach(() => {
  stub(ROWS);
});

describe("Failures view", () => {
  it("shows summary chips computed from real counters only", async () => {
    render(<FailuresView metrics={METRICS} />);
    expect(await screen.findByText("events require attention")).toBeTruthy();
    // rate 2/400 = 0.5%
    expect(screen.getByText("0.5%")).toBeTruthy();
    expect(screen.getByText("398")).toBeTruthy(); // processed
  });

  it("lists failures with accurate retry counts and final statuses", async () => {
    render(<FailuresView metrics={METRICS} />);
    await screen.findByText("order.created");
    expect(screen.getByText("retry exhausted")).toBeTruthy();
    expect(screen.getByText("malformed")).toBeTruthy();
    // severity dots present (color + presence, not color alone)
    expect(document.querySelectorAll(".sev-dot").length).toBe(ROWS.length);
    // error snippets visible in the dense rows
    expect(screen.getAllByText(/redis pipeline failed/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/malformed json/).length).toBeGreaterThanOrEqual(1);
  });

  it("opens a detail drawer with error + payload context and honest N/A fields", async () => {
    render(<FailuresView metrics={METRICS} />);
    fireEvent.click(await screen.findByText("order.created"));
    const drawer = await screen.findByRole("dialog");
    expect(drawer.textContent).toContain("redis pipeline failed");
    expect(drawer.textContent).toContain('"amount": 42');
    expect(drawer.textContent).toContain("Retry count");

    fireEvent.click(screen.getByLabelText("Close details"));
    // malformed row shows honest Not available in drawer
    fireEvent.click(screen.getAllByText(/Not available/)[0]);
    const drawer2 = await screen.findByRole("dialog");
    expect(drawer2.textContent).toMatch(/malformed/i);
    expect(drawer2.textContent).toContain("could not be parsed into an event");
  });

  it("empty state is honest when nothing failed", async () => {
    stub([]);
    render(<FailuresView metrics={{ ...METRICS, total: 100, events_failed_total: 0 }} />);
    expect(await screen.findByText(/No failures recorded/i)).toBeTruthy();
  });

  it("error state surfaces fetch problems with a retry action", async () => {
    stub(new Error("api down"));
    render(<FailuresView metrics={METRICS} />);
    await waitFor(() => expect(screen.getByText(/Couldn’t load failures — api down/i)).toBeTruthy());
  });
});
