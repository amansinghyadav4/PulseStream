import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Metrics } from "../types/metrics";
import type { Route } from "../lib/router";
import { formatCount } from "../lib/format";
import { CopyButton } from "./CopyButton";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconBolt,
  IconCheck,
  IconCode,
  IconCommit,
  IconDatabase,
  IconGauge,
  IconKey,
  IconLayers,
  IconPulse,
  IconRadio,
  IconServer,
  IconShield,
  IconStream,
  IconTerminal,
  IconTimer,
} from "./icons";

/**
 * In-page section ids. The app uses a HASH router, so landing anchors are
 * scrolled to imperatively — never through `href="#..."`, which would rewrite
 * window.location.hash and be parsed as a route change.
 */
const SECTION = {
  product: "ls-product",
  features: "ls-features",
  how: "ls-how",
  developer: "ls-developer",
  final: "ls-final",
} as const;

/** Marketing nav. Every entry targets a real section on this page — there is no
 *  docs/pricing route in the app, so nothing here can dead-end. */
const NAV_LINKS: { label: string; target: string }[] = [
  { label: "Product", target: SECTION.product },
  { label: "Features", target: SECTION.features },
  { label: "Pricing", target: SECTION.final },
  { label: "Docs", target: SECTION.developer },
  { label: "Integrations", target: SECTION.developer },
  { label: "About", target: SECTION.how },
];

const VALUE_PROPS = [
  { Icon: IconActivity, title: "Real-time insights", desc: "Live metrics and event flow" },
  { Icon: IconLayers, title: "Multi-tenant isolation", desc: "Secure, organization-scoped data" },
  { Icon: IconCode, title: "Built for developers", desc: "Simple API, powerful observability" },
];

const TRUST_ITEMS = [
  { Icon: IconLayers, label: "Multi-tenant ready" },
  { Icon: IconShield, label: "Enterprise security" },
  { Icon: IconBolt, label: "High performance" },
  { Icon: IconCode, label: "Developer friendly" },
  { Icon: IconCommit, label: "Open & extensible" },
];

const STEPS = [
  { Icon: IconCode, title: "Your Application", desc: "Send events to the PulseStream ingestion API." },
  { Icon: IconStream, title: "Ingest & Buffer", desc: "Events are validated and buffered in Kafka." },
  { Icon: IconGauge, title: "Process", desc: "Workers process events for storage and analytics." },
  { Icon: IconDatabase, title: "Store & Analyze", desc: "Data is stored in PostgreSQL and Redis." },
  { Icon: IconActivity, title: "Visualize", desc: "Real-time dashboards use WebSocket and polling." },
];

const FEATURES = [
  { Icon: IconActivity, title: "Real-time event monitoring", desc: "Watch events land as they are ingested — no refresh, no polling loop to write." },
  { Icon: IconLayers, title: "Multi-tenant workspaces", desc: "Every event is scoped to the organization that owns the key it arrived with." },
  { Icon: IconKey, title: "Secure API keys", desc: "Create, inspect and revoke ingest keys per workspace. Secrets are shown once." },
  { Icon: IconRadio, title: "Live WebSocket metrics", desc: "An authenticated socket streams metrics straight to your dashboard." },
  { Icon: IconAlertTriangle, title: "Failure tracking", desc: "Inspect terminal processing failures and their dead-letter outcome." },
  { Icon: IconTimer, title: "Consumer lag monitoring", desc: "Per-group lag, self-reported by the workers consuming your events." },
  { Icon: IconGauge, title: "Analytics", desc: "Throughput, latency, event types and producer sources over your data." },
  { Icon: IconTerminal, title: "Developer integrations", desc: "One HTTP POST with an X-API-Key header. No SDK, no agent to install." },
];

/** Sidebar of the product preview — mirrors the real dashboard navigation. */
const PREVIEW_NAV: { group: string; items: { label: string; active?: boolean }[] }[] = [
  { group: "Overview", items: [{ label: "Overview", active: true }, { label: "Analytics" }] },
  { group: "Explore", items: [{ label: "Events" }, { label: "Failures" }, { label: "Sources" }] },
  { group: "Infrastructure", items: [{ label: "Pipeline" }, { label: "Health" }] },
  { group: "Developer", items: [{ label: "API Keys" }, { label: "Integrations" }] },
  { group: "Tools", items: [{ label: "Simulator" }] },
];

