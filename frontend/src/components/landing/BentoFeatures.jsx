import { Reveal } from "./shared";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconGauge,
  IconKey,
  IconLayers,
  IconRadio,
  IconTerminal,
  IconTimer,
} from "../icons";

/* Decorative stream rows inside the monitoring tile — generic names,
   aria-hidden, purely to show the stream moving. */
const TILE_STREAM = [
  { type: "order.created", src: "checkout" },
  { type: "payment.captured", src: "billing" },
  { type: "user.signup", src: "web-app" },
];

/**
 * Capabilities as a bento — two large visual tiles, four supporting ones.
 * Every title/description is the platform's real feature set; the two large
 * tiles embed small live-feeling visuals (stream rows, key→workspace
 * scoping) rather than icon-and-text only.
 */
export function BentoFeatures() {
  return (
    <section id="ls-features" className="ls-section">
      <Reveal className="ls-shead">
        <span className="ls-eyebrow">Capabilities</span>
        <h2 className="ls-h2">
          Everything you need to <span className="ls-h2-accent">watch</span> your pipeline
        </h2>
        <p className="ls-sub">
          Ingestion, processing and analytics — observable end to end.
        </p>
      </Reveal>

      <Reveal className="ls-bento">
        <article className="ls-bento-tile lg">
          <span className="ls-tile-icon"><IconActivity size={16} /></span>
          <h3 className="ls-tile-title">Real-time event monitoring</h3>
          <p className="ls-tile-desc">
            Watch events land as they are ingested — no refresh, no polling
            loop to write.
          </p>
          <div className="ls-tile-stream" aria-hidden>
            {TILE_STREAM.map((r, i) => (
              <div className="ls-tile-streamrow" key={r.type} style={{ "--i": i }}>
                <span className="tf-time">now</span>
                <span className="tf-type">{r.type}</span>
                <span className="tf-src">{r.src}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="ls-bento-tile lg">
          <span className="ls-tile-icon"><IconLayers size={16} /></span>
          <h3 className="ls-tile-title">Multi-tenant isolation</h3>
          <p className="ls-tile-desc">
            Every event is scoped to the organization that owns the key it
            arrived with — isolated at ingestion, visible only in that
            workspace.
          </p>
          <div className="ls-tile-scope" aria-hidden>
            <span className="ls-tile-key">
              <IconKey size={12} />
              pk_live_••••
            </span>
            <IconArrowRight size={13} className="ls-tile-arrow" />
            <span className="ls-tile-org">
              <IconLayers size={12} />
              Workspace
            </span>
          </div>
        </article>

        <article className="ls-bento-tile md">
          <span className="ls-tile-icon"><IconKey size={16} /></span>
          <h3 className="ls-tile-title">Secure API keys</h3>
          <p className="ls-tile-desc">
            Create, inspect and revoke ingest keys per workspace. Secrets are
            shown once.
          </p>
        </article>

        <article className="ls-bento-tile md">
          <span className="ls-tile-icon"><IconRadio size={16} /></span>
          <h3 className="ls-tile-title">Live WebSocket metrics</h3>
          <p className="ls-tile-desc">
            An authenticated socket streams metrics straight to your
            dashboard.
          </p>
        </article>

        <article className="ls-bento-tile md">
          <span className="ls-tile-icon"><IconAlertTriangle size={16} /></span>
          <h3 className="ls-tile-title">Failure tracking</h3>
          <p className="ls-tile-desc">
            Inspect terminal processing failures and their dead-letter
            outcome.
          </p>
        </article>

        <article className="ls-bento-tile sm">
          <span className="ls-tile-icon"><IconTimer size={16} /></span>
          <h3 className="ls-tile-title">Consumer lag monitoring</h3>
          <p className="ls-tile-desc">
            Per-group lag, self-reported by the workers consuming your events.
          </p>
        </article>

        <article className="ls-bento-tile sm">
          <span className="ls-tile-icon"><IconGauge size={16} /></span>
          <h3 className="ls-tile-title">Analytics</h3>
          <p className="ls-tile-desc">
            Throughput, latency, event types and producer sources over your
            data.
          </p>
        </article>

        <article className="ls-bento-tile sm">
          <span className="ls-tile-icon"><IconTerminal size={16} /></span>
          <h3 className="ls-tile-title">Developer integrations</h3>
          <p className="ls-tile-desc">
            One HTTP POST with an X-API-Key header. No SDK, no agent to
            install.
          </p>
        </article>
      </Reveal>
    </section>
  );
}
