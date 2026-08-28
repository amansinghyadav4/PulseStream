import type { ReactNode } from "react";
import { Card } from "../ui/Card";
import { CopyButton } from "./CopyButton";
import { IconDatabase, IconServer, IconShield, IconStream } from "./icons";

/** Base URL for the documented examples — the real origin this dashboard is
 *  served from, so copy/paste snippets hit the correct host in every env. */
const ORIGIN = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "https://your-pulsestream-host";
const EVENTS_URL = `${ORIGIN}/api/v1/events`;

const EVENT_JSON = `{
  "event_type": "order.created",
  "source": "checkout-service",
  "timestamp": "2026-08-28T12:00:00Z",
  "user_id": "user_8f2a",
  "request_id": "req_4b91c7",
  "payload": {
    "order_id": "ord_1024",
    "amount_cents": 4999,
    "currency": "USD"
  },
  "schema_version": 1
}`;

const CURL_EXAMPLE = `curl -X POST ${EVENTS_URL} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "event_type": "order.created",
    "source": "checkout-service",
    "payload": { "order_id": "ord_1024", "amount_cents": 4999 }
  }'`;

const JS_EXAMPLE = `await fetch("${EVENTS_URL}", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": process.env.PULSESTREAM_API_KEY,
  },
  body: JSON.stringify({
    event_type: "order.created",
    source: "checkout-service",
    payload: { order_id: "ord_1024", amount_cents: 4999 },
  }),
});`;

const PYTHON_EXAMPLE = `import os, requests

requests.post(
    "${EVENTS_URL}",
    headers={"X-API-Key": os.environ["PULSESTREAM_API_KEY"]},
    json={
        "event_type": "order.created",
        "source": "checkout-service",
        "payload": {"order_id": "ord_1024", "amount_cents": 4999},
    },
    timeout=10,
)`;

/** Code block with a language label and a one-click copy button. */
function CodeBlock({ language, code, label }: { language: string; code: string; label?: string }) {
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{language}</span>
        <CopyButton value={code} className="btn" label={label ?? "Copy"} compact />
      </div>
      <pre className="code-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  desc: ReactNode;
}

const SCHEMA: SchemaField[] = [
  {
    name: "event_type",
    type: "string",
    required: true,
    desc: (
      <>
        Dotted, lowercase name of the event, e.g. <span className="mono">order.created</span>. Must match{" "}
        <span className="mono">^[a-z][a-z0-9_.]*$</span> (1–255 chars).
      </>
    ),
  },
  { name: "source", type: "string", required: true, desc: "The application or service emitting the event (1–255 chars)." },
  {
    name: "payload",
    type: "object",
    required: false,
    desc: "Your event's business data. Any JSON object; defaults to {} when omitted.",
  },
  {
    name: "timestamp",
    type: "string (ISO-8601)",
    required: false,
    desc: (
      <>
        When the event occurred. Must include a UTC offset (e.g. <span className="mono">Z</span>). Defaults to the
        server receive time if omitted.
      </>
    ),
  },
  {
    name: "event_id",
    type: "string (UUID)",
    required: false,
    desc: (
      <>
        Supply your own to make ingestion idempotent — a repeat returns <span className="mono">409</span>.
        Auto-generated when omitted.
      </>
    ),
  },
  { name: "user_id", type: "string", required: false, desc: "Optional actor identifier (max 255 chars)." },
  { name: "request_id", type: "string", required: false, desc: "Optional correlation id for tracing (max 255 chars)." },
  { name: "schema_version", type: "integer", required: false, desc: "Producer schema version. Defaults to 1 (≥ 1)." },
];

const FLOW = [
  { label: "Your App", note: "emits events", Icon: IconServer },
  { label: "PulseStream API", note: "POST /api/v1/events", Icon: IconShield },
  { label: "Kafka", note: "durable buffer", Icon: IconStream },
  { label: "Workers", note: "persistence · analytics", Icon: IconStream },
  { label: "PostgreSQL · Redis", note: "store · cache", Icon: IconDatabase },
  { label: "Dashboard", note: "real-time", Icon: IconServer },
];

