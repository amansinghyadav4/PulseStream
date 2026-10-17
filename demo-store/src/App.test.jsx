import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/**
 * Captures every POST the store makes and returns 201, like the real API.
 * Returns both the mock and a list of parsed bodies for assertions.
 */
function stubApi() {
  const bodies = [];
  const f = vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init?.body));
    return { ok: true, status: 201, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", f);
  return { f, bodies };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe("Demo Store (client application)", () => {
  it("opening the store sends page.viewed through the public API only", async () => {
    const { f, bodies } = stubApi();
    render(<App />);
    await waitFor(() => expect(bodies.length).toBe(1));
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/v1/events");
    expect((init).method).toBe("POST");
    expect(bodies[0].event_type).toBe("page.viewed");
    // status strip reflects reality
    expect(screen.getByText(/last submission accepted/i)).toBeTruthy();
    expect(screen.getByText("Events sent:").textContent).toContain("1");
  });

  it("view -> add-to-cart emits product.viewed, product.added_to_cart, cart.updated in order", async () => {
    const { bodies } = stubApi();
    render(<App />);
    await waitFor(() => screen.getByLabelText("View Keyboard"));

    fireEvent.click(screen.getByLabelText("View Keyboard"));
    await waitFor(() => expect(bodies.some((b) => b.event_type === "product.viewed")).toBe(true));

    fireEvent.click(screen.getByLabelText("Add Keyboard to cart"));
    await waitFor(() => expect(bodies.some((b) => b.event_type === "product.added_to_cart")).toBe(true));
    await waitFor(() => expect(bodies.some((b) => b.event_type === "cart.updated")).toBe(true));

    const types = bodies.map((b) => b.event_type);
    expect(types.indexOf("product.added_to_cart")).toBeGreaterThan(types.indexOf("product.viewed"));
    expect(types.indexOf("cart.updated")).toBeGreaterThan(types.indexOf("product.added_to_cart"));
    const cartEvt = bodies.find((b) => b.event_type === "cart.updated");
    expect(cartEvt?.payload.items).toBe(1);
    expect(screen.getByText(/Cart: 1 item · \$99\.00/)).toBeTruthy();
  });

  it("full checkout journey emits checkout.started -> order.created -> payment.completed", async () => {
    const { bodies } = stubApi();
    render(<App />);
    await waitFor(() => screen.getByLabelText("Add Headphones to cart"));

    fireEvent.click(screen.getByLabelText("Add Headphones to cart"));
    await waitFor(() => screen.getByText(/Checkout/));
    fireEvent.click(screen.getByRole("button", { name: "Checkout" }));
    await waitFor(() => expect(bodies.some((b) => b.event_type === "checkout.started")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /Complete order/i }));
    await waitFor(() => expect(bodies.some((b) => b.event_type === "payment.completed")).toBe(true));

    const order = bodies.find((b) => b.event_type === "order.created");
    const payment = bodies.find((b) => b.event_type === "payment.completed");
    expect(order?.payload.order_id).toBe(payment?.payload.order_id);
    expect(order?.payload.amount).toBe(199);
    // cart resets after purchase
    expect(screen.getByText(/Order ord-.* completed/)).toBeTruthy();
  });

  it("failed submissions are counted honestly and never shown as sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: { message: "api unavailable" } }),
      }))
    );
    render(<App />);
    await waitFor(() => expect(screen.getByText(/last submission FAILED/i)).toBeTruthy());
    expect(screen.getByText("Events sent:").textContent).toContain("0");
    expect(screen.getByText("Failed:").textContent).toContain("1");
    expect(screen.getByText(/the event was NOT accepted/i)).toBeTruthy();
  });

  it("authentication rejection (401) is surfaced honestly as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: "invalid_api_key", message: "invalid API key" } }),
      }))
    );
    render(<App />);
    await waitFor(() => expect(screen.getByText(/last submission FAILED/i)).toBeTruthy());
    expect(screen.getByText("Events sent:").textContent).toContain("0");
    expect(screen.getByText(/invalid API key/i)).toBeTruthy();
  });

  it("network errors are counted as failures too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    render(<App />);
    await waitFor(() => expect(screen.getByText(/connection refused/i)).toBeTruthy());
    expect(screen.getByText("Failed:").textContent).toContain("1");
  });

  it("transport is exclusively fetch to /api/v1/events — no other backends touched", async () => {
    const { f } = stubApi();
    render(<App />);
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThanOrEqual(1));
    f.mock.calls.forEach(([url, init]) => {
      expect(String(url)).toBe("/api/v1/events"); // never any other endpoint
      expect((init).method).toBe("POST");
    });
  });
});
