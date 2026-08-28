import { useEffect, useRef, useState } from "react";
import type { Metrics } from "../types/metrics";

export function useWebSocket(url: string, enabled: boolean = true) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(1);

  useEffect(() => {
    if (!enabled) {
      // Not authenticated (or WS disabled): ensure any socket is torn down and
      // the app falls back to REST polling.
      setConnected(false);
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }
    let cancelled = false;
    let timeout: number | undefined;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryRef.current = 1;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          // Only handle metrics type, ignore payload
          if (msg.type === "metrics" && msg.data) {
            setMetrics(msg.data as Metrics);
          }
        } catch {
          // ignore malformed
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        const backoff = Math.min(1000 * Math.pow(2, retryRef.current - 1), 4000);
        retryRef.current += 1;
        timeout = window.setTimeout(connect, backoff);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
      wsRef.current?.close();
    };
  }, [url, enabled]);

  return { metrics, connected };
}
