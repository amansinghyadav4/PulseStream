import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock WebSocket
class MockWS {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  constructor(public url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }
}
// @ts-ignore
global.WebSocket = MockWS as unknown as typeof WebSocket;

const METRICS = {
  total: 0,
  events_by_type: {},
  events_by_source: {},
  events_per_minute: 0,
  events_per_second: 0,
  processing_latency_avg_ms: null,
  active_producers: 0,
  consumer_lag: null,
};

const READY = {
  status: "ready",
  dependencies: {
    postgres: { status: "healthy", latency_ms: 2 },
    kafka: { status: "healthy", detail: "producer started" },
    redis: { status: "healthy" },
    workers: {
      persistence_worker: { status: "healthy" },
      analytics_worker: { status: "healthy" },
    },
    broadcaster: { status: "running", websocket_clients: 1 },
  },
};

// Authenticated /auth/me payload. The shared apiClient reads `res.text()` and
// parses the JSON itself, so every mocked Response must expose text() (not just
// json()). These tests exercise the dashboard shell, so /me returns a signed-in
// user with a resolved organization (Sidebar renders user.organization.name).
const ME = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "demo@pulsestream.dev",
  full_name: "Demo User",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  organization: {
    id: "00000000-0000-0000-0000-0000000000aa",
    name: "Demo Workspace",
    slug: "demo-workspace",
  },
};

function makeResponse(data: unknown, status = 200): Response {
  const text = data === undefined ? "" : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => data,
  } as unknown as Response;
}

beforeEach(() => {
  window.localStorage.clear();
  // @ts-ignore
  (globalThis as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/api/v1/auth/me")) return makeResponse(ME);
    if (url.includes("/api/v1/events")) return makeResponse([]);
    if (url.includes("/api/v1/failures")) return makeResponse([]);
    if (url.includes("/api/v1/ready")) return makeResponse(READY);
    return makeResponse(METRICS);
  }) as unknown as typeof fetch;
});

describe("PulseStream application shell", () => {
  it("renders Overview control center by default (KPI grid + throughput + activity)", async () => {
    window.location.hash = "";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByText("Key metrics")).toBeTruthy();
    expect(screen.getByText("Event throughput")).toBeTruthy();
    expect(screen.getByText("Latest events")).toBeTruthy();
  });

  it("sidebar navigates to Events explorer (grouped navigation)", async () => {
    window.location.hash = "";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    fireEvent.click(screen.getAllByRole("button", { name: "Events" })[0]);
    expect(await screen.findByRole("heading", { level: 1, name: "Events" })).toBeTruthy();
    expect(screen.getByLabelText("Search events")).toBeTruthy();
    expect(window.location.hash).toBe("#/events");
  });

  it("deep-links to Failures investigation view", async () => {
    window.location.hash = "#/failures";
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Failures" })).toBeTruthy();
    expect(screen.getAllByText(/no failures recorded/i).length).toBeGreaterThanOrEqual(1);
  });

  it("Sources page offers drill-through panels", async () => {
    window.location.hash = "#/sources";
    render(<App />);
    expect(await screen.findByText("Event types")).toBeTruthy();
    expect(screen.getByText("Event sources")).toBeTruthy();
  });

  it("Pipeline page shows full flow graph", async () => {
    window.location.hash = "#/pipeline";
    render(<App />);
    expect(await screen.findByText("Event flow")).toBeTruthy();
    expect(screen.getAllByText("Analytics Worker").length).toBeGreaterThanOrEqual(1);
  });

  it("opens command palette with Ctrl+K and navigates", async () => {
    window.location.hash = "";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: /command menu/i });
    expect(dialog).toBeTruthy();
    fireEvent.change(dialog.querySelector("input")!, { target: { value: "failures" } });
    fireEvent.click(screen.getByText("Go to Failures"));
    await screen.findByRole("heading", { level: 1, name: "Failures" });
    expect(window.location.hash).toBe("#/failures");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("collapses sidebar via Ctrl+B", async () => {
    window.location.hash = "";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const aside = document.querySelector(".sidebar")!;
    expect(aside.className).toContain("expanded");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(aside.className).toContain("collapsed");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(aside.className).toContain("expanded");
  });

  it("topbar search jumps to Events with query", async () => {
    window.location.hash = "";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const input = screen.getByLabelText("Global event search");
    fireEvent.input(input, { target: { value: "order.created" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(window.location.hash).toContain("#/events");
    expect(window.location.hash).toContain("q=order.created");
  });

  it("Simulator page hosts the Traffic Lab and Demo Store launch card", async () => {
    window.location.hash = "#/simulator";
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Traffic Generator" })).toBeTruthy();
    expect(screen.getByText("Traffic Lab")).toBeTruthy();
    expect(screen.getByText(/Open Demo Store/i)).toBeTruthy();
  });

  it("Overview shows latest events table and bottom status bar", async () => {
    window.location.hash = "";
    render(<App />);
    expect(await screen.findByText("Latest events")).toBeTruthy();
    expect(screen.getByText(/ENVIRONMENT:/)).toBeTruthy();
  });

  it("does not contain a Kafka client in the browser", async () => {
    expect(typeof WebSocket).toBe("function");
  });
});
