import { useCountUp, useReveal } from "./motion";
import { ratePct, scrollToSection, SECTION } from "./shared";
import { formatCount } from "../../lib/format";
import { IconArrowRight, IconCheck, IconPulse } from "../icons";

/** Sidebar of the product mock — mirrors the real dashboard navigation. */
const PREVIEW_NAV = [
  { group: "Overview", items: [{ label: "Overview", active: true }, { label: "Analytics" }] },
  { group: "Explore", items: [{ label: "Events" }, { label: "Failures" }, { label: "Sources" }] },
  { group: "Infrastructure", items: [{ label: "Pipeline" }, { label: "Health" }] },
  { group: "Developer", items: [{ label: "API Keys" }, { label: "Integrations" }] },
  { group: "Tools", items: [{ label: "Simulator" }] },
];

/* Decorative feed rows — generic event names, aria-hidden, purely to show the
   stream moving. The KPI values beside them are the real public snapshot. */
const FEED_ROWS = [
  { type: "order.created", src: "checkout" },
  { type: "user.signup", src: "web-app" },
  { type: "payment.captured", src: "billing" },
  { type: "cart.updated", src: "storefront" },
];

/* Decorative throughput trace: shape only, deliberately unlabelled — no axis
   values, so the mock never implies a measurement that was not taken. */
const SPARK = "0,27 10,23 20,25 30,18 40,21 50,15 60,18 70,11 80,14 90,8 100,12 110,6 120,9";

/** Live KPI readout inside the mock. Counts up when a real value arrives;
 *  renders the honest em dash whenever the platform reports nothing. */
function MockValue({ value, unit }) {
  const shown = useCountUp(value, { format: (n) => formatCount(Math.round(n)) });
  return (
    <>
      {value == null ? "—" : shown}
      {unit ? <i>{unit}</i> : null}
    </>
  );
}

function MockFlowNode({ name, note }) {
  return (
    <div className="ls-pm-node">
      <span className="ls-pm-nname">{name}</span>
      <span className="ls-pm-nnote">{note}</span>
      <i className="ls-pm-led ok" aria-hidden />
    </div>
  );
}

/** Event Flow inside the mock — the platform's real topology: Kafka forks to
 *  two independent consumer groups, and the lanes never rejoin. */
function MockFlow() {
  return (
    <div className="ls-pm-flow">
      <div className="ls-pm-lane-head">
        <MockFlowNode name="API" note="Ingesting" />
        <span className="ls-pm-link" aria-hidden />
        <MockFlowNode name="Kafka" note="Buffering" />
      </div>
      <span className="ls-pm-fork" aria-hidden />
      <div className="ls-pm-lanes">
        <div className="ls-pm-lane">
          <MockFlowNode name="Persistence Worker" note="Consuming" />
          <span className="ls-pm-link" aria-hidden />
          <MockFlowNode name="PostgreSQL" note="Storing" />
        </div>
        <div className="ls-pm-lane">
          <MockFlowNode name="Analytics Worker" note="Consuming" />
          <span className="ls-pm-link" aria-hidden />
          <MockFlowNode name="Redis" note="Aggregating" />
          <span className="ls-pm-link" aria-hidden />
          <MockFlowNode name="WebSocket" note="Streaming" />
        </div>
      </div>
    </div>
  );
}

/**
 * Product mock — a compact, faithful rendering of the real Overview page.
 * The KPI values come from the live public snapshot, so the preview is a real
 * reading of this environment (honest "—" when a metric is not reported)
 * rather than a mock-up with invented figures. `live` (the hero's reveal
 * state) draws the sparkline once the mock is on screen.
 */
