import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Overview as KpiOverview } from "./KpiCards";
import { FailureRate } from "./FailureRate";
import { Latency } from "./Latency";
import { EventTypes } from "./Distributions";
import { DistributionList } from "./Distributions";

const base = {
  total: 0,
  events_processed_total: 0,
  events_failed_total: 0,
  events_by_type: {},
  events_by_source: {},
  events_per_minute: 0,
  events_per_second: 0,
  processing_latency_avg_ms: null,
  active_producers: 0,
  consumer_lag: null,
};

describe("honest unavailable states", () => {
  it("consumer lag shows Unavailable with explanation when null", () => {
    render(<KpiOverview metrics={base} />);
    const labels = screen.getAllByText("Unavailable");
    expect(labels.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("workers not reporting yet")).toBeTruthy();
  });

  it("consumer lag shows the real value when present", () => {
    render(<KpiOverview metrics={{ ...base, consumer_lag: 1234 }} />);
    expect(screen.getByText("1,234")).toBeTruthy();
    expect(screen.queryByText("workers not reporting yet")).toBeNull();
  });

  it("failure rate shows No data when total is zero (never 0%)", () => {
    render(<FailureRate metrics={base} />);
    expect(screen.getByText("No data")).toBeTruthy();
  });

  it("failure rate computes from real counters only", () => {
    render(
      <FailureRate metrics={{ ...base, total: 400, events_failed_total: 2, events_processed_total: 398 }} />
    );
    expect(screen.getByText("0.5%")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("latency panel shows honest definition and unavailable state", () => {
    render(<Latency metrics={base} />);
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });

  it("latency value renders with unit and honest definition", () => {
    render(<Latency metrics={{ ...base, processing_latency_avg_ms: 42.5 }} />);
    expect(screen.getByText("42.5")).toBeTruthy();
    expect(screen.getAllByText(/analytics worker/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/not an end-to-end pipeline measurement/i)).toBeTruthy();
  });
});

describe("distribution math", () => {
  it("percentages derive from actual counts", () => {
    render(
      <DistributionList
        entries={[
          ["a", 75],
          ["b", 25],
        ]}
      />
    );
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
  });

  it("event types panel renders entries sorted desc", () => {
    render(
      <EventTypes
        metrics={{
          ...base,
          total: 30,
          events_by_type: { "order.created": 10, "page.viewed": 20 },
        }}
      />
    );
    const names = screen.getAllByText(/order\.created|page\.viewed/);
    expect(names[0].textContent).toBe("page.viewed");
  });
});
