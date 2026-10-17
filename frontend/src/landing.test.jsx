import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/* WebSocket stub (landing never authenticates, but App imports it globally) */
class MockWS {
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  close = vi.fn();
  send = vi.fn();
  constructor(url) { this.url = url; }
}
global.WebSocket = MockWS;

const METRICS = {
  total: 0, events_by_type: {}, events_by_source: {}, events_per_minute: 0,
  events_per_second: 0, processing_latency_avg_ms: null, active_producers: 0, consumer_lag: null,
};

function makeResponse(data, status = 200) {
  const text = data === undefined ? "" : JSON.stringify(data);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => data };
}
const envelope = (code, message = code) => ({ error: { code, message } });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete window.matchMedia;
  document.documentElement.removeAttribute("data-ps-theme");
  window.location.hash = "#/landing";
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    // unauthenticated visitor
    if (url.includes("/api/v1/auth/me")) return makeResponse(envelope("unauthorized", "Not authenticated"), 401);
    if (url.includes("/api/v1/ready")) return makeResponse({ status: "ready", dependencies: {} });
    return makeResponse(METRICS);
  });
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
    // The CTA now opens the sign-up dialog in place instead of leaving the page.
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Create your account")).toBeTruthy();
    expect(window.location.hash).toBe("#/landing");
  });

  it("routes the sign-in action to login", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    // the nav Sign in button is the first one
    fireEvent.click(screen.getAllByRole("button", { name: /^sign in$/i })[0]);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    // in-page dialog: the route (and therefore direct /login links) is untouched
    expect(window.location.hash).toBe("#/landing");
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

describe("Landing authentication dialog", () => {
  const openSignIn = async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    fireEvent.click(screen.getAllByRole("button", { name: /^sign in$/i })[0]);
    return screen.findByRole("dialog");
  };

  it("closes on Escape", async () => {
    await openSignIn();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on backdrop click but not on a click inside the panel", async () => {
    const dialog = await openSignIn();
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeTruthy();
    const backdrop = dialog.closest(".ls-modal-backdrop");
    fireEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes via the close button and restores focus to the opener", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    const opener = screen.getAllByRole("button", { name: /^sign in$/i })[0];
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /close dialog/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("switches between sign in and sign up without navigating away", async () => {
    const dialog = await openSignIn();
    fireEvent.click(within(dialog).getByRole("button", { name: /create an account/i }));
    expect(await screen.findByText("Create your account")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(window.location.hash).toBe("#/landing");
  });

  it("validates the sign-in form before calling the API", async () => {
    const dialog = await openSignIn();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^sign in$/i }));
    // invalid email + empty password are rejected client-side
    expect(await screen.findByText(/valid email address/i)).toBeTruthy();
    expect(screen.getByText(/password is required/i)).toBeTruthy();
    const loginCalls = globalThis.fetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/v1/auth/login"),
    );
    expect(loginCalls.length).toBe(0);
  });
});

describe("Landing theme", () => {
  it("starts from the system preference and toggles + remembers the choice", async () => {
    window.matchMedia = (query) => ({
      matches: query.includes("prefers-color-scheme: dark"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    render(<App />);
    await screen.findByText(/Operational visibility/);
    expect(document.documentElement.getAttribute("data-ps-theme")).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(document.documentElement.getAttribute("data-ps-theme")).toBe("light");
    // no consent recorded yet, so the choice is held for this visit only
    expect(window.sessionStorage.getItem("ps_theme")).toBe("light");
  });
});

describe("Cookie consent", () => {
  it("shows the banner, persists the decision and hides for good", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    expect(screen.getByText("Cookies on PulseStream")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /accept all/i }));
    await waitFor(() => expect(screen.queryByText("Cookies on PulseStream")).toBeNull());
    expect(JSON.parse(window.localStorage.getItem("ps_cookie_consent")).preferences).toBe(true);
  });

  it("makes declining as easy as accepting", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    fireEvent.click(screen.getByRole("button", { name: /necessary only/i }));
    await waitFor(() => expect(screen.queryByText("Cookies on PulseStream")).toBeNull());
    expect(JSON.parse(window.localStorage.getItem("ps_cookie_consent")).preferences).toBe(false);
  });

  it("explains the categories in the preferences panel", async () => {
    render(<App />);
    await screen.findByText(/Operational visibility/);
    fireEvent.click(screen.getByRole("button", { name: /manage preferences/i }));
    const panel = await screen.findByRole("group", { name: /manage cookie preferences/i });
    expect(panel).toBeTruthy();
    expect(screen.getByText(/Strictly necessary/)).toBeTruthy();
    expect(screen.getByText("Preferences")).toBeTruthy();
    // no invented analytics/tracking category
    expect(screen.queryByText(/analytics cookies/i)).toBeNull();
  });

  it("does not re-prompt once a decision is stored", async () => {
    window.localStorage.setItem(
      "ps_cookie_consent",
      JSON.stringify({ version: 1, preferences: true, decidedAt: "2026-01-01T00:00:00.000Z" }),
    );
    render(<App />);
    await screen.findByText(/Operational visibility/);
    expect(screen.queryByText("Cookies on PulseStream")).toBeNull();
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