export function ProductMock({ metrics, live }) {
  const kpis = [
    { label: "Events / sec", value: metrics?.events_per_second, sub: "Live throughput" },
    { label: "Events / min", value: metrics?.events_per_minute, sub: "Trailing minute" },
    { label: "Processed", text: ratePct(metrics?.events_processed_total, metrics?.events_failed_total), sub: "Success rate" },
    { label: "Failed", text: ratePct(metrics?.events_failed_total, metrics?.events_processed_total), sub: "Failure rate" },
    {
      label: "Avg latency",
      value: metrics?.processing_latency_avg_ms,
      unit: metrics?.processing_latency_avg_ms == null ? undefined : "ms",
      sub: "Per event",
    },
    { label: "Consumer lag", value: metrics?.consumer_lag, sub: "Across groups" },
  ];

  return (
    <div className={`ls-pm${live ? " is-drawn" : ""}`} aria-label="Preview of the PulseStream Overview dashboard">
      <div className="ls-pm-bar">
        <span className="ls-pm-dots" aria-hidden><i /><i /><i /></span>
        <span className="ls-pm-title">PulseStream — Overview</span>
        <span className="ls-pm-live"><i aria-hidden />{metrics ? "Live" : "Idle"}</span>
      </div>

      <div className="ls-pm-shell">
        <div className="ls-pm-side" aria-hidden>
          <div className="ls-pm-brand">
            <span className="ls-pm-mark"><IconPulse size={11} /></span>
            PulseStream
          </div>
          {PREVIEW_NAV.map((g) => (
            <div className="ls-pm-group" key={g.group}>
              <div className="ls-pm-glabel">{g.group}</div>
              {g.items.map((it) => (
                <div className={`ls-pm-item${it.active ? " is-active" : ""}`} key={it.label}>
                  <i className="ls-pm-idot" />
                  {it.label}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="ls-pm-main">
          <div className="ls-pm-kpis">
            {kpis.map((k) => (
              <div className="ls-pm-kpi" key={k.label}>
                <span className="ls-pm-klabel">{k.label}</span>
                <span className="ls-pm-kvalue">
                  {k.text != null ? k.text : <MockValue value={k.value} unit={k.unit} />}
                </span>
                <span className="ls-pm-ksub">{k.sub}</span>
              </div>
            ))}
          </div>

          <div className="ls-pm-card">
            <div className="ls-pm-chead">
              <span className="ls-pm-ctitle">Event Flow</span>
              <span className="ls-pm-chip">Topology</span>
            </div>
            <MockFlow />
          </div>

          <div className="ls-pm-card">
            <div className="ls-pm-chead">
              <span className="ls-pm-ctitle">Event Throughput</span>
              <span className="ls-pm-chip">Session window</span>
            </div>
            <svg className="ls-pm-spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="lsSparkFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--ls-burgundy)" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="var(--ls-burgundy)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <polygon points={`0,32 ${SPARK} 120,32`} fill="url(#lsSparkFill)" />
              <polyline className="ls-pm-spark-line" points={SPARK} />
            </svg>
            <div className="ls-pm-feed" aria-hidden>
              {FEED_ROWS.map((r, i) => (
                <div className="ls-pm-feedrow" key={r.type} style={{ "--i": i }}>
                  <span>now</span>
                  <span className="ff-type">{r.type}</span>
                  <span className="ff-src">{r.src}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Hero — the headline reveals line by line, the copy follows, and the product
 * mock beside it is the real dashboard rendered small. All motion is gated on
 * one IntersectionObserver flag (`is-in`); with IO unavailable everything
 * renders in its final state.
 */
export function Hero({ metrics, navigate, onOpenAuth }) {
  const [ref, inView] = useReveal({ threshold: 0.2 });

  return (
    <section id={SECTION.product} ref={ref} className={`ls-hero${inView ? " is-in" : ""}`}>
      <div className="ls-hero-bg" aria-hidden />
      <div className="ls-hero-copy">
        <span className="ls-badge">
          <i className="ls-badge-dot" aria-hidden />
          Real-time by design
        </span>
        <h1 className="ls-h1">
          <span className="ls-line" style={{ "--i": 0 }}>Operational visibility,</span>
          <span className="ls-line" style={{ "--i": 1 }}>
            <span className="ls-h1-accent">in real time.</span>
          </span>
        </h1>
        <p className="ls-lead">
          Ingest, process and visualize your event pipeline — throughput, latency, failures and
          consumer lag — from one multi-tenant workspace. Engineered for correctness, designed
          for clarity.
        </p>

        <div className="ls-hero-cta">
          <button
            type="button"
            className="ls-btn ls-btn-primary ls-btn-lg ls-btn-magnetic"
            onClick={() => (onOpenAuth ? onOpenAuth("signup") : navigate("signup"))}
          >
            Get started free
            <IconArrowRight size={14} />
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-outline ls-btn-lg"
            onClick={() => scrollToSection(SECTION.developer)}
          >
            View documentation
          </button>
        </div>

        <p className="ls-reassure">
          <span><IconCheck size={13} /> No credit card required</span>
          <i aria-hidden>·</i>
          <span><IconCheck size={13} /> Setup in minutes</span>
        </p>
      </div>

      <div className="ls-hero-visual">
        <ProductMock metrics={metrics} live={inView} />
      </div>
    </section>
  );
}