const CONNECT_SNIPPET = `curl -X POST https://<your-host>/api/v1/events \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "event_type": "order.created", "source": "checkout-service" }'`;

/** Live value, or an honest em dash when the platform is not reporting it.
 *  Nothing on this page is a fabricated or illustrative number. */
function metricText(v: number | null | undefined): string {
  return v == null ? "—" : formatCount(v);
}

/** part / (part + other) as a percentage — "—" unless both halves are known. */
function ratePct(part: number | undefined, other: number | undefined): string {
  if (part == null || other == null) return "—";
  const whole = part + other;
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

/** Scroll to an in-page section without touching location.hash (hash router). */
function scrollToSection(id: string): void {
  const el = document.getElementById(id);
  if (!el || typeof el.scrollIntoView !== "function") return;
  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

/**
 * Reveals its children once they scroll into view. Where IntersectionObserver is
 * unavailable (jsdom, older browsers) the content renders visible immediately —
 * the animation is decoration, never a gate on the content.
 */
function Reveal({ id, className, delay, children }: { id?: string; className?: string; delay?: number; children: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section
      id={id}
      ref={ref}
      className={`${className ?? ""} ls-reveal${shown ? " is-in" : ""}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </section>
  );
}

function PvNode({ name, note }: { name: string; note: string }) {
  return (
    <div className="ls-pv-node">
      <span className="ls-pv-nname">{name}</span>
      <span className="ls-pv-nnote">{note}</span>
      <i className="ls-pv-led ok" aria-hidden />
    </div>
  );
}

/** Event Flow inside the preview — the platform's real topology: Kafka forks to
 *  two independent consumer groups, and the lanes never rejoin. */
function PvFlow() {
  return (
    <div className="ls-pv-flow">
      <div className="ls-pv-lane-head">
        <PvNode name="API" note="Ingesting" />
        <span className="ls-pv-link" aria-hidden />
        <PvNode name="Kafka" note="Buffering" />
      </div>
      <span className="ls-pv-fork" aria-hidden />
      <div className="ls-pv-lanes">
        <div className="ls-pv-lane">
          <PvNode name="Persistence Worker" note="Consuming" />
          <span className="ls-pv-link" aria-hidden />
          <PvNode name="PostgreSQL" note="Storing" />
        </div>
        <div className="ls-pv-lane">
          <PvNode name="Analytics Worker" note="Consuming" />
          <span className="ls-pv-link" aria-hidden />
          <PvNode name="Redis" note="Aggregating" />
          <span className="ls-pv-link" aria-hidden />
          <PvNode name="WebSocket" note="Streaming" />
        </div>
      </div>
    </div>
  );
}

/* Decorative throughput trace: shape only, deliberately unlabelled — no axis
   values, so the preview never implies a measurement that was not taken. */
const SPARK = "0,27 10,23 20,25 30,18 40,21 50,15 60,18 70,11 80,14 90,8 100,12 110,6 120,9";

function PvSpark() {
  return (
    <svg className="ls-pv-spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="lsSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,32 ${SPARK} 120,32`} fill="url(#lsSparkFill)" />
      <polyline className="ls-pv-spark-line" points={SPARK} />
    </svg>
  );
}

/**
 * Product preview — a compact, faithful rendering of the real Overview page.
 * The KPI values come from the live public snapshot, so the preview is a real
 * reading of this environment (honest "—" when a metric is not reported)
 * rather than a mock-up with invented figures.
 */
function ProductPreview({ metrics }: { metrics: Metrics | null }) {
  const kpis: { label: string; value: string; unit?: string; sub: string }[] = [
    { label: "Events / sec", value: metricText(metrics?.events_per_second), sub: "Live throughput" },
    { label: "Events / min", value: metricText(metrics?.events_per_minute), sub: "Trailing minute" },
    { label: "Processed", value: ratePct(metrics?.events_processed_total, metrics?.events_failed_total), sub: "Success rate" },
    { label: "Failed", value: ratePct(metrics?.events_failed_total, metrics?.events_processed_total), sub: "Failure rate" },
    {
      label: "Avg latency",
      value: metricText(metrics?.processing_latency_avg_ms),
      unit: metrics?.processing_latency_avg_ms == null ? undefined : "ms",
      sub: "Per event",
    },
    { label: "Consumer lag", value: metricText(metrics?.consumer_lag), sub: "Across groups" },
  ];

  return (
    <div className="ls-preview" aria-label="Preview of the PulseStream Overview dashboard">
      <div className="ls-pv-shell">
        <div className="ls-pv-side" aria-hidden>
          <div className="ls-pv-brand">
            <span className="ls-pv-mark"><IconPulse size={11} /></span>
            PulseStream
          </div>
          {PREVIEW_NAV.map((g) => (
            <div className="ls-pv-group" key={g.group}>
              <div className="ls-pv-glabel">{g.group}</div>
              {g.items.map((it) => (
                <div className={`ls-pv-item${it.active ? " is-active" : ""}`} key={it.label}>
                  <i className="ls-pv-idot" />
                  {it.label}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="ls-pv-main">
          <div className="ls-pv-head">
            <span className="ls-pv-title">Overview</span>
            <span className="ls-pv-pills">
              <span className="ls-pv-pill"><i className="ls-pv-led ok" aria-hidden />{metrics ? "Live" : "Idle"}</span>
              <span className="ls-pv-pill"><i className="ls-pv-led ok" aria-hidden />Healthy</span>
            </span>
          </div>

          <div className="ls-pv-kpis">
            {kpis.map((k) => (
              <div className="ls-pv-kpi" key={k.label}>
                <span className="ls-pv-klabel">{k.label}</span>
                <span className="ls-pv-kvalue">
                  {k.value}
                  {k.unit ? <i>{k.unit}</i> : null}
                </span>
                <span className="ls-pv-ksub">{k.sub}</span>
              </div>
            ))}
          </div>

          <div className="ls-pv-card">
            <div className="ls-pv-ctitle">Event Flow</div>
            <PvFlow />
          </div>

          <div className="ls-pv-card">
            <div className="ls-pv-chead">
              <span className="ls-pv-ctitle">Event Throughput</span>
              <span className="ls-pv-chip">Session window</span>
            </div>
            <PvSpark />
          </div>
        </div>
      </div>
    </div>
  );
}

function ArchNode({
  Icon,
  label,
  note,
  tone,
}: {
  Icon: (p: { size?: number }) => ReactNode;
  label: string;
  note?: string;
  tone?: "accent";
}) {
  return (
    <div className={`ls-arch-node${tone === "accent" ? " is-accent" : ""}`}>
      <span className="ls-arch-icon"><Icon size={14} /></span>
      <span className="ls-arch-meta">
        <span className="ls-arch-label">{label}</span>
        {note ? <span className="ls-arch-note">{note}</span> : null}
      </span>
    </div>
  );
}

const ArchLink = () => <span className="ls-arch-link" aria-hidden />;

/** The real end-to-end path: one ingest API, one Kafka topic, two independent
 *  consumer groups whose lanes stay separate all the way to the dashboard. */
function ArchDiagram() {
  return (
    <div className="ls-arch">
      <ArchNode Icon={IconCode} label="Your Application" note="any language, any runtime" />
      <ArchLink />
      <ArchNode Icon={IconServer} label="PulseStream API" note="POST /api/v1/events" tone="accent" />
      <ArchLink />
      <ArchNode Icon={IconStream} label="Kafka" note="application-events" />
      <svg className="ls-arch-fork" viewBox="0 0 200 34" preserveAspectRatio="none" aria-hidden="true">
        <path d="M100 0 V13 M14 13 H186 M14 13 V34 M186 13 V34" />
      </svg>
      <div className="ls-arch-branches">
        <div className="ls-arch-branch">
          <ArchNode Icon={IconGauge} label="Persistence Worker" note="durable write path" />
          <ArchLink />
          <ArchNode Icon={IconDatabase} label="PostgreSQL" note="queryable event store" />
        </div>
        <div className="ls-arch-branch">
          <ArchNode Icon={IconActivity} label="Analytics Worker" note="aggregation path" />
          <ArchLink />
          <ArchNode Icon={IconLayers} label="Redis" note="live aggregates" />
          <ArchLink />
          <ArchNode Icon={IconRadio} label="WebSocket" note="server push" />
          <ArchLink />
          <ArchNode Icon={IconPulse} label="Dashboard" note="your workspace" tone="accent" />
        </div>
      </div>
    </div>
  );
}

/** Numbered process row. Connectors are decorative and collapse to a vertical
 *  rail on narrow viewports (CSS), so the flow never scrolls sideways. */
function StepsRow() {
  return (
    <div className="ls-steps">
      {STEPS.map((s, i) => (
        <div className="ls-step-cell" key={s.title}>
          <div className="ls-step">
            <span className="ls-step-icon"><s.Icon size={16} /></span>
            <span className="ls-step-n">{i + 1}</span>
            <h3 className="ls-step-title">{s.title}</h3>
            <p className="ls-step-desc">{s.desc}</p>
          </div>
          {i < STEPS.length - 1 ? (
            <span className="ls-step-arrow" aria-hidden>
              <IconArrowRight size={14} />
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function FeaturesGrid() {
  return (
    <div className="ls-features">
      {FEATURES.map((f) => (
        <article className="ls-feature" key={f.title}>
          <span className="ls-feature-icon"><f.Icon size={15} /></span>
          <h3 className="ls-feature-title">{f.title}</h3>
          <p className="ls-feature-desc">{f.desc}</p>
        </article>
      ))}
    </div>
  );
}

/** Marketing top bar. Section links are BUTTONS (never anchors) so the hash
 *  router never sees an in-page jump as a route change. */
function LandingNav({ navigate }: { navigate: (r: Route) => void }) {
  return (
    <header className="ls-nav">
      <div className="ls-nav-inner">
        <button type="button" className="ls-brand" onClick={() => scrollToSection(SECTION.product)}>
          <span className="ls-brand-mark"><IconPulse size={16} /></span>
          <span className="ls-brand-text">
            <span className="ls-brand-name">PulseStream</span>
            <span className="ls-brand-sub">Real-Time Event Analytics</span>
          </span>
        </button>

        <nav className="ls-nav-links" aria-label="Sections">
          {NAV_LINKS.map((l) => (
            <button type="button" className="ls-nav-link" key={l.label} onClick={() => scrollToSection(l.target)}>
              {l.label}
            </button>
          ))}
        </nav>

        <div className="ls-nav-cta">
          <button type="button" className="ls-btn ls-btn-ghost" onClick={() => navigate("login")}>
            Sign in
          </button>
          <button type="button" className="ls-btn ls-btn-primary" onClick={() => navigate("signup")}>
            Get started free
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * Footer. Every interactive entry resolves to something that exists: an in-page
 * section, the signup route or the login route. The Legal column is rendered as
 * plain text because this deployment publishes no legal pages — inventing
 * routes for them would dead-end the visitor.
 */
function LandingFooter({ navigate }: { navigate: (r: Route) => void }) {
  const groups: { title: string; items: { label: string; onClick?: () => void }[] }[] = [
    {
      title: "Product",
      items: [
        { label: "Overview", onClick: () => scrollToSection(SECTION.product) },
        { label: "Features", onClick: () => scrollToSection(SECTION.features) },
        { label: "How it works", onClick: () => scrollToSection(SECTION.how) },
      ],
    },
    {
      title: "Developers",
      items: [
        { label: "Documentation", onClick: () => scrollToSection(SECTION.developer) },
        { label: "Integrations", onClick: () => scrollToSection(SECTION.developer) },
        { label: "Get started free", onClick: () => navigate("signup") },
      ],
    },
    {
      title: "Company",
      items: [
        { label: "About", onClick: () => scrollToSection(SECTION.how) },
        { label: "Sign in", onClick: () => navigate("login") },
      ],
    },
    { title: "Legal", items: [{ label: "Terms" }, { label: "Privacy" }, { label: "Security" }] },
  ];

  return (
    <footer className="ls-foot">
      <div className="ls-foot-inner">
        <div className="ls-foot-brand">
          <span className="ls-brand-mark"><IconPulse size={15} /></span>
          <span className="ls-brand-name">PulseStream</span>
          <p className="ls-foot-tag">Real-time event analytics for multi-tenant workspaces.</p>
        </div>
        <div className="ls-foot-cols">
          {groups.map((g) => (
            <div className="ls-foot-col" key={g.title}>
              <h3 className="ls-foot-title">{g.title}</h3>
              <ul className="ls-foot-list">
                {g.items.map((it) => (
                  <li key={it.label}>
                    {it.onClick ? (
                      <button type="button" className="ls-foot-link" onClick={it.onClick}>
                        {it.label}
                      </button>
                    ) : (
                      <span className="ls-foot-static">{it.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="ls-foot-bar">PulseStream — event ingestion, processing and analytics.</div>
    </footer>
  );
}

/**
 * Public marketing page for PulseStream. Rendered by App for route "landing"
 * with the unauthenticated metrics snapshot, so every figure shown is either a
 * real reading or an em dash.
 *
 * CTA wiring: "Get started free" → signup, "Sign in" → login. There is no docs
 * route in this app (the integration guide lives behind auth at #/integrations),
 * so "View documentation" / "Docs" scroll to the on-page developer section.
 */
export function LandingPage({ metrics, navigate }: { metrics: Metrics | null; navigate: (r: Route) => void }) {
  const goSignup = () => navigate("signup");
  const goDocs = () => scrollToSection(SECTION.developer);

  return (
    <div className="ls">
      <LandingNav navigate={navigate} />

      <main className="ls-main">
        <Reveal id={SECTION.product} className="ls-hero">
          <div className="ls-hero-copy">
            <span className="ls-badge">
              <i className="ls-badge-dot" aria-hidden />
              Real-time by design
            </span>
            <h1 className="ls-h1">
              Operational visibility,
              <br />
              <span className="ls-h1-accent">in real time.</span>
            </h1>
            <p className="ls-lead">
              Ingest, process and visualize your event pipeline — throughput, latency, failures and
              consumer lag — from one multi-tenant workspace.
            </p>

            <ul className="ls-props">
              {VALUE_PROPS.map((p) => (
                <li className="ls-prop" key={p.title}>
                  <span className="ls-prop-icon"><p.Icon size={14} /></span>
                  <span className="ls-prop-text">
                    <span className="ls-prop-title">{p.title}</span>
                    <span className="ls-prop-desc">{p.desc}</span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="ls-hero-cta">
              <button type="button" className="ls-btn ls-btn-primary ls-btn-lg" onClick={goSignup}>
                Get started free
                <IconArrowRight size={14} />
              </button>
              <button type="button" className="ls-btn ls-btn-outline ls-btn-lg" onClick={goDocs}>
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
            <ProductPreview metrics={metrics} />
          </div>
        </Reveal>

        <Reveal className="ls-trust">
          <p className="ls-trust-title">Built for teams that need real-time visibility</p>
          <ul className="ls-trust-list">
            {TRUST_ITEMS.map((t) => (
              <li className="ls-trust-item" key={t.label}>
                <span className="ls-trust-icon"><t.Icon size={14} /></span>
                {t.label}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal id={SECTION.how} className="ls-section">
          <div className="ls-shead">
            <h2 className="ls-h2">How PulseStream works</h2>
            <p className="ls-sub">From event to insight in real time.</p>
          </div>
          <StepsRow />
        </Reveal>

        <Reveal id={SECTION.features} className="ls-section">
          <div className="ls-shead">
            <h2 className="ls-h2">Everything you need to watch your pipeline</h2>
            <p className="ls-sub">Ingestion, processing and analytics — observable end to end.</p>
          </div>
          <FeaturesGrid />
        </Reveal>

        <Reveal id={SECTION.developer} className="ls-section ls-dev">
          <div className="ls-dev-copy">
            <span className="ls-eyebrow">For developers</span>
            <h2 className="ls-h2">Connect any application in one request</h2>
            <p className="ls-sub ls-sub-left">
              Any external service can send events over plain HTTP — one POST with your workspace
              API key. No SDK to install, no agent to run. From there the platform validates,
              buffers, processes and streams the result back to your dashboard.
            </p>
            <div className="code-block ls-code">
              <div className="code-block-head">
                <span className="code-lang">Shell</span>
                <CopyButton value={CONNECT_SNIPPET} className="btn" label="Copy" compact />
              </div>
              <pre className="code-body"><code>{CONNECT_SNIPPET}</code></pre>
            </div>
            <button type="button" className="ls-btn ls-btn-primary ls-btn-lg" onClick={goSignup}>
              Start sending events
              <IconArrowRight size={14} />
            </button>
          </div>
          <div className="ls-dev-visual">
            <ArchDiagram />
          </div>
        </Reveal>

        <Reveal id={SECTION.final} className="ls-final">
          <h2 className="ls-h2">Ready to see your events in real time?</h2>
          <p className="ls-sub">
            Connect your application to PulseStream and get operational visibility from ingestion to
            analytics.
          </p>
          <div className="ls-final-cta">
            <button type="button" className="ls-btn ls-btn-primary ls-btn-lg" onClick={goSignup}>
              Get started free
              <IconArrowRight size={14} />
            </button>
            <button type="button" className="ls-btn ls-btn-outline ls-btn-lg" onClick={goDocs}>
              View documentation
            </button>
          </div>
        </Reveal>
      </main>

      <LandingFooter navigate={navigate} />
    </div>
  );
}

