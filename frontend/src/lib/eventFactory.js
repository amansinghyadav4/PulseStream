/**
 * Realistic demo-event generation against the EXISTING PulseStream EventIn
 * schema (app/schemas/event.py). Pure functions — no I/O here.
 *
 * The simulator only ever talks to POST /api/v1/events; it never touches
 * PostgreSQL, Redis, or Kafka directly and adds no backend surface.
 */

/** Event types offered in the simulator dropdown ("random" picks from these). */
export const EVENT_TYPES = [
  "page.viewed",
  "product.viewed",
  "cart.updated",
  "order.created",
  "order.completed",
  "payment.completed",
  "user.login",
];

/** Hard safety limits enforced by BOTH the UI and the engine. */
export const LIMITS = {
  minRatePerSec: 1,
  maxRatePerSec: 50,
  minDurationSec: 1,
  maxDurationSec: 300,
  /** Absolute cap per run — also bounds continuous mode until Stop is pressed. */
  maxTotalEvents: 5000,
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * A v4 UUID that works in EVERY browsing context.
 *
 * `crypto.randomUUID()` is only defined in a *secure context* (HTTPS or
 * `http://localhost`). When the dashboard is opened over plain HTTP on a
 * non-localhost origin (e.g. a Docker host's LAN IP), `randomUUID` is
 * `undefined` and calling it throws — which previously aborted event generation
 * before the request was ever sent. `crypto.getRandomValues` IS available in
 * insecure contexts, so we derive the UUID from it; a Math.random path is the
 * last resort for exotic environments with no WebCrypto at all.
 */
export function safeUUID() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const PRODUCT_NAMES = ["pulse-sneakers", "stream-headphones", "echo-keyboard", "relay-mouse", "flux-monitor"];
const AMOUNTS = [19.9, 49.0, 79.5, 120.0, 249.99];

/** A believable payload shape per event_type (realistic demo data, not metrics). */
function buildPayload(eventType, userId) {
  switch (eventType) {
    case "page.viewed":
      return { path: pick(["/", "/products", "/pricing", "/docs", "/blog"]), referrer: "demo-store" };
    case "product.viewed":
      return { product: pick(PRODUCT_NAMES), price: pick(AMOUNTS) };
    case "cart.updated":
      return { items: 1 + Math.floor(Math.random() * 4), action: pick(["add", "remove", "update"]) };
    case "order.created":
      return { order_id: `ord-${userId}`, amount: pick(AMOUNTS), currency: "USD" };
    case "order.completed":
      return { amount: pick(AMOUNTS), currency: "USD", items: 1 + Math.floor(Math.random() * 3) };
    case "payment.completed":
      return { method: pick(["card", "paypal", "wallet"]), amount: pick(AMOUNTS) };
    case "user.login":
      return { device: pick(["desktop", "mobile", "tablet"]) };
    default:
      return { detail: "simulated" };
  }
}

/**
 * Build one valid EventIn body. Never throws on ordinary input; the caller is
 * responsible for clamping configuration to LIMITS.
 */
export function generateEvent(config) {
  const eventType =
    config.eventType === "random" ? pick(EVENT_TYPES) : config.eventType;
  const source = (config.source || "demo-store").trim() || "demo-store";
  const seq = Math.floor(Math.random() * 10_000);
  const userId = `user-${String(seq % 1000).padStart(3, "0")}`;

  return {
    event_id: safeUUID(),
    event_type: eventType,
    source,
    timestamp: new Date().toISOString(), // RFC 3339 with Z — satisfies the tz validator
    user_id: userId,
    request_id: safeUUID(),
    payload: buildPayload(eventType, userId),
    schema_version: 1,
  };
}

export function clampRate(rate) {
  if (!Number.isFinite(rate)) return LIMITS.minRatePerSec;
  return Math.min(LIMITS.maxRatePerSec, Math.max(LIMITS.minRatePerSec, Math.round(rate)));
}

export function clampDuration(seconds) {
  if (seconds === null) return null; // continuous mode (still capped by maxTotalEvents)
  if (!Number.isFinite(seconds)) return LIMITS.minDurationSec;
  return Math.min(LIMITS.maxDurationSec, Math.max(LIMITS.minDurationSec, Math.round(seconds)));
}
