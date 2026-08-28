import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api, ApiError, AUTH_EXPIRED_EVENT } from "./lib/apiClient";

/* ---------------------------------------------------------------- WebSocket */
// Capture every socket the app opens so we can assert the WS only connects for
// an authenticated session (and falls back to polling otherwise).
const wsInstances: Array<{ url: string }> = [];
class MockWS {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  constructor(public url: string) {
    wsInstances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
}
// @ts-ignore
global.WebSocket = MockWS as unknown as typeof WebSocket;

/* ------------------------------------------------------------------ fixtures */
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

const ME = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "demo@pulsestream.dev",
  full_name: "Demo User",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  organization: { id: "org-1", name: "Demo Workspace", slug: "demo-workspace" },
};

// The shared apiClient reads res.text() and parses JSON itself, so a mocked
// Response must expose text() — json() alone (used by the metrics/health hooks)
// is not enough.
function makeResponse(data: unknown, status = 200): Response {
  const text = data === undefined ? "" : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => data,
  } as unknown as Response;
}
const envelope = (code: string, message = code) => ({ error: { code, message } });

/* ------------------------------------------------------------- fetch harness */
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let meHandler: Handler;
let mutationHandler: Handler;
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function setCsrfCookie(value: string | null) {
  if (value === null) {
    document.cookie = "ps_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  } else {
    document.cookie = `ps_csrf=${value}; path=/`;
  }
}

beforeEach(() => {
  wsInstances.length = 0;
  fetchCalls.length = 0;
  window.localStorage.clear();
  setCsrfCookie(null);
  window.location.hash = "";
  meHandler = () => makeResponse(ME); // authenticated by default
  mutationHandler = () => makeResponse({}, 200);

  (globalThis as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    fetchCalls.push({ url, init });
    if (url.includes("/api/v1/auth/me")) return meHandler(url, init);
    if (/\/api\/v1\/auth\/(login|signup|logout|forgot-password|reset-password)/.test(url)) {
      return mutationHandler(url, init);
    }
    if (url.includes("/api/v1/events")) return makeResponse([]);
    if (url.includes("/api/v1/failures")) return makeResponse([]);
    if (url.includes("/api/v1/ready")) return makeResponse({ status: "ready", dependencies: {} });
    return makeResponse(METRICS);
  }) as unknown as typeof fetch;
});

afterEach(() => cleanup());

const wsCount = () => wsInstances.filter((w) => w.url.includes("/api/v1/ws")).length;

/* ================================================================== guards */
describe("route guards", () => {
  it("redirects an unauthenticated visitor off a protected route to Login", async () => {
    meHandler = () => makeResponse(envelope("not_authenticated"), 401);
    window.location.hash = "#/overview";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/login"));
  });

  it("redirects an authenticated user away from Login to the dashboard", async () => {
    window.location.hash = "#/login";
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/overview"));
  });

  it("does NOT open a WebSocket for an unauthenticated visitor (polling only)", async () => {
    meHandler = () => makeResponse(envelope("not_authenticated"), 401);
    window.location.hash = "#/login";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(wsCount()).toBe(0);
  });

  it("opens the authenticated WebSocket once the dashboard mounts", async () => {
    window.location.hash = "#/overview";
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    await waitFor(() => expect(wsCount()).toBeGreaterThan(0));
  });
});

/* ============================================================== login form */
describe("Login form states", () => {
  beforeEach(() => {
    meHandler = () => makeResponse(envelope("not_authenticated"), 401);
    window.location.hash = "#/login";
  });

  it("shows validation errors on empty submit without calling the network", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Sign in" });
    const before = fetchCalls.filter((c) => c.url.includes("/auth/login")).length;
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Email is required.")).toBeTruthy();
    expect(screen.getByText("Password is required.")).toBeTruthy();
    expect(fetchCalls.filter((c) => c.url.includes("/auth/login")).length).toBe(before);
  });

  it("surfaces an invalid-credentials error on 401", async () => {
    mutationHandler = () => makeResponse(envelope("invalid_credentials"), 401);
    render(<App />);
    await screen.findByRole("heading", { name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Invalid email or password.")).toBeTruthy();
  });

  it("signs in and lands on the dashboard on success", async () => {
    let authed = false;
    meHandler = () => (authed ? makeResponse(ME) : makeResponse(envelope("not_authenticated"), 401));
    mutationHandler = () => {
      authed = true;
      return makeResponse({}, 200);
    };
    render(<App />);
    await screen.findByRole("heading", { name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "demo@pulsestream.dev" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
  });

  it("offers a back-to-landing control", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.getByRole("button", { name: /back to pulsestream/i })).toBeTruthy();
    // the escape hatch must not disturb the form or its links
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Forgot password?" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create an account" })).toBeTruthy();
  });

  it("navigates explicitly to the landing route from the back control", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Sign in" });
    fireEvent.click(screen.getByRole("button", { name: /back to pulsestream/i }));
    await waitFor(() => expect(window.location.hash).toBe("#/landing"));
    expect(await screen.findByText(/Operational visibility/)).toBeTruthy();
  });
});