/**
 * Integration / Developer guide. Documents the REAL ingestion contract
 * (endpoint, auth header, event schema, examples) so a customer can connect an
 * application end-to-end. Nothing here is invented — every field and endpoint
 * matches the running API (app/api/routes_events.py, app/schemas/event.py).
 */
export function IntegrationPage() {
  return (
    <>
      <Card title="How it works" hint="every event travels the same instrumented path">
        <p className="ak-lead">
          Send events to PulseStream over plain HTTPS. Each request is authenticated by your organization's API key,
          which automatically attributes the event to <strong>your workspace</strong> — you never send an organization
          id, and you can only ever see your own data.
        </p>
        <div className="flow-scroll">
          <div className="flow-strip">
            {FLOW.map((s, i) => (
              <div className="flow-node-wrap" key={s.label}>
                <div className="flow-node">
                  <span className="flow-node-icon">
                    <s.Icon size={16} />
                  </span>
                  <span className="flow-node-name">{s.label}</span>
                  <span className="flow-node-note">{s.note}</span>
                </div>
                {i < FLOW.length - 1 ? (
                  <span className="flow-arrow" aria-hidden>
                    →
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid-2col">
        <Card title="Endpoint" hint="single ingest endpoint">
          <div className="kv-block">
            <div className="kv-row">
              <span className="kv-k">Method &amp; URL</span>
              <span className="kv-v">
                <span className="method-pill">POST</span>
                <span className="mono">{EVENTS_URL}</span>
                <CopyButton value={EVENTS_URL} className="btn" label="Copy" compact />
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-k">Batch</span>
              <span className="kv-v mono">POST /api/v1/events/batch — up to 1000 events, all-or-nothing</span>
            </div>
            <div className="kv-row">
              <span className="kv-k">Read back</span>
              <span className="kv-v mono">GET /api/v1/events · GET /api/v1/events/{"{event_id}"}</span>
            </div>
          </div>
        </Card>

        <Card title="Authentication" hint="per-organization API key">
          <div className="kv-block">
            <div className="kv-row">
              <span className="kv-k">Header</span>
              <span className="kv-v">
                <span className="mono">X-API-Key: YOUR_API_KEY</span>
                <CopyButton value="X-API-Key: YOUR_API_KEY" className="btn" label="Copy" compact />
              </span>
            </div>
          </div>
          <p className="metric-definition" style={{ marginTop: 4 }}>
            Create and manage keys on the <strong>API Keys</strong> page. A revoked key is rejected with{" "}
            <span className="mono">401 invalid_api_key</span>. Missing key →{" "}
            <span className="mono">401 missing_api_key</span>.
          </p>
        </Card>
      </div>

      <Card title="Event JSON" hint="the shape of a single event">
        <CodeBlock language="json" code={EVENT_JSON} />
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="ak-table schema-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Required</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {SCHEMA.map((f) => (
                <tr key={f.name}>
                  <td className="mono ak-name-cell">{f.name}</td>
                  <td className="ak-time">{f.type}</td>
                  <td>
                    {f.required ? (
                      <span className="badge error" style={{ fontSize: 10 }}>
                        required
                      </span>
                    ) : (
                      <span className="badge neutral" style={{ fontSize: 10 }}>
                        optional
                      </span>
                    )}
                  </td>
                  <td className="schema-desc">{f.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="metric-definition" style={{ marginTop: 10 }}>
          A successful ingest returns <span className="mono">201</span> with the stored event. A duplicate{" "}
          <span className="mono">event_id</span> returns <span className="mono">409 duplicate_event</span>. Validation
          failures return <span className="mono">422</span> with the structured error envelope.
        </p>
      </Card>

      <Card title="Send your first event" hint="curl · JavaScript · Python">
        <div className="code-stack">
          <CodeBlock language="curl" code={CURL_EXAMPLE} />
          <CodeBlock language="JavaScript (fetch)" code={JS_EXAMPLE} />
          <CodeBlock language="Python (requests)" code={PYTHON_EXAMPLE} />
        </div>
        <p className="metric-definition" style={{ marginTop: 10 }}>
          Replace <span className="mono">YOUR_API_KEY</span> with a key from the API Keys page. Once sent, the event
          flows through Kafka and the workers into PostgreSQL/Redis, and appears on your dashboard within seconds —
          scoped to your workspace only.
        </p>
      </Card>
    </>
  );
}
