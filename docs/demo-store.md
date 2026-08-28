# Demo Store — a simulated PulseStream customer

> **The demo store is not part of PulseStream's core processing architecture.**
> It is a simulated customer application used to demonstrate how an external
> client integrates with PulseStream.

## What it is

A tiny e-commerce storefront (products, cart, fake checkout) whose every
customer action becomes a real business event submitted to PulseStream's public
API. Open it in one tab and the PulseStream dashboard in another: actions in the
store appear on the dashboard within ~1–2 seconds.

## Why it exists

PulseStream answers the question *"how do I process high volumes of application
events?"* — but that only makes sense when you can point at WHO produces those
events. The demo store is that producer: a hypothetical customer ("demo-store")
whose checkout funnel generates exactly the kind of events PulseStream exists
to ingest, process, store and analyze.

## How it integrates (the ONLY path)

```text
Demo Store (browser)
      │  customer action
      ▼
POST /api/v1/events          ← the public PulseStream API; nothing else
      ▼
PulseStream API  (validate → PostgreSQL commit → Kafka publish → 201)
      ▼
Kafka  (application-events, 6 partitions)
      ▼
Analytics/Persistence Workers  (consumer groups)
      ▼
Redis counters / PostgreSQL event store
      ▼
WebSocket broadcaster
      ▼
PulseStream Dashboard (live metrics, recent events)
```

The store has NO database, NO Redis, NO Kafka client, and imports ZERO backend
code. Its entire integration surface is one HTTP endpoint. This is deliberate:
it demonstrates the contract an external customer would program against.

## Authentication

PulseStream ingestion requires `X-API-Key` when keys are configured
(`PULSESTREAM_API_KEYS`). The demo store authenticates **without any secret in
the browser**: its nginx container injects the configured development key as
`X-API-Key` while proxying `/api/`.

- LOCAL DEMO: key = documented fake `ps_demo_key_local` (compose default),
  injected server-side by nginx — safe, non-production credential.
- PRODUCTION: set `PULSESTREAM_API_KEYS` to real secrets; they live only in
  server configuration, never in frontend source or browser storage.

If authentication fails (401), the store's status strip flips to
"last submission FAILED" with the API's error message and increments *Failed* —
rejected events are never shown as sent.

## Events generated (per customer action)

| Customer action | Event(s) emitted |
|---|---|
| Opens the store | `page.viewed` |
| Clicks "View" on a product | `product.viewed` |
| Clicks "Add to Cart" | `product.added_to_cart`, then `cart.updated` |
| Clicks "Checkout" | `checkout.started` |
| Clicks "Complete order" | `order.created`, then `payment.completed` |

Every payload follows the real `EventIn` schema: UUIDv4 `event_id`,
`source="demo-store"`, RFC-3339 UTC timestamp, stable per-session `user_id`,
`schema_version: 1`, and realistic payload fields (`product`, `cart_total`,
`order_id`, `amount`, `currency`, …). The storefront status strip shows REAL
request outcomes only — failed submissions increment *Failed* and are never
counted as sent.

## How to start it

```powershell
docker compose up -d          # demo-store included; serves http://localhost:3001
```

Local development of the store itself:

```powershell
cd demo-store
npm install
npm run dev                   # http://localhost:3001 (proxies /api to :8001)
npm test                      # vitest suite
```

## Demo script (two tabs)

1. Tab A: PulseStream dashboard — http://localhost:3000
2. Tab B: Demo Store — http://localhost:3001 (a `page.viewed` fires on load)
3. In the store: View "Laptop" → Add to Cart → Checkout → Complete order
4. Watch Tab A: Recent Events lists each event newest-first; Overview total
   climbs; Event Types/Sources distributions shift (`demo-store` appears);
   throughput chart ticks via WebSocket.
5. The store's own strip confirms every submission was accepted (sent/failed).

## Limitations

- Fake checkout: no payments, no inventory, no accounts — by design.
- Single session user per browser tab (sessionStorage), not multi-user realism.
- It demonstrates happy-path volume, not load (use `load-tests/` or the
  dashboard's Event Simulator for throughput experiments).
