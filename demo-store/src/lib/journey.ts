import type { EventIn } from "./pulsestream";

/** The demo store's fixed producer identity in PulseStream. */
export const DEMO_SOURCE = "demo-store";

export interface Product {
  id: string;
  name: string;
  price: number;
}

export const PRODUCTS: Product[] = [
  { id: "laptop", name: "Laptop", price: 999 },
  { id: "headphones", name: "Headphones", price: 199 },
  { id: "keyboard", name: "Keyboard", price: 99 },
  { id: "mouse", name: "Mouse", price: 49 },
  { id: "monitor", name: "Monitor", price: 299 },
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stable per-browser-session demo user. Deliberately NOT a login — just a
 * consistent actor id so PulseStream partitioning/ordering is observable.
 */
export function sessionUserId(): string {
  try {
    let uid = sessionStorage.getItem("demo-store-user");
    if (!uid) {
      uid = `user-${crypto.randomUUID().slice(0, 8)}`;
      sessionStorage.setItem("demo-store-user", uid);
    }
    return uid;
  } catch {
    return "user-anonymous"; // storage disabled (e.g. some test environments)
  }
}

function makeEvent(eventType: string, payload: Record<string, unknown>): EventIn {
  const requestId = crypto.randomUUID();
  if (!UUID_RE.test(requestId)) throw new Error("uuid generation broken");
  return {
    event_id: crypto.randomUUID(),
    event_type: eventType, // all types here match server-side ^[a-z][a-z0-9_.]*$
    source: DEMO_SOURCE,
    timestamp: new Date().toISOString(), // RFC3339 with Z (tz-aware validator)
    user_id: sessionUserId(),
    request_id: requestId,
    payload,
    schema_version: 1,
  };
}

/* ------------------------------------------------------------------ */
/* One builder per customer action — the store's event vocabulary.     */
/* ------------------------------------------------------------------ */

export function pageViewed(path: string): EventIn {
  return makeEvent("page.viewed", { path, referrer: "direct" });
}

export function productViewed(product: Product): EventIn {
  return makeEvent("product.viewed", { product: product.id, name: product.name, price: product.price });
}

export function productAddedToCart(product: Product): EventIn {
  return makeEvent("product.added_to_cart", { product: product.id, price: product.price });
}

export function cartUpdated(items: number, total: number): EventIn {
  return makeEvent("cart.updated", { items, cart_total: Number(total.toFixed(2)) });
}

export function checkoutStarted(items: number, total: number): EventIn {
  return makeEvent("checkout.started", { items, total: Number(total.toFixed(2)) });
}

export function orderCreated(orderId: string, items: number, total: number): EventIn {
  return makeEvent("order.created", {
    order_id: orderId,
    items,
    amount: Number(total.toFixed(2)),
    currency: "USD",
  });
}

export function paymentCompleted(orderId: string, total: number): EventIn {
  return makeEvent("payment.completed", {
    order_id: orderId,
    method: "demo-card",
    amount: Number(total.toFixed(2)),
    currency: "USD",
  });
}
