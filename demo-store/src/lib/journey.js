/** The demo store's fixed producer identity in PulseStream. */
export const DEMO_SOURCE = "demo-store";

export const PRODUCTS = [
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
export function sessionUserId() {
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

function makeEvent(eventType, payload) {
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

export function pageViewed(path) {
  return makeEvent("page.viewed", { path, referrer: "direct" });
}

export function productViewed(product) {
  return makeEvent("product.viewed", { product: product.id, name: product.name, price: product.price });
}

export function productAddedToCart(product) {
  return makeEvent("product.added_to_cart", { product: product.id, price: product.price });
}

export function cartUpdated(items, total) {
  return makeEvent("cart.updated", { items, cart_total: Number(total.toFixed(2)) });
}

export function checkoutStarted(items, total) {
  return makeEvent("checkout.started", { items, total: Number(total.toFixed(2)) });
}

export function orderCreated(orderId, items, total) {
  return makeEvent("order.created", {
    order_id: orderId,
    items,
    amount: Number(total.toFixed(2)),
    currency: "USD",
  });
}

export function paymentCompleted(orderId, total) {
  return makeEvent("payment.completed", {
    order_id: orderId,
    method: "demo-card",
    amount: Number(total.toFixed(2)),
    currency: "USD",
  });
}
