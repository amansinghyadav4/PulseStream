import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSimulator } from "./EventSimulator";
import type { ApiKey } from "../types/apiKey";

// A minimal Response-like object. The shared apiClient reads `res.text()` and
// parses JSON itself, so the api-keys GET needs text(); the simulator's own
// fetch only reads `.ok`/`.status`. One shape covers both.
function makeResponse(data: unknown, status = 200): Response {
  const text = data === undefined ? "" : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => data,
  } as unknown as Response;
}

// URL-aware fetch: the component loads /api/v1/api-keys on mount (for the key
// selector) and posts events to /api/v1/events. Both must be answered.
function mockFetch(opts: { keys?: ApiKey[]; ingestOk?: boolean } = {}) {
  const keys = opts.keys ?? [];
  const ingestOk = opts.ingestOk ?? true;
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/api/v1/api-keys")) return makeResponse(keys);
    if (url.includes("/api/v1/events")) {
      return ingestOk ? makeResponse({ accepted: 1 }, 201) : makeResponse({ error: { code: "boom", message: "fail" } }, 500);
    }
    return makeResponse({});
  });
}

function apiKey(overrides: Partial<ApiKey> & Pick<ApiKey, "id" | "name" | "key_prefix">): ApiKey {
  return {
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EventSimulator UI", () => {
  it("renders controls with safe-limit hints and defaults", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<EventSimulator />);
    // flush the on-mount api-keys load so state settles inside act()
    const keySelect = (await screen.findByLabelText("API key")) as HTMLSelectElement;
    expect(keySelect.value).toBe("demo"); // Demo shared key is the default
    expect(screen.getByText("Traffic Lab")).toBeTruthy();
    expect(screen.getByLabelText(/event type/i)).toBeTruthy();
    expect((screen.getByLabelText(/event type/i) as HTMLSelectElement).value).toBe("random");
    expect(screen.getByLabelText(/source/i)).toHaveProperty("value", "demo-store");
    expect(screen.getByLabelText(/traffic rate/i)).toBeTruthy();
    expect(screen.getByLabelText(/duration/i)).toBeTruthy();
    // limits must be visible, not hidden
    expect(screen.getByText(/max 50\/s/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /send 1 event/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /start traffic/i })).toBeTruthy();
    expect((screen.getByRole("button", { name: /^stop$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Send 1 event posts to the API and updates counters", async () => {
    const f = mockFetch({ ingestOk: true });
    vi.stubGlobal("fetch", f);
    render(<EventSimulator />);
    await screen.findByLabelText("API key");

    fireEvent.change(screen.getByLabelText(/event type/i), { target: { value: "order.created" } });
    fireEvent.change(screen.getByLabelText(/source/i), { target: { value: "demo-store" } });
    fireEvent.click(screen.getByRole("button", { name: /send 1 event/i }));

    await waitFor(() => expect(screen.getByText("Events attempted").nextElementSibling?.textContent).toBe("1"));
    const eventsCall = f.mock.calls.find((c) => String(c[0]).includes("/api/v1/events"));
    expect(eventsCall).toBeTruthy();
    const [url, init] = eventsCall!;
    expect(url).toBe("/api/v1/events");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.event_type).toBe("order.created");
    expect(body.source).toBe("demo-store");

    await waitFor(() =>
      expect(screen.getByText("Successful").nextElementSibling?.textContent).toBe("1")
    );
  });

  it("failed requests increment the Failed counter honestly", async () => {
    vi.stubGlobal("fetch", mockFetch({ ingestOk: false }));
    render(<EventSimulator />);
    await screen.findByLabelText("API key");
    fireEvent.click(screen.getByRole("button", { name: /send 1 event/i }));
    await waitFor(() => expect(screen.getByText("Failed").nextElementSibling?.textContent).toBe("1"));
    await waitFor(() => expect(screen.getByText(/Last failure/)).toBeTruthy());
  });

  it("still sends when crypto.randomUUID is unavailable (insecure http context)", async () => {
    // Repro of the field bug: on a plain-HTTP non-localhost origin
    // crypto.randomUUID is undefined, so event generation threw before the
    // request and the counters stayed at 0 with no error. safeUUID() must fall
    // back to getRandomValues so the request is still built and sent.
    const realCrypto = globalThis.crypto;
    const patched = {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      // randomUUID intentionally omitted, mirroring an insecure context
    } as unknown as Crypto;
    vi.stubGlobal("crypto", patched);
    const f = mockFetch({ ingestOk: true });
    vi.stubGlobal("fetch", f);
    render(<EventSimulator />);
    await screen.findByLabelText("API key");

    fireEvent.click(screen.getByRole("button", { name: /send 1 event/i }));

    await waitFor(() => expect(screen.getByText("Events attempted").nextElementSibling?.textContent).toBe("1"));
    await waitFor(() => expect(screen.getByText("Successful").nextElementSibling?.textContent).toBe("1"));
    const eventsCall = f.mock.calls.find((c) => String(c[0]).includes("/api/v1/events"));
    expect(eventsCall).toBeTruthy();
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    // a well-formed v4 UUID was still produced by the fallback path
    expect(body.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("loads the user's non-revoked API keys into the selector", async () => {
    const keys = [
      apiKey({ id: "k1", name: "Prod ingest", key_prefix: "psk_abc123" }),
      apiKey({ id: "k2", name: "Retired key", key_prefix: "psk_dead99", revoked_at: "2026-02-01T00:00:00Z" }),
    ];
    vi.stubGlobal("fetch", mockFetch({ keys }));
    render(<EventSimulator />);

    // the active key becomes a selectable option; the revoked one is filtered out
    expect(await screen.findByRole("option", { name: /Prod ingest/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Retired key/ })).toBeNull();
  });

  it("selecting a user's key sends it as the X-API-Key header", async () => {
    // The raw secret always begins with the key's stored public prefix (the
    // create endpoint derives key_prefix = raw[:12]); the UI validates that.
    const RAW = "psk_abc123DEF456ghi789";
    const keys = [apiKey({ id: "k1", name: "Prod ingest", key_prefix: "psk_abc123DE" })];
    const f = mockFetch({ keys });
    vi.stubGlobal("fetch", f);
    render(<EventSimulator />);

    await screen.findByRole("option", { name: /Prod ingest/ });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k1" } });
    // Send is gated until the pasted secret matches the selected key's prefix
    expect((screen.getByRole("button", { name: /send 1 event/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/full api key value/i), { target: { value: RAW } });
    expect((screen.getByRole("button", { name: /send 1 event/i }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /send 1 event/i }));

    await waitFor(() => expect(screen.getByText("Events attempted").nextElementSibling?.textContent).toBe("1"));
    const eventsCall = f.mock.calls.find((c) => String(c[0]).includes("/api/v1/events"));
    expect(eventsCall).toBeTruthy();
    const headers = (eventsCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe(RAW);
  });

  it("rejects a pasted secret whose prefix does not match the selected key", async () => {
    const keys = [apiKey({ id: "k1", name: "Prod ingest", key_prefix: "psk_abc123DE" })];
    vi.stubGlobal("fetch", mockFetch({ keys }));
    render(<EventSimulator />);

    await screen.findByRole("option", { name: /Prod ingest/ });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k1" } });
    fireEvent.change(screen.getByLabelText(/full api key value/i), { target: { value: "psk_WRONGwrong" } });

    // mismatch is surfaced and traffic stays gated
    expect(screen.getByText(/doesn't match the selected key's prefix/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /send 1 event/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /start traffic/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Demo default sends no X-API-Key header (shared-key fallback preserved)", async () => {
    const f = mockFetch({ keys: [apiKey({ id: "k1", name: "Prod ingest", key_prefix: "psk_abc123DE" })] });
    vi.stubGlobal("fetch", f);
    render(<EventSimulator />);
    await screen.findByLabelText("API key"); // stays on the Demo option

    fireEvent.click(screen.getByRole("button", { name: /send 1 event/i }));
    await waitFor(() => expect(screen.getByText("Events attempted").nextElementSibling?.textContent).toBe("1"));

    const eventsCall = f.mock.calls.find((c) => String(c[0]).includes("/api/v1/events"));
    const headers = (eventsCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("start then stop runs bounded traffic and returns to Stopped state", async () => {
    vi.stubGlobal("fetch", mockFetch({ ingestOk: true }));
    render(<EventSimulator />);
    await screen.findByLabelText("API key");
    fireEvent.change(screen.getByLabelText(/traffic rate/i), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: "1" } });

    fireEvent.click(screen.getByRole("button", { name: /start traffic/i }));
    expect((screen.getByRole("button", { name: /start traffic/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^stop$/i }) as HTMLButtonElement).disabled).toBe(false);

    // wait for the run window to elapse and the engine to settle
    await waitFor(
      () => expect(screen.getByText(/Stopped/)).toBeTruthy(),
      { timeout: 8000 }
    );
    const attempted = Number(
      screen.getByText("Events attempted").nextElementSibling?.textContent ?? "0"
    );
    expect(attempted).toBeGreaterThan(20);
    expect(attempted).toBeLessThanOrEqual(60);
    expect(Number(screen.getByText("Successful").nextElementSibling?.textContent)).toBe(attempted);
  }, 15000);
});
