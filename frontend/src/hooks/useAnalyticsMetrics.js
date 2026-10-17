import { useEffect, useState } from "react";

/**
 * Resolves the authoritative metrics snapshot:
 * - WebSocket is primary once it has delivered a message;
 * - REST polling (/api/v1/analytics, 1s) runs whenever the WS has NOT delivered
 *   yet OR the connection is down. Polling resumes automatically on disconnect
 *   so a stale last-known snapshot is never shown as live.
 */
export function useAnalyticsMetrics(wsMetrics, connected) {
  const [restMetrics, setRestMetrics] = useState(null);
  const wsLive = connected && wsMetrics !== null;

  useEffect(() => {
    if (wsLive) return; // WebSocket is authoritative right now

    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/v1/analytics");
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && data && typeof data === "object" && "total" in data) {
          setRestMetrics(data);
        }
      } catch {
        // unreachable backend: keep last known value; header shows offline state
      }
    };

    poll();
    const id = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [wsLive]);

  return wsLive ? wsMetrics : restMetrics;
}
