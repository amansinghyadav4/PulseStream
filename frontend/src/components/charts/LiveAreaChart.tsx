import type { SessionPoint } from "../../types/metrics";

/**
 * Live area chart for events/second observed during this browser session.
 *
 * Honest by construction: it renders ONLY the values actually received from
 * the backend during the session (see useSessionSeries). There is no
 * fabricated history — with fewer than 2 samples it shows a "collecting"
 * state instead of pretending a series exists.
 */
export function LiveAreaChart({
  points,
  height = 190,
}: {
  points: SessionPoint[];
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <div className="empty-state" style={{ padding: "40px 16px" }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M3 12h4l2.5-7 4 14L16 12h5" />
        </svg>
        <span className="empty-title">Collecting live samples…</span>
        <span>The chart plots real updates as they arrive. No historical data exists yet.</span>
      </div>
    );
  }

  const W = 1000;
  const H = height;
  const PAD_L = 46;
  const PAD_R = 14;
  const PAD_T = 12;
  const PAD_B = 20;

  const values = points.map((p) => p.v);
  const rawMax = Math.max(...values, 1);
  // Round the y-axis up to a pleasant boundary; keep small values readable.
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const yMax = Math.max(magnitude, Math.ceil(rawMax / magnitude) * magnitude);

  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const x = (i: number): number =>
    PAD_L + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number): number => PAD_T + innerH - (Math.max(0, v) / yMax) * innerH;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${(PAD_T + innerH).toFixed(1)} L${x(0).toFixed(1)},${(
    PAD_T + innerH
  ).toFixed(1)} Z`;

  const lastIdx = points.length - 1;
  const ticks = [0, yMax / 2, yMax];

  return (
    <div className="chart-wrap" role="img" aria-label={`Live events per second over this session, currently ${values[lastIdx]}`}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="presentation">
        <defs>
          <linearGradient id="live-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--chart-grid)"
              strokeDasharray={t === 0 ? undefined : "3 5"}
            />
            <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
              {formatTick(t)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#live-area-fill)" />
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* hover targets: one transparent hit-area per sample with a native tooltip.
            Capped rendering to the last 40 samples to bound DOM size. */}
        {points.slice(-40).map((p, i, arr) => {
          const idx = points.length - arr.length + i;
          return (
            <circle
              key={p.t}
              cx={x(idx)}
              cy={y(p.v)}
              r="7"
              fill="transparent"
              style={{ cursor: "crosshair" }}
            >
              <title>
                {`${new Date(p.t).toLocaleTimeString("en-GB", { hour12: false })} · ${p.v} ev/s`}
              </title>
            </circle>
          );
        })}

        <circle cx={x(lastIdx)} cy={y(values[lastIdx])} r="4" fill="var(--accent-strong)">
          <title>{`${values[lastIdx]} ev/s (latest)`}</title>
        </circle>

        {/* x-axis: real clock labels sampled across the session window */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac, i, arr) => {
          const idx = Math.min(points.length - 1, Math.round(frac * (points.length - 1)));
          const label = new Date(points[idx].t).toLocaleTimeString("en-GB", { hour12: false });
          const anchor = i === 0 ? "start" : i === arr.length - 1 ? "end" : "middle";
          return (
            <text
              key={frac}
              x={PAD_L + frac * innerW}
              y={H - 6}
              fontSize="10"
              fontFamily="var(--font-mono)"
              fill="var(--text-muted)"
              textAnchor={anchor}
            >
              {label}
            </text>
          );
        })}
        <text x={W - PAD_R} y={H - 6} fontSize="10" fill="var(--accent-strong)" textAnchor="end" style={{ display: "none" }}>
          now
        </text>
      </svg>
    </div>
  );
}

function formatTick(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K` : `${v}`;
}
