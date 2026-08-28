import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/* WebSocket stub (landing never authenticates, but App imports it globally) */
class MockWS {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  constructor(public url: string) {}
}
// @ts-ignore
global.WebSocket = MockWS as unknown as typeof WebSocket;

const METRICS = {
  total: 0, events_by_type: {}, events_by_source: {}, events_per_minute: 0,
  events_per_second: 0, processing_latency_avg_ms: null, active_producers: 0, consumer_lag: null,
};

function makeResponse(data: unknown, status = 200): Response {
  const text = data === undefined ? "" : JSON.stringify(data);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => data } as unknown as Response;
}
const envelope = (code: string, message = code) => ({ error: { code, message } });

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "#/landing";
  (globalThis as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    // unauthenticated visitor
    if (url.includes("/api/v1/auth/me")) return makeResponse(envelope("unauthorized", "Not authenticated"), 401);
    if (url.includes("/api/v1/ready")) return makeResponse({ status: "ready", dependencies: {} });
    return makeResponse(METRICS);
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

describe("Landing page", () => {
  it("renders the public marketing content", async () => {
    render(<App />);
    expect(await screen.findByText(/Operational visibility/)).toBeTruthy();
    expect(screen.getAllByText(/in real time\./).length).toBeGreaterThan(0);
    // capabilities are described honestly, no fabricated logos/uptime/testimonials
    expect(screen.getByText("Multi-tenant isolation")).toBeTruthy();
    expect(screen.getByText("How PulseStream works")).toBeTruthy();
    expect(screen.getByText("Secure API keys")).toBeTruthy();
    // honest metric placeholder when no live data
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows the real pipeline topology, with the two consumer lanes kept apart", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    // both workers consume the same topic independently; the lanes never rejoin
    expect(screen.getAllByText("Persistence Worker").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Analytics Worker").length).toBeGreaterThan(0);
    expect(screen.getAllByText("PostgreSQL").length).toBeGreaterThan(0);
    expect(screen.getAllByText("WebSocket").length).toBeGreaterThan(0);
  });

  it("routes the primary CTA to sign up", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    fireEvent.click(screen.getAllByRole("button", { name: /get started free/i })[0]);
    await waitFor(() => expect(window.location.hash).toBe("#/signup"));
  });

  it("routes the sign-in action to login", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    // the nav Sign in button is the first one
    fireEvent.click(screen.getAllByRole("button", { name: /^sign in$/i })[0]);
    await waitFor(() => expect(window.location.hash).toBe("#/login"));
  });

  it("keeps in-page section navigation off the hash router", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    fireEvent.click(screen.getAllByRole("button", { name: "Features" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Docs" })[0]);
    // scrolling to a section must never be parsed as a route change
    expect(window.location.hash).toBe("#/landing");
  });
});

describe("Protected routes", () => {
  it("redirects an unauthenticated visitor off the API Keys page to login", async () => {
    window.location.hash = "#/api-keys";
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe("#/login"));
  });

  it("redirects an unauthenticated visitor off the Integrations page to login", async () => {
    window.location.hash = "#/integrations";
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe("#/login"));
  });
});
