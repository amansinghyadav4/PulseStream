import { describe, expect, it } from "vitest";
import {
  PRODUCTS,
  cartUpdated,
  checkoutStarted,
  orderCreated,
  pageViewed,
  paymentCompleted,
  productAddedToCart,
  productViewed,
  sessionUserId,
} from "./lib/journey";

/* The REAL server-side validation rules (app/schemas/event.py) mirrored here
   so payload-conformance failures fail fast in tests, not in production. */
const TYPE_RE = /^[a-z][a-z0-9_.]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function assertValidEventIn(e) {
  expect(UUID_RE.test(e.event_id)).toBe(true);
  expect(e.event_type.length).toBeGreaterThanOrEqual(1);
  expect(e.event_type.length).toBeLessThanOrEqual(255);
  expect(TYPE_RE.test(e.event_type)).toBe(true);
  expect(e.source.trim().length).toBeGreaterThan(0);
  expect(e.source).toBe("demo-store");
  expect(ISO_TZ_RE.test(e.timestamp)).toBe(true); // timezone-aware UTC
  if (e.user_id !== null) {
    expect(typeof e.user_id).toBe("string");
    expect(e.user_id.length).toBeGreaterThan(0);
  }
  expect(e.payload).toBeTypeOf("object");
  expect(e.schema_version).toBeGreaterThanOrEqual(1);
}

describe("customer-journey events conform to the PulseStream API contract", () => {
  it("opening the store -> page.viewed", () => {
    const e = pageViewed("/");
    expect(e.event_type).toBe("page.viewed");
    assertValidEventIn(e);
    expect(e.payload.path).toBe("/");
  });

  it("viewing a product -> product.viewed", () => {
    const e = productViewed(PRODUCTS[0]);
    expect(e.event_type).toBe("product.viewed");
    assertValidEventIn(e);
    expect(e.payload.product).toBe("laptop");
    expect(e.payload.price).toBe(999);
  });

  it("add to cart -> product.added_to_cart", () => {
    const e = productAddedToCart(PRODUCTS[1]);
    expect(e.event_type).toBe("product.added_to_cart"); // underscore allowed by schema regex
    assertValidEventIn(e);
  });

  it("cart state change -> cart.updated with aggregate payload", () => {
    const e = cartUpdated(3, 1297);
    expect(e.event_type).toBe("cart.updated");
    assertValidEventIn(e);
    expect(e.payload.items).toBe(3);
    expect(e.payload.cart_total).toBe(1297);
  });

  it("checkout -> checkout.started", () => {
    const e = checkoutStarted(2, 1198);
    expect(e.event_type).toBe("checkout.started");
    assertValidEventIn(e);
  });

  it("order completion -> order.created then payment.completed", () => {
    const o = orderCreated("ord-abc123", 2, 1198);
    expect(o.event_type).toBe("order.created");
    assertValidEventIn(o);
    expect(o.payload.order_id).toBe("ord-abc123");
    expect(o.payload.currency).toBe("USD");

    const p = paymentCompleted("ord-abc123", 1198);
    expect(p.event_type).toBe("payment.completed");
    assertValidEventIn(p);
    expect(p.payload.order_id).toBe("ord-abc123");
  });

  it("every event id in a full journey is a unique valid UUIDv4", () => {
    const journey = [
      pageViewed("/"),
      productViewed(PRODUCTS[2]),
      productAddedToCart(PRODUCTS[2]),
      cartUpdated(1, 99),
      checkoutStarted(1, 99),
      orderCreated("ord-x", 1, 99),
      paymentCompleted("ord-x", 99),
    ];
    const ids = journey.map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(UUID_RE.test(id)).toBe(true));
  });

  it("session user id is stable within a browser session", () => {
    // sessionStorage works in jsdom; two calls must agree.
    expect(sessionUserId()).toBe(sessionUserId());
    expect(sessionUserId()).toMatch(/^user-/);
  });
});
