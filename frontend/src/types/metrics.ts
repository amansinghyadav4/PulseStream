export interface Metrics {
  total: number;
  events_processed_total?: number;
  events_failed_total?: number;
  events_by_type: Record<string, number>;
  events_by_source: Record<string, number>;
  events_per_minute: number;
  events_per_second: number;
  processing_latency_avg_ms: number | null;
  active_producers: number;
  consumer_lag: number | null;
}

export interface RecentEvent {
  id: number;
  event_id: string;
  event_type: string;
  source: string;
  timestamp: string;
  user_id: string | null;
  request_id: string | null;
  payload: Record<string, unknown>;
  schema_version: number;
  created_at: string;
}

/* ---- /health ---- */
export interface HealthResponse {
  status?: string;
}

/* ---- /ready (dependencies mirror backend routes_health.py) ---- */
export type DependencyStatus =
  | "healthy"
  | "unhealthy"
  | "degraded"
  | "unavailable"
  | "disabled"
  | "stopped"
  | "running"
  | (string & {});

export interface WorkerHeartbeat {
  status?: DependencyStatus;
  heartbeat_ttl_s?: number;
  detail?: string;
  /** Phase 7: per-partition consumer lag carried in the heartbeat payload */
  lag?: Record<string, number>;
  group?: string;
}

export interface ReadyDependencies {
  postgres?: { status?: DependencyStatus; latency_ms?: number; error?: string };
  redis?: { status?: DependencyStatus; detail?: string };
  kafka?: { status?: DependencyStatus; detail?: string };
  workers?: {
    persistence_worker?: WorkerHeartbeat;
    analytics_worker?: WorkerHeartbeat;
    note?: string;
  };
  broadcaster?: { status?: DependencyStatus; websocket_clients?: number };
}

export interface ReadyResponse {
  status?: "ready" | "degraded" | "not_ready" | (string & {});
  dependencies?: ReadyDependencies;
}

/** One observed real-time sample (client-side session window — no fabricated history). */
export interface SessionPoint {
  t: number;
  v: number;
}
