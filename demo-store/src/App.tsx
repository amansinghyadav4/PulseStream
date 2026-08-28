import { useEffect, useMemo, useRef, useState } from "react";
import { PulseStreamClient } from "./lib/pulsestream";
import type { ClientStats, EventIn } from "./lib/pulsestream";
import {
  PRODUCTS,
  cartUpdated,
  checkoutStarted,
  orderCreated,
  pageViewed,
  paymentCompleted,
  productAddedToCart,
  productViewed,
} from "./lib/journey";
import type { Product } from "./lib/journey";

/**
 * DEMO STORE — a simulated customer application.
 *
 * It is NOT part of PulseStream's core processing architecture. It behaves
 * exactly like an external e-commerce client: every customer action becomes a
 * real business event POSTed to the public PulseStream API, which then does
 * ALL ingestion, processing, storage and analytics.
 */

export function App() {
  const clientRef = useRef<PulseStreamClient | null>(null);
  if (clientRef.current === null) clientRef.current = new PulseStreamClient();
  const client = clientRef.current;

  const [stats, setStats] = useState<ClientStats>(() => client.getStats());
  const [cart, setCart] = useState<Record<string, number>>({}); // productId -> qty
  const [viewedProduct, setViewedProduct] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [checkedOut, setCheckedOut] = useState(false);

  useEffect(() => client.subscribe(setStats), [client]);

  // Customer opens the store -> page.viewed (once per mount, like a real page load)
  useEffect(() => {
    void client.send(pageViewed("/"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cartItems = useMemo(() => Object.values(cart).reduce((a, b) => a + b, 0), [cart]);
  const cartTotal = useMemo(
    () => PRODUCTS.reduce((sum, p) => sum + p.price * (cart[p.id] ?? 0), 0),
    [cart]
  );

  const fire = async (events: EventIn[]) => {
    for (const e of events) await client.send(e); // sequential: journey order is preserved
  };

  const viewProduct = async (p: Product) => {
    setViewedProduct(p.id);
    await fire([productViewed(p)]);
  };

  const addToCart = async (p: Product) => {
    setCart((c) => ({ ...c, [p.id]: (c[p.id] ?? 0) + 1 }));
    // business flow: item-level event then aggregate cart state
    await fire([
      productAddedToCart(p),
      cartUpdated((cart[p.id] ?? 0) + 1, cartTotal + p.price),
    ]);
  };

  const startCheckout = async () => {
    if (cartItems === 0) return;
    setCheckedOut(true);
    await fire([checkoutStarted(cartItems, cartTotal)]);
  };

  const completeOrder = async () => {
    if (!checkedOut || cartItems === 0) return;
    const oid = `ord-${crypto.randomUUID().slice(0, 8)}`;
    await fire([orderCreated(oid, cartItems, cartTotal), paymentCompleted(oid, cartTotal)]);
    setOrderId(oid);
    setCart({});
    setCheckedOut(false);
  };

  return (
    <div className="store">
      <header className="store-header">
        <div>
          <h1 className="store-title">Demo Store</h1>
          <p className="store-tagline">A sample e-commerce app whose events stream into PulseStream</p>
        </div>
        <span className="cart-chip">Cart: {cartItems} item{cartItems === 1 ? "" : "s"} · ${cartTotal.toFixed(2)}</span>
      </header>

      <PulseStatusBar stats={stats} />

      <h2 className="section-title">Products</h2>
      <div className="product-grid">
        {PRODUCTS.map((p) => (
          <div className="product-card" key={p.id}>
            <span className="product-name">{p.name}</span>
            <span className="product-price">${p.price}</span>
            <div className="product-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void viewProduct(p)}
                aria-label={`View ${p.name}`}
              >
                View
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void addToCart(p)}
                aria-label={`Add ${p.name} to cart`}
              >
                Add to Cart
              </button>
            </div>
            {viewedProduct === p.id ? <span style={{ fontSize: 12, color: "#16a34a" }}>viewing</span> : null}
          </div>
        ))}
      </div>

      <section className="panel" aria-label="Cart">
        <h2 className="section-title" style={{ marginTop: 0 }}>Cart</h2>
        {cartItems === 0 ? (
          <p className="empty">{orderId ? `Order ${orderId} completed — thank you!` : "Your cart is empty."}</p>
        ) : (
          <>
            {PRODUCTS.filter((p) => (cart[p.id] ?? 0) > 0).map((p) => (
              <div className="cart-line" key={p.id}>
                <span>
                  {p.name} × {cart[p.id]}
                </span>
                <span className="muted">${(p.price * (cart[p.id] ?? 0)).toFixed(2)}</span>
              </div>
            ))}
            <div className="cart-total">
              <span>Total</span>
              <span>${cartTotal.toFixed(2)}</span>
            </div>
            {!checkedOut ? (
              <div className="checkout-row">
                <button type="button" className="btn primary" onClick={() => void startCheckout()}>
                  Checkout
                </button>
              </div>
            ) : (
              <div className="checkout-row">
                <span>Checkout in progress…</span>
                <button type="button" className="btn primary" onClick={() => void completeOrder()}>
                  Complete order
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <footer className="store-footer">
        This storefront is a simulated customer application. Every action above sends a real
        event through PulseStream's public API — open the PulseStream dashboard to watch them
        being ingested, processed and analyzed in real time.
      </footer>
    </div>
  );
}

function PulseStatusBar({ stats }: { stats: ClientStats }) {
  // Honest states only: idle / last submit ok / last submit failed.
  return (
    <div className="ps-status" role="status" aria-live="polite">
      <span className="ps-brand">
        <span
          className={`ps-dot ${stats.lastOutcome === "ok" ? "ps-ok" : stats.lastOutcome === "fail" ? "ps-bad" : "ps-idle"}`}
          aria-hidden
        />
        PulseStream
      </span>
      <span className="ps-stat">
        {stats.lastOutcome === "idle"
          ? "no events sent yet"
          : stats.lastOutcome === "ok"
            ? "last submission accepted"
            : "last submission FAILED"}
      </span>
      <span className="ps-stat">
        Events sent: <b>{stats.sent}</b>
      </span>
      <span className="ps-stat">
        Failed: <b>{stats.failed}</b>
      </span>
      {stats.lastEventType ? (
        <span className="ps-stat">
          Last event: <b>{stats.lastEventType}</b>
        </span>
      ) : null}
      {stats.lastError && stats.lastOutcome === "fail" ? (
        <span className="ps-error">
          Error: {stats.lastError} — the event was NOT accepted; check that PulseStream is running.
        </span>
      ) : null}
    </div>
  );
}

export default App;
