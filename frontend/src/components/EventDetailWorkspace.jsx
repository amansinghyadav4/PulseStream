import { useState } from "react";
import { formatClock, formatDate } from "../lib/format";
import { Drawer, DetailRow } from "../ui/Drawer";
import { CopyButton } from "../ui/CopyButton";


const TABS = [
  { id: "overview", label: "Overview" },
  { id: "payload", label: "Payload" },
  { id: "processing", label: "Processing" },
  { id: "context", label: "Context" },
];

/**
 * EVENT — the investigation workspace for a single stored event.
 *
 * Honesty rules encoded here:
 * - The only server-retained per-event timestamps are the producer timestamp
 *   and the PostgreSQL created_at. Pipeline stage timings are NOT retained,
 *   so the overview timeline marks those stages without inventing times.
 * - There is no per-event processing record; the PROCESSING tab says so and
 *   points at the aggregate metric instead of fabricating numbers.
 */
export function EventDetailWorkspace({ event, onClose }) {
  const [tab, setTab] = useState("overview");
  const Na = () => <span className="detail-value na">Not available</span>;

  return (
    <Drawer
      title={
        <>
          <span className="badge ok">
            <span className="dot" aria-hidden /> PROCESSED
          </span>
          {event.event_type}
          <CopyButton value={event.event_id} label="event id" />
        </>
      }
      subtitle={`${event.source} · ${formatDate(event.timestamp)} ${formatClock(event.timestamp)}`}
      onClose={onClose}
    >
      <div className="seg" role="tablist" aria-label="Investigation sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <p className="drawer-section">Identity</p>
          <DetailRow label="Event ID">
            <span className="mono">
              {event.event_id} <CopyButton value={event.event_id} label="event id" />
            </span>
          </DetailRow>
          <DetailRow label="Stored at">
            <span className="mono">
              {formatDate(event.created_at)} {formatClock(event.created_at)}
            </span>
          </DetailRow>
          <p className="drawer-section">Journey</p>
          <div className="timeline" aria-label="Event journey">
            <TimelineNode label={<>Received by ingestion API</>} />
            <TimelineNode label={<>Validated · committed to PostgreSQL</>} sub={`${formatDate(event.created_at)} ${formatClock(event.created_at)}`} />
            <TimelineNode label={<>Published to application-events (Kafka)</>} />
            <TimelineNode label={<>Processed by persistence &amp; analytics workers</>} />
          </div>
          <p className="timeline-note">Stage timestamps other than storage are not retained by the pipeline.</p>
        </>
      ) : null}

      {tab === "payload" ? (
        <>
          <p className="drawer-section">Payload</p>
          <pre className="payload-block">{JSON.stringify(event.payload, null, 2)}</pre>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            <CopyButton value={JSON.stringify(event.payload, null, 2)} label="payload JSON" />
            <CopyButton value={event.event_id} label="event id" />
            {event.request_id ? <CopyButton value={event.request_id} label="request id" /> : null}
          </div>
        </>
      ) : null}

      {tab === "processing" ? (
        <>
          <p className="drawer-section">Processing</p>
          <DetailRow label="Outcome">
            <span className="badge ok">
              <span className="dot" aria-hidden /> stored
            </span>
          </DetailRow>
          <DetailRow label="Per-event details">
            <Na />
          </DetailRow>
          <p className="metric-definition" style={{ marginTop: 10 }}>
            Individual processing durations are not retained per event. The platform reports the average
            analytics-worker processing latency (see Live Analytics → Processing Latency) and real-time consumer
            lag (see Pipeline).
          </p>
        </>
      ) : null}

      {tab === "context" ? (
        <>
          <p className="drawer-section">Context</p>
          <DetailRow label="Type">{event.event_type}</DetailRow>
          <DetailRow label="Source">{event.source}</DetailRow>
          <DetailRow label="User">{event.user_id ?? <Na />}</DetailRow>
          <DetailRow label="Request ID">
            {event.request_id ? (
              <span className="mono">
                {event.request_id} <CopyButton value={event.request_id} label="request id" />
              </span>
            ) : (
              <Na />
            )}
          </DetailRow>
          <DetailRow label="Timestamp">
            <span className="mono">
              {formatDate(event.timestamp)} {formatClock(event.timestamp)}
            </span>
          </DetailRow>
          <DetailRow label="Schema version">{event.schema_version}</DetailRow>
        </>
      ) : null}
    </Drawer>
  );
}

function TimelineNode({ label, sub }) {
  return (
    <div className="timeline-node">
      <div className="timeline-rail">
        <span className="timeline-dot done" style={{ background: "var(--accent)" }} />
        <span className="timeline-line" />
      </div>
      <span className="timeline-label">
        {label}
        {sub ? (
          <>
            {" "}
            · <span className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{sub}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
