import { useReveal } from "./motion";
import { SECTION } from "./shared";
import {
  IconActivity,
  IconCode,
  IconDatabase,
  IconGauge,
  IconLayers,
  IconPulse,
  IconRadio,
  IconServer,
  IconStream,
} from "../icons";

/** The five stages the copy column walks through as the diagram scrolls. */
const STAGES = [
  {
    title: "Ingest",
    desc: "One authenticated POST. Events are validated against the schema, scoped to the workspace that owns the key, and acknowledged.",
  },
  {
    title: "Buffer",
    desc: "Validated events enter a Kafka topic. The API returns immediately; downstream workers consume at their own pace.",
  },
  {
    title: "Fork",
    desc: "Two independent consumer groups read the same topic. The lanes never rejoin — a slow database write cannot stall live metrics.",
  },
  {
    title: "Persist & aggregate",
    desc: "The persistence worker writes durable rows to PostgreSQL while the analytics worker maintains live aggregates in Redis.",
  },
  {
    title: "Stream",
    desc: "An authenticated WebSocket pushes fresh metrics to every open dashboard — no polling loop, no refresh button.",
  },
];

function PdNode({ Icon, label, note, hot }) {
  return (
    <div className={`ls-pd-node${hot ? " is-hot" : ""}`}>
      <span className="ls-pd-icon"><Icon size={15} /></span>
      <span className="ls-pd-meta">
        <span className="ls-pd-label">{label}</span>
        <span className="ls-pd-note">{note}</span>
      </span>
    </div>
  );
}

/** Vertical connector with a pulse riding down it (CSS keyframes, transform
 *  only). `delay` staggers the pulses so the flow reads sequentially. */
const PdConnector = ({ delay }) => (
  <span className="ls-pd-connector" style={{ "--d": delay }} aria-hidden />
);

/**
 * The signature visual: Source → API → Kafka → fork → two independent lanes →
 * PostgreSQL / Redis → WebSocket → Dashboard. Every node, edge and label is
 * the platform's real topology. The right column holds the diagram; the left
 * column is sticky and its stage dots light up as the diagram scrolls — the
 * story is legible even with animations disabled.
 */
export function PipelineSection() {
  const [ref, inView] = useReveal({ threshold: 0.05, rootMargin: "0px 0px -16% 0px" });

  return (
    <section id={SECTION.how} className="ls-pipe-wrap">
      <div ref={ref} className={`ls-section ls-pipe${inView ? " is-in" : ""}`}>
        <div className="ls-pipe-copy">
          <span className="ls-eyebrow">The pipeline</span>
          <h2 className="ls-h2">How PulseStream works</h2>
          <p className="ls-sub">
            From event to insight in real time — one topic, two independent
            consumer lanes, no shortcuts.
          </p>
          <div className="ls-pipe-stages">
            {STAGES.map((s) => (
              <div className={`ls-pipe-stage${inView ? " is-active" : ""}`} key={s.title}>
                <span className="ls-pipe-stage-dot" aria-hidden />
                <div>
                  <h3 className="ls-pipe-stage-title">{s.title}</h3>
                  <p className="ls-pipe-stage-desc">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="ls-pipe-diagram" aria-label="PulseStream event pipeline topology">
          <PdNode Icon={IconCode} label="Your Application" note="any language · any runtime" hot={inView} />
          <PdConnector delay="0s" />
          <PdNode Icon={IconServer} label="PulseStream API" note="POST /api/v1/events" hot={inView} />
          <PdConnector delay="0.3s" />
          <PdNode Icon={IconStream} label="Kafka" note="application-events" hot={inView} />
          <svg className="ls-pd-fork" viewBox="0 0 200 34" preserveAspectRatio="none" aria-hidden="true">
            <path d="M100 0 V13 M14 13 H186 M14 13 V34 M186 13 V34" />
            <path className="ls-pd-fork-flow" d="M100 0 V13 M14 13 H186 M14 13 V34 M186 13 V34" />
          </svg>
          <div className="ls-pd-branches">
            <div className="ls-pd-branch">
              <PdNode Icon={IconGauge} label="Persistence Worker" note="consumer group A" hot={inView} />
              <PdConnector delay="0.6s" />
              <PdNode Icon={IconDatabase} label="PostgreSQL" note="durable event store" hot={inView} />
            </div>
            <div className="ls-pd-branch">
              <PdNode Icon={IconActivity} label="Analytics Worker" note="consumer group B" hot={inView} />
              <PdConnector delay="0.6s" />
              <PdNode Icon={IconLayers} label="Redis" note="live aggregates" hot={inView} />
              <PdConnector delay="0.9s" />
              <PdNode Icon={IconRadio} label="WebSocket" note="server push" hot={inView} />
              <PdConnector delay="1.2s" />
              <PdNode Icon={IconPulse} label="Dashboard" note="your workspace" hot={inView} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