/* ============================================================ signup form */
describe("Signup form states", () => {
  beforeEach(() => {
    meHandler = () => makeResponse(envelope("not_authenticated"), 401);
    window.location.hash = "#/signup";
  });

  it("rejects a too-short password client-side", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Create your account" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Password must be at least 10 characters.")).toBeTruthy();
  });

  it("shows an email-exists error on 409", async () => {
    mutationHandler = () => makeResponse(envelope("email_exists"), 409);
    render(<App />);
    await screen.findByRole("heading", { name: "Create your account" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "taken@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("An account with this email already exists.")).toBeTruthy();
  });
});

/* ================================================================== logout */
describe("Logout", () => {
  it("revokes the session (with CSRF header) and returns to the public landing page", async () => {
    setCsrfCookie("csrf-token-xyz");
    let authed = true;
    meHandler = () => (authed ? makeResponse(ME) : makeResponse(envelope("not_authenticated"), 401));
    mutationHandler = () => {
      authed = false;
      return makeResponse({}, 200);
    };
    window.location.hash = "#/overview";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    window.location.hash = "#/logout";
    // the session is cleared and the visitor lands on the marketing page, not Login
    expect(await screen.findByText(/Operational visibility/)).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/landing"));

    const logoutCall = fetchCalls.find((c) => c.url.includes("/auth/logout"));
    expect(logoutCall).toBeTruthy();
    const headers = logoutCall!.init!.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-token-xyz");
  });

  it("keeps protected routes closed after signing out", async () => {
    let authed = true;
    meHandler = () => (authed ? makeResponse(ME) : makeResponse(envelope("not_authenticated"), 401));
    mutationHandler = () => {
      authed = false;
      return makeResponse({}, 200);
    };
    window.location.hash = "#/overview";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    window.location.hash = "#/logout";
    await waitFor(() => expect(window.location.hash).toBe("#/landing"));

    window.location.hash = "#/overview";
    await waitFor(() => expect(window.location.hash).toBe("#/login"));
  });
});

/* ============================================================ api client */
describe("shared API client", () => {
  it("attaches the CSRF token from the cookie on mutating requests", async () => {
    setCsrfCookie("abc123");
    await api.post("/api/v1/auth/logout", undefined, { silent401: true });
    const call = fetchCalls.find((c) => c.url.includes("/auth/logout"));
    const headers = call!.init!.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("abc123");
    expect(call!.init!.credentials).toBe("include");
  });

  it("does NOT attach a CSRF header on safe (GET) requests", async () => {
    setCsrfCookie("abc123");
    await api.get("/api/v1/events", { silent401: true });
    const call = fetchCalls.find((c) => c.url.includes("/api/v1/events"));
    const headers = call!.init!.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("dispatches ps:auth-expired on an unexpected 401", async () => {
    meHandler = () => makeResponse(envelope("not_authenticated"), 401);
    const spy = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, spy);
    await expect(api.get("/api/v1/auth/me")).rejects.toBeInstanceOf(ApiError);
    window.removeEventListener(AUTH_EXPIRED_EVENT, spy);
    expect(spy).toHaveBeenCalled();
  });

  it("does NOT dispatch ps:auth-expired when silent401 is set", async () => {
    meHandler = () => makeResponse(envelope("not_authenticated"), 401);
    const spy = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, spy);
    await expect(api.get("/api/v1/auth/me", { silent401: true })).rejects.toBeInstanceOf(ApiError);
    window.removeEventListener(AUTH_EXPIRED_EVENT, spy);
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ============================================= global 401 while authenticated */
describe("global session expiry", () => {
  it("drops an authenticated session to Login when ps:auth-expired fires", async () => {
    window.location.hash = "#/overview";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    // Simulate any protected call 401ing mid-session.
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/login"));
  });
});





