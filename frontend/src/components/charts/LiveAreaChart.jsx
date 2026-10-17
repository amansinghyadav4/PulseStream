import { useLayoutEffect, useRef, useState } from "react";

/**
 * Measures the wrapped element so the SVG can be drawn at real pixel width.
 * Without this the viewBox would have to be stretched, which distorts the axis
 * text. One ResizeObserver, one state update per real resize.
 */
function useMeasuredWidth(fallback = 1000) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const read = () => Math.round(el.getBoundingClientRect().width);
    setWidth((prev) => (prev === read() ? prev : read()));
    const ro = new ResizeObserver(() => {
      const next = read();
      setWidth((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width > 0 ? width : fallback];
}

/**
 * Live area chart for events/second observed during this browser session.
 *
 * Honest by construction: it plots ONLY values actually received during the
 * session (see useSessionSeries). The backend retains no time series, so with
 * fewer than two samples it says it is still collecting rather than drawing a
 * curve from nothing.
 *
 * The crosshair is real inspection: pointer position maps to the nearest
 * observed sample, and the readout shows that sample's own clock time.
 */
export function LiveAreaChart({ points, height = 260, unit = "ev/s" }) {
  const [hover, setHover] = useState(null);
  const [wrapRef, measuredWidth] = useMeasuredWidth();

  if (points.length < 2) {
    return (
      <div className="chart-wrap" ref={wrapRef}>
        <div className="empty-state">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M3 12h4l2.5-7 4 14L16 12h5" />
          </svg>
          <span className="empty-title">Collecting live samples…</span>
          <span>
            This chart plots real updates as they arrive — the backend retains no historical series, so there is
            nothing older to draw.
          </span>
        </div>
      </div>
    );
  }

  const W = measuredWidth;
  const H = height;
  const PAD_L = 46;
  const PAD_R = 16;
  const PAD_T = 26;
  const PAD_B = 22;

  const values = points.map((p) => p.v);
  const rawMax = Math.max(...values, 1);
  // Round the axis up to a readable boundary, then add headroom so the peak is
  // never flush with the top gridline.
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const yMax = Math.max(magnitude, Math.ceil(rawMax / magnitude) * magnitude) * 1.08;

  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const x = (i) => PAD_L + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => PAD_T + innerH - (Math.max(0, v) / yMax) * innerH;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const baseY = (PAD_T + innerH).toFixed(1);
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;

  const lastIdx = points.length - 1;
  const ticks = [0, yMax / 3, (yMax * 2) / 3, yMax];
  const active = hover ?? lastIdx;
  const activePoint = points[active];
  const peak = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  const onPointerMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(ratio * (points.length - 1));
    const clamped = Math.max(0, Math.min(points.length - 1, idx));
    setHover((prev) => (prev === clamped ? prev : clamped));
  };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div className="chart-readout">
        <span className="chart-readout-time">
          {new Date(activePoint.t).toLocaleTimeString("en-GB", { hour12: false })}
          {hover === null ? " · latest" : ""}
        </span>
        <span className="chart-readout-value">
          {activePoint.v}
          <span className="chart-readout-unit"> {unit}</span>
        </span>
        <span className="chart-readout-stats">
          session peak <b>{peak}</b> · mean <b>{Math.round(mean * 10) / 10}</b> · {points.length} samples
        </span>
      </div>

      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Events per second observed this session over ${points.length} samples: latest ${values[lastIdx]}, peak ${peak}`}
      >
        <defs>
          <linearGradient id="live-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
            />
            <text x={PAD_L - 10} y={y(t) + 3.5} textAnchor="end" fill="var(--text-muted)">
              {formatTick(t)}
            </text>
          </g>
        ))}

        <text x={PAD_L} y={PAD_T - 12} fill="var(--text-muted)" className="chart-unit">
          {unit}
        </text>

        <path d={areaPath} fill="url(#live-area-fill)" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {[0, 0.25, 0.5, 0.75, 1].map((frac, i, arr) => {
          const idx = Math.min(points.length - 1, Math.round(frac * (points.length - 1)));
          const label = new Date(points[idx].t).toLocaleTimeString("en-GB", { hour12: false });
          const anchor = i === 0 ? "start" : i === arr.length - 1 ? "end" : "middle";
          return (
            <text key={frac} x={PAD_L + frac * innerW} y={H - 6} fill="var(--text-muted)" textAnchor={anchor}>
              {label}
            </text>
          );
        })}

        {/* Crosshair: drawn only while the pointer is inside the plot area. */}
        {hover !== null ? (
          <g pointerEvents="none">
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD_T}
              y2={PAD_T + innerH}
              stroke="var(--border-strong)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={x(hover)} cy={y(points[hover].v)} r="3.5" fill="var(--accent-strong)" />
          </g>
        ) : null}

        <circle cx={x(lastIdx)} cy={y(values[lastIdx])} r="3" fill="var(--accent-strong)" pointerEvents="none" />

        <rect
          x={PAD_L}
          y={PAD_T}
          width={innerW}
          height={innerH}
          fill="transparent"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
          style={{ cursor: "crosshair" }}
        />
      </svg>
    </div>
  );
}

function formatTick(v) {
  const r = Math.round(v);
  if (r >= 1000) return `${(r / 1000).toFixed(r % 1000 === 0 ? 0 : 1)}K`;
  return `${r}`;
}
