import { useCountUp, useReveal } from "./motion";
import { metricText } from "./shared";
import { formatCount } from "../../lib/format";
import { IconCheck, IconRadio, IconTimer } from "../icons";

/** Animated numeric readout: counts up when the real value is known, renders
 *  the honest em dash otherwise. Never shows a fabricated number. */
function LiveValue({ value, className }) {
  const shown = useCountUp(value, { format: (n) => formatCount(Math.round(n)) });
  return <span className={className}>{value == null ? "—" : shown}</span>;
}

/**
 * Analytics showcase — copy on the left, a live panel on the right fed by the
 * same public metrics snapshot the hero uses. The success ring fills to the
 * real processed rate (or rests at zero when nothing is reported).
 */
export function AnalyticsShowcase({ metrics }) {
  const [ref, inView] = useReveal({ threshold: 0.25 });

  const processed = metrics?.events_processed_total;
  const failed = metrics?.events_failed_total;
  const rate =
    processed == null || failed == null
      ? null
      : processed + failed > 0
        ? processed / (processed + failed)
        : null;
  // ring geometry: r=30 → circumference ≈ 188.5
  const C = 2 * Math.PI * 30;
  const offset = C * (1 - (inView && rate != null ? rate : 0));

  return (
    <section ref={ref} className={`ls-section ls-live${inView ? " is-in" : ""}`}>
      <div className="ls-live-copy">
        <span className="ls-eyebrow">Live analytics</span>
        <h2 className="ls-h2">
          Numbers you can <span className="ls-h2-accent">act on</span>
        </h2>
        <p className="ls-sub">
          Every figure on this panel is a real reading from this deployment —
          the same snapshot your dashboard receives. When the platform is not
          reporting a metric, we show an em dash, never an invented number.
        </p>
        <div className="ls-live-points">
          <div className="ls-live-point">
            <IconRadio size={15} />
            <span className="ls-live-point-text">
              <strong>Push, don't poll.</strong> Metrics stream over an
              authenticated WebSocket the moment workers report them.
            </span>
          </div>
          <div className="ls-live-point">
            <IconTimer size={15} />
            <span className="ls-live-point-text">
              <strong>Latency in context.</strong> Average per-event processing
              latency, consumer lag and throughput side by side.
            </span>
          </div>
          <div className="ls-live-point">
            <IconCheck size={15} />
            <span className="ls-live-point-text">
              <strong>Honest by default.</strong> Failed events, dead-letter
              outcomes and exhausted retries are first-class, not hidden.
            </span>
          </div>
        </div>
      </div>

      <div className="ls-live-panel">
        <div className="ls-live-head">
          <span className="ls-live-title">Live metrics — this deployment</span>
          <span className="ls-live-chip"><i aria-hidden />Live</span>
        </div>

        <div className="ls-live-kpis">
          <div className="ls-live-kpi">
            <span className="ls-live-klabel">Events / sec</span>
            <LiveValue value={metrics?.events_per_second} className="ls-live-kvalue" />
            <span className="ls-live-ksub">Live throughput</span>
          </div>
          <div className="ls-live-kpi">
            <span className="ls-live-klabel">Events / min</span>
            <LiveValue value={metrics?.events_per_minute} className="ls-live-kvalue" />
            <span className="ls-live-ksub">Trailing minute</span>
          </div>
          <div className="ls-live-kpi">
            <span className="ls-live-klabel">Avg latency</span>
            <LiveValue
              value={metrics?.processing_latency_avg_ms}
              className="ls-live-kvalue"
            />
            <span className="ls-live-ksub">
              {metrics?.processing_latency_avg_ms == null ? "Per event" : "ms · per event"}
            </span>
          </div>
        </div>

        <div className="ls-ring-row">
          <svg className="ls-ring" width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
            <circle className="track" cx="38" cy="38" r="30" />
            <circle
              className="value"
              cx="38" cy="38" r="30"
              strokeDasharray={C}
              strokeDashoffset={offset}
            />
          </svg>
          <div className="ls-ring-label">
            <span className="ls-ring-value">
              {processed == null || failed == null
                ? "—"
                : rate == null
                  ? "—"
                  : `${Math.round(rate * 1000) / 10}%`}
            </span>
            <span className="ls-ring-desc">
              Events processed successfully — {metricText(processed)} processed,
              {" "}{metricText(failed)} failed, live from the workers.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
