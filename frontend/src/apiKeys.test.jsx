import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/* ------------------------------------------------------------- WebSocket */
class MockWS {
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  close = vi.fn();
  send = vi.fn();
  constructor(url) {
    this.url = url;
    setTimeout(() => this.onopen?.(), 0);
  }
}
global.WebSocket = MockWS;

/* -------------------------------------------------------------- clipboard */
const writeText = vi.fn(async () => {});
Object.assign(navigator, { clipboard: { writeText } });

/* --------------------------------------------------------------- fixtures */
const ME = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "demo@pulsestream.dev",
  full_name: "Demo User",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  organization: { id: "org-1", name: "Demo Workspace", slug: "demo-workspace" },
};
const METRICS = {
  total: 0, events_by_type: {}, events_by_source: {}, events_per_minute: 0,
  events_per_second: 0, processing_latency_avg_ms: null, active_producers: 0, consumer_lag: null,
};

function makeResponse(data, status = 200) {
  const text = data === undefined ? "" : JSON.stringify(data);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => data };
}
const envelope = (code, message = code) => ({ error: { code, message } });

/* ----------------------------------------------------------- key store */
let keyStore = [];
let createFails = false;

function installFetch() {
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/v1/auth/me")) return makeResponse(ME);
    if (url.includes("/api/v1/api-keys")) {
      const revokeMatch = url.match(/\/api-keys\/([^/]+)\/revoke$/);
      if (revokeMatch && method === "POST") {
        const id = revokeMatch[1];
        const k = keyStore.find((x) => x.id === id);
        if (!k) return makeResponse(envelope("api_key_not_found", "API key not found"), 404);
        if (!k.revoked_at) k.revoked_at = "2026-08-28T10:00:00Z";
        return makeResponse(k);
      }
      if (method === "POST") {
        if (createFails) return makeResponse(envelope("server_error", "Could not create the key."), 500);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const created = {
          id: `id-${keyStore.length + 1}`,
          name: body.name,
          key_prefix: "ps_live_abcd",
          created_at: "2026-08-28T09:00:00Z",
          last_used_at: null,
          revoked_at: null,
        };
        keyStore = [created, ...keyStore];
        return makeResponse({ ...created, api_key: "ps_live_abcd_SECRETRAWVALUE123456" }, 201);
      }
      // GET list
      return makeResponse(keyStore);
    }
    if (url.includes("/api/v1/events")) return makeResponse([]);
    if (url.includes("/api/v1/failures")) return makeResponse([]);
    if (url.includes("/api/v1/ready")) return makeResponse({ status: "ready", dependencies: {} });
    return makeResponse(METRICS);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  keyStore = [];
  createFails = false;
  writeText.mockClear();
  window.location.hash = "#/api-keys";
  installFetch();
});
afterEach(() => cleanup());

describe("API Keys page", () => {
  it("shows the empty state when the organization has no keys", async () => {
    render(<App />);
    expect(await screen.findByText("No API keys yet")).toBeTruthy();
    expect(
      screen.getByText(/Create your first key above to start sending events/)
    ).toBeTruthy();
  });

  it("lists existing keys with prefix and active status", async () => {
    keyStore = [
      {
        id: "id-1", name: "production-web", key_prefix: "ps_live_wxyz",
        created_at: "2026-08-01T00:00:00Z", last_used_at: null, revoked_at: null,
      },
    ];
    render(<App />);
    expect(await screen.findByText("production-web")).toBeTruthy();
    expect(screen.getByText("ps_live_wxyz…")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    // never used yet
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("creates a key, reveals the raw secret exactly once with a warning, and copies it", async () => {
    render(<App />);
    // wait for initial (empty) load so the create form is interactive
    await screen.findByText("No API keys yet");

    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "ingest-worker" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    // reveal banner: warning + raw secret shown once
    expect(await screen.findByText("not be shown again")).toBeTruthy();
    const secret = "ps_live_abcd_SECRETRAWVALUE123456";
    expect(screen.getByText(secret)).toBeTruthy();

    // copy the raw secret
    fireEvent.click(screen.getByRole("button", { name: /Copy key/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(secret));

    // the new key now appears in the list (reloaded from the server)
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getByText("ingest-worker")).toBeTruthy()
    );

    // dismissing the banner hides the raw secret for good
    fireEvent.click(screen.getByRole("button", { name: /I've saved it/ }));
    await waitFor(() => expect(screen.queryByText(secret)).toBeNull());
  });

  it("surfaces a server error when creation fails and does not reveal a secret", async () => {
    createFails = true;
    render(<App />);
    await screen.findByText("No API keys yet");

    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "broken" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    expect(await screen.findByText("Could not create the key.")).toBeTruthy();
    expect(screen.queryByText("not be shown again")).toBeNull();
  });

  it("requires confirmation to revoke, then marks the key revoked", async () => {
    keyStore = [
      {
        id: "id-1", name: "production-web", key_prefix: "ps_live_wxyz",
        created_at: "2026-08-01T00:00:00Z", last_used_at: null, revoked_at: null,
      },
    ];
    render(<App />);

    const revokeBtn = await screen.findByRole("button", { name: "Revoke production-web" });
    fireEvent.click(revokeBtn);

    // confirmation dialog appears (destructive action is gated)
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Revoke this API key?")).toBeTruthy();
    expect(within(dialog).getByText(/401 invalid_api_key/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    // key flips to a Revoked badge; the Revoke action is gone
    expect(await screen.findByText("Revoked")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Revoke production-web" })).toBeNull()
    );
  });

  it("cancels a revoke without changing the key", async () => {
    keyStore = [
      {
        id: "id-1", name: "production-web", key_prefix: "ps_live_wxyz",
        created_at: "2026-08-01T00:00:00Z", last_used_at: null, revoked_at: null,
      },
    ];
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke production-web" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("Active")).toBeTruthy();
  });
});

describe("Integration page", () => {
  beforeEach(() => {
    window.location.hash = "#/integrations";
  });

  it("documents the real ingest endpoint, auth header and schema", async () => {
    render(<App />);
    // endpoint + method
    expect(await screen.findByText("POST", { selector: ".method-pill" })).toBeTruthy();
    expect(screen.getAllByText(/\/api\/v1\/events/).length).toBeGreaterThan(0);
    // auth header
    expect(screen.getByText("X-API-Key: YOUR_API_KEY")).toBeTruthy();
    // schema fields from the real contract
    expect(screen.getByText("event_type")).toBeTruthy();
    expect(screen.getByText("source")).toBeTruthy();
    expect(screen.getByText("schema_version")).toBeTruthy();
    // language examples
    expect(screen.getByText("curl", { selector: ".code-lang" })).toBeTruthy();
    expect(screen.getByText("JavaScript (fetch)", { selector: ".code-lang" })).toBeTruthy();
    expect(screen.getByText("Python (requests)", { selector: ".code-lang" })).toBeTruthy();
  });

  it("copies the auth header via its copy button", async () => {
    render(<App />);
    await screen.findByText("X-API-Key: YOUR_API_KEY");
    const buttons = screen.getAllByRole("button", { name: /Copy/ });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
  });
});
