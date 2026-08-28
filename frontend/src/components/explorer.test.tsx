import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventExplorer } from "./EventExplorer";
import type { RecentEvent } from "../types/metrics";

function evt(overrides: Partial<RecentEvent>): RecentEvent {
  return {
    id: Math.floor(Math.random() * 100000),
    event_id: overrides.event_id ?? crypto.randomUUID(),
    event_type: "order.created",
    source: "demo-store",
    timestamp: "2026-08-26T10:00:00Z",
    user_id: "user-001",
    payload: { amount: 199 },
    schema_version: 1,
    created_at: "2026-08-26T10:00:01Z",
    request_id: "req-1234",
    ...overrides,
  };
}

const ROWS: RecentEvent[] = [
  evt({ event_type: "order.created", source: "demo-store", user_id: "user-001", payload: { amount: 1 } }),
  evt({ event_type: "page.viewed", source: "web-app", user_id: "user-002", payload: { path: "/" } }),
  evt({ event_type: "payment.completed", source: "demo-store", user_id: null, payload: {} }),
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ROWS }) as unknown as Response)
  );
});

function table() {
  return within(screen.getByRole("table"));
}

describe("Event Explorer", () => {
  it("renders loaded rows and opens a detail workspace on row click", async () => {
    render(<EventExplorer />);
    const t = table();
    await t.findByText("page.viewed");
    fireEvent.click(t.getByText("page.viewed"));
    const drawer = await screen.findByRole("dialog");
    expect(drawer.textContent).toContain(ROWS[1].event_id);
    // default tab = overview journey
    expect(within(drawer).getByText(/Journey/)).toBeTruthy();
    // request id lives in the CONTEXT tab
    fireEvent.click(within(drawer).getByRole("tab", { name: "Context" }));
    expect(within(drawer).getAllByText(/Request ID/i).length).toBeGreaterThanOrEqual(1);
    // payload tab shows pretty JSON + copy affordances
    fireEvent.click(within(drawer).getByRole("tab", { name: "Payload" }));
    expect(within(drawer).getByText(/"path"/)).toBeTruthy();
  });

  it("search filters by substring with an honest no-match state", async () => {
    render(<EventExplorer />);
    const t = table();
    await t.findByText("page.viewed");
    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "pay" } });
    await waitFor(() => expect(t.queryByText("page.viewed")).toBeNull());
    expect(t.getByText("payment.completed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "zzz-not-there" } });
    expect(await screen.findByText("No matches")).toBeTruthy();
  });

  it("type filter narrows rows", async () => {
    render(<EventExplorer />);
    const t = table();
    await t.findByText("page.viewed");
    fireEvent.change(screen.getByLabelText("Filter by event type"), { target: { value: "order.created" } });
    await waitFor(() => expect(t.queryByText("page.viewed")).toBeNull());
    expect(t.getByText("order.created")).toBeTruthy();
  });

  it("shows loading skeletons then error state with retry when API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      })
    );
    render(<EventExplorer />);
    await screen.findByText(/Connection lost — retrying automatically. Last error: down/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });
});
