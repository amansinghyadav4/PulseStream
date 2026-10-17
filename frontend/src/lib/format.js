/** Compact number formatting: 1234 -> "1,234", 12000 -> "12.0K" */
export function formatCount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 100_000) {
    const units = ["", "K", "M", "B"];
    let v = n;
    let u = 0;
    while (Math.abs(v) >= 1000 && u < units.length - 1) {
      v /= 1000;
      u += 1;
    }
    return `${v.toFixed(1)}${units[u]}`;
  }
  return n.toLocaleString("en-US");
}

/** Percentage of part/whole, or null when it cannot be truthfully computed. */
export function percentOf(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export function formatPercent(pct) {
  return pct === null ? "—" : `${pct}%`;
}

/** Clock time HH:MM:SS in the viewer's timezone. */
export function formatClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

/** HH:MM:SS.mmm when the ISO string carries milliseconds, else HH:MM:SS. */
export function formatClockMs(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const base = d.toLocaleTimeString("en-GB", { hour12: false });
  const m = /\.(\d{1,6})/.exec(iso);
  return m ? `${base}.${m[1].slice(0, 3).padEnd(3, "0")}` : base;
}

/** Date portion YYYY-MM-DD for tooltips/titles. */
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function shortId(id) {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Honest relative time ("2 min ago") from an ISO timestamp; null if unparseable. */
export function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffMs = Date.now() - t;
  const s = Math.round(diffMs / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
