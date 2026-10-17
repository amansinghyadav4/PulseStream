import { useEffect, useRef, useState } from "react";

const MIN_INTERVAL_MS = 450;

/**
 * Rolling buffer of events/second values OBSERVED during this browser session,
 * fed by real metric updates only. This is explicitly NOT historical data:
 * the backend exposes the current minute-bucket, nothing older. The buffer is
 * capped and used to draw the "observed this session" live chart.
 */
export function useSessionSeries(metrics, maxPoints = 90) {
  const [points, setPoints] = useState([]);
  const lastAtRef = useRef(0);

  useEffect(() => {
    if (!metrics || typeof metrics.events_per_second !== "number") return;
    const now = Date.now();
    if (now - lastAtRef.current < MIN_INTERVAL_MS) return; // dedupe overlapping WS+poll updates
    lastAtRef.current = now;
    setPoints((prev) => {
      const next = [...prev, { t: now, v: metrics.events_per_second }];
      return next.length > maxPoints ? next.slice(-maxPoints) : next;
    });
  }, [metrics, maxPoints]);

  return points;
}
