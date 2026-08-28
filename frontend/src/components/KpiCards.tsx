import type { ReactNode } from "react";
import type { Metrics } from "../types/metrics";
import { formatCount } from "../lib/format";
import {
  IconActivity,
  IconAlertTriangle,
  IconCheckCircle,
  IconClock,
  IconCommit,
  IconInbox,
  IconRadio,
  IconTimer,
} from "./icons";

export type MetricKey =
  | "total"
  | "eventsPerSecond"
  | "eventsPerMinute"
  | "processed"
  | "failed"
  | "latency"
  | "producers"
  | "lag";

const ACCENT: Record<MetricKey, { icon: ReactNode; accent: string; iconCls: string }> = {
  total: { icon: <IconInbox />, accent: "blue", iconCls: "icon-blue" },
  eventsPerSecond: { icon: <IconActivity />, accent: "blue", iconCls: "icon-blue" },
  eventsPerMinute: { icon: <IconClock />, accent: "blue", iconCls: "icon-blue" },
  processed: { icon: <IconCheckCircle />, accent: "green", iconCls: "kpi-icon-ok" },
  failed: { icon: <IconAlertTriangle />, accent: "red", iconCls: "kpi-icon-danger" },
  latency: { icon: <IconTimer />, accent: "purple", iconCls: "icon-purple" },
  producers: { icon: <IconRadio />, accent: "green", iconCls: "kpi-icon-ok" },
  lag: { icon: <IconCommit />, accent: "blue", iconCls: "icon-blue" },
};

/**
 * Dense KPI card grid — reference layout: uppercase label, bold value,
 * unit, context sub-line, metric icon top-right and a thin colored
 * accent underline per metric family. Values come ONLY from the real
 * metrics snapshot; missing values render as honest Unavailable.
 */
export function Overview({
  metrics,
  onMetric,
  exclude = [],
}: {
  metrics: Metrics | null;
  onMetric?: (key: MetricKey) => void;
  exclude?: MetricKey[];
}) {
  const items: Array<Parameters<typeof Kpi>[0]> = [
    {
      metricKey: "total",
      label: "Total Events",
      loading: !metrics,
      value: metrics ? formatCount(metrics.total) : null,
      sub: metrics ? "acknowledged by API" : undefined,
    },
    {
      metricKey: "eventsPerSecond",
      label: "Events / Sec",
      loading: !metrics,
      value: metrics ? formatCount(metrics.events_per_second ?? 0) : null,
      sub: metrics ? "live" : undefined,
    },
    {
      metricKey: "eventsPerMinute",
      label: "Events / Min",
      loading: !metrics,
      value: metrics ? formatCount(metrics.events_per_minute) : null,
      sub: metrics ? "last 1 minute" : undefined,
    },
    {
      metricKey: "processed",
      label: "Processed",
      tone: "ok",
      loading: !metrics,
      value:
        !metrics || metrics.events_processed_total === undefined
          ? null
          : formatCount(metrics.events_processed_total),
      unavailableSub: metrics ? "not reported in this snapshot" : undefined,
      sub: metrics ? "successfully" : undefined,
    },
    {
      metricKey: "failed",
      label: "Failed",
      tone: metrics && (metrics.events_failed_total ?? 0) > 0 ? "danger" : undefined,
      loading: !metrics,
      value:
        !metrics || metrics.events_failed_total === undefined
          ? null
          : formatCount(metrics.events_failed_total),
      unavailableSub: metrics ? "not reported in this snapshot" : undefined,
      sub: metrics ? "dead-lettered" : undefined,
    },
    {
      metricKey: "latency",
      label: "Avg Latency",
      loading: !metrics,
      unit: metrics?.processing_latency_avg_ms != null ? "ms" : undefined,
      value:
        metrics?.processing_latency_avg_ms != null ? String(metrics.processing_latency_avg_ms) : null,
      unavailableSub: metrics ? "no counted events yet" : undefined,
      sub: metrics ? "worker per event" : undefined,
    },
    {
      metricKey: "producers",
      label: "Producers",
      loading: !metrics,
      value: metrics ? String(metrics.active_producers) : null,
      sub: metrics ? "distinct sources" : undefined,
    },
    {
      metricKey: "lag",
      label: "Consumer Lag",
      loading: !metrics,
      value: metrics?.consumer_lag != null ? formatCount(metrics.consumer_lag) : null,
      unavailableSub: metrics ? "workers not reporting yet" : undefined,
      sub: metrics ? "across groups" : undefined,
    },
  ];

  return (
    <div className="kpi-grid">
      {items
        .filter((it) => !exclude.includes(it.metricKey!))
        .map((it) => (
          <Kpi key={it.metricKey} {...it} onMetric={onMetric} />
        ))}
    </div>
  );
}

function Kpi({
  label,
  icon: _icon,
  value,
  unit,
  sub,
  unavailableSub,
  loading = false,
  tone,
  metricKey,
  onMetric,
}: {
  label: string;
  icon?: ReactNode;
  value: string | null;
  unit?: string;
  sub?: string;
  unavailableSub?: string;
  loading?: boolean;
  tone?: "ok" | "danger";
  metricKey?: MetricKey;
  onMetric?: (key: MetricKey) => void;
}) {
  const unavailable = !loading && value === null;
  const clickable = !!onMetric && !!metricKey && !loading && !unavailable;
  const meta = metricKey ? ACCENT[metricKey] : undefined;

  return (
    <div
      className={[
        "kpi-card",
        clickable ? "row-clickable" : "",
        tone === "danger" && !unavailable ? "tone-danger" : "",
        meta ? `kpi-accent-${meta.accent}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable && metricKey ? () => onMetric?.(metricKey) : undefined}
      onKeyDown={(e) => {
        if (clickable && (e.key === "Enter" || e.key === " ") && metricKey) {
          e.preventDefault();
          onMetric?.(metricKey);
        }
      }}
      aria-label={clickable ? `${label} — open details` : label}
    >
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <span className={`kpi-icon ${meta?.iconCls ?? ""}`}>{meta?.icon}</span>
      </div>

      {loading ? (
        <>
          <span className="skeleton" style={{ display: "block", width: 64, height: 24, margin: "4px 0 6px" }} aria-hidden />
          <span className="skeleton" style={{ display: "block", width: 96, height: 9 }} aria-hidden />
        </>
      ) : unavailable ? (
        <>
          <span className="kpi-value small">Unavailable</span>
          <span className="kpi-sub kpi-sub-warn">{unavailableSub ?? "no data reported"}</span>
        </>
      ) : (
        <>
          <span className="kpi-value">
            {value}
            {unit ? <span className="value-unit">{unit}</span> : null}
          </span>
          <span className="kpi-sub">{sub}</span>
        </>
      )}
    </div>
  );
}
