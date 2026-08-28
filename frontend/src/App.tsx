import { useEffect, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAnalyticsMetrics } from "./hooks/useAnalyticsMetrics";
import { useSessionSeries } from "./hooks/useSessionSeries";
import { Sidebar, MobileNav } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { CommandPalette } from "./components/CommandPalette";
import { Overview as KpiOverview } from "./components/KpiCards";
import { Throughput } from "./components/Throughput";
import { EventTypes, EventSources } from "./components/Distributions";
import { Latency } from "./components/Latency";
import { FailureRate } from "./components/FailureRate";
import { PipelineGraph } from "./components/PipelineGraph";
import { ActivityFeed, StatusBar } from "./components/ActivityFeed";
import { EventExplorer } from "./components/EventExplorer";
import { FailuresView } from "./components/FailuresView";
import { SystemHealth } from "./components/SystemHealth";
import { SystemHealthStrip } from "./components/SystemHealthStrip";
import { EventSimulator } from "./components/EventSimulator";
import { ApiKeysPage } from "./components/ApiKeysPage";
import { IntegrationPage } from "./components/IntegrationPage";
import { LandingPage } from "./components/LandingPage";
import { Card } from "./ui/Card";
import { DetailRow } from "./ui/Drawer";
import { useHashRoute } from "./lib/router";
import type { Route } from "./lib/router";
import { isDashboardRoute, AUTH_REDIRECT_ROUTES, navigateTo } from "./lib/router";
import { serviceDetailRows } from "./lib/serviceDetails";
import { useHealth } from "./hooks/useHealth";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./components/auth/LoginPage";
import { SignupPage } from "./components/auth/SignupPage";
import { ForgotPasswordPage } from "./components/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./components/auth/ResetPasswordPage";
import { LogoutPage } from "./components/auth/LogoutPage";
import { AccountPage } from "./components/auth/AccountPage";

const PAGE_META: Partial<Record<Route, { title: string; subtitle: string }>> = {
  overview: { title: "Overview", subtitle: "Real-time system overview and key metrics." },
  analytics: { title: "Live Analytics", subtitle: "Throughput, distributions, latency and failure metrics." },
  events: { title: "Events", subtitle: "Explore ingested events stored in PostgreSQL, newest first." },
  failures: { title: "Failures", subtitle: "Investigate terminal processing failures and their DLQ outcomes." },
  sources: { title: "Sources", subtitle: "Event types and producer sources. Click a value to open it in Events." },
  pipeline: { title: "Pipeline", subtitle: "Live event flow across the platform. Click a node for details." },
  health: { title: "System Health", subtitle: "Reported status of every dependency. Click a service for details." },
  simulator: { title: "Traffic Generator", subtitle: "Drive real traffic through the public ingestion API." },
  "api-keys": { title: "API Keys", subtitle: "Create and manage the ingest keys that route events to this workspace." },
  integrations: { title: "Integrations", subtitle: "Connect your application to PulseStream — endpoint, schema and examples." },
  account: { title: "Account", subtitle: "Your profile, workspace and session." },
  landing: { title: "PulseStream", subtitle: "Real-time visibility into your event pipeline." },
};

/**
 * Root: provides auth state, then routes. Auth (login/signup/…) and the public
 * landing page render outside the dashboard shell; every dashboard route is
 * gated behind an authenticated session.
 */
export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

function AuthSplash() {
  return (
    <div className="auth-splash" role="status" aria-live="polite">
      <span className="auth-spinner lg" aria-hidden="true" />
      <p>Loading your workspace…</p>
    </div>
  );
}

function AppRoutes() {
  const { status } = useAuth();
  const { location, navigate } = useHashRoute();
  const route = location.route;

  // Redirect side effects (never during render): unauthenticated users off
  // protected routes; authenticated users off the credential-entry pages.
  useEffect(() => {
    if (status === "loading") return;
    if (status === "unauthenticated" && isDashboardRoute(route)) {
      navigateTo("login");
    } else if (status === "authenticated" && AUTH_REDIRECT_ROUTES.includes(route)) {
      navigateTo("overview");
    }
  }, [status, route]);

  // Landing is always public.
  if (route === "landing") {
    return <LandingWithMetrics navigate={navigate} />;
  }

  // Logout is an action route; it manages its own redirect.
  if (route === "logout") return <LogoutPage />;

  // Public auth routes.
  if (route === "login" || route === "signup" || route === "forgot-password" || route === "reset-password") {
    // While authenticated, the effect above bounces to the dashboard; render a
    // splash rather than briefly flashing the form.
    if (status === "authenticated") return <AuthSplash />;
    if (route === "login") return <LoginPage />;
    if (route === "signup") return <SignupPage />;
    if (route === "forgot-password") return <ForgotPasswordPage />;
    return <ResetPasswordPage location={location} />;
  }

  // Dashboard (protected) routes.
  if (status === "loading") return <AuthSplash />;
  if (status !== "authenticated") return <AuthSplash />; // effect redirects to /login
  return <Dashboard />;
}

function LandingWithMetrics({ navigate }: { navigate: (r: Route, params?: Record<string, string>) => void }) {
  // Landing shows public/Demo metrics via the polling fallback (no WS auth needed).
  const metrics = useAnalyticsMetrics(null, false);
  return <LandingPage metrics={metrics} navigate={navigate} />;
}

function Dashboard() {
  const { user } = useAuth();
  const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/v1/ws`;
  // WS only connects for an authenticated session (the shell only mounts then);
  // the backend authorizes the handshake from the session cookie.
  const { metrics: wsMetrics, connected } = useWebSocket(wsUrl, user !== null);
  const metrics = useAnalyticsMetrics(wsMetrics, connected);
  const series = useSessionSeries(metrics);
  const { location: loc, navigate } = useHashRoute();
  const route = loc.route;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pipeNode, setPipeNode] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  useEffect(() => {
    if (metrics) setLastUpdate(new Date().toLocaleTimeString("en-GB", { hour12: false }));
  }, [metrics]);
  const healthSnap = useHealth();
  const meta = PAGE_META[route] ?? { title: "PulseStream", subtitle: "" };

  // ⌘K / Ctrl+K command menu · Ctrl+B sidebar collapse
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        window.dispatchEvent(new Event("ps:toggle-collapse"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Landing / auth routes are handled by AppRoutes above; Dashboard only ever
  // renders a protected dashboard route.

  return (
    <div className="app">
      <Sidebar route={route} navigate={navigate} />

      <div className="main">
        <TopBar
          route={route}
          crumbExtra={
            route === "events" && loc.params.get("type")
              ? String(loc.params.get("type"))
              : undefined
          }
          wsConnected={connected}
          metricsLoaded={metrics !== null}
          updatedAt={lastUpdate}
          onOpenPalette={() => setPaletteOpen(true)}
          onSearch={(q) => navigate("events", q.trim() ? { q: q.trim() } : undefined)}
        />

        <div className="content">
          <MobileNav route={route} />

          <header className="page-header">
            <div>
              <div className="hero-title">
                <h1>{meta.title}</h1>
              </div>
              <p className="hero-tagline">{meta.subtitle}</p>
            </div>
          </header>

          <div className="stack">
            {route === "overview" ? (
              <div className="ov-grid">
                <div className="ov-main">
                  <Card
                    title="Key metrics"
                    hint={connected ? "live via WebSocket — click a metric to drill in" : "REST polling fallback"}
                  >
                    <KpiOverview
                      metrics={metrics}
                      exclude={["lag"]}
                      onMetric={(key) => {
                        if (key === "failed") navigate("failures");
                        else if (key === "lag" || key === "producers") navigate("pipeline");
                        else if (key === "eventsPerSecond" || key === "eventsPerMinute") navigate("analytics");
                        else if (key === "latency") navigate("analytics");
                        else if (key === "total") navigate("events");
                        else if (key === "processed") navigate("analytics");
                      }}
                    />
                  </Card>

                  <Throughput metrics={metrics} series={series} />

                  <div className="ov-trio">
                    <EventTypes metrics={metrics} onDrill={(t) => navigate("events", { type: t })} />
                    <EventSources metrics={metrics} onDrill={(s) => navigate("events", { source: s })} />
                    <div className="stack" style={{ gap: 12 }}>
                      <Latency metrics={metrics} />
                      <FailureRate metrics={metrics} />
                      <Card title="Consumer lag" hint="sum across groups · ~10s">
                        <div className="big-number" style={{ fontSize: 24 }}>
                          {metrics?.consumer_lag != null ? (
                            metrics.consumer_lag.toLocaleString("en-US")
                          ) : (
                            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Unavailable</span>
                          )}
                        </div>
                        <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-muted)" }}>
                          {metrics?.consumer_lag === 0
                            ? "No backlog · all caught up"
                            : metrics?.consumer_lag != null
                              ? "Backlog draining"
                              : "Workers not reporting yet"}
                        </p>
                      </Card>
                    </div>
                  </div>

                  <ActivityFeed />

                  <Card
                    title="System health"
                    hint="click a service to inspect it in the side panel"
                    actions={
                      <button type="button" className="btn" onClick={() => navigate("health")}>
                        Open health →
                      </button>
                    }
                  >
                    <SystemHealthStrip
                      wsConnected={connected}
                      eventsPerSecond={metrics?.events_per_second ?? 0}
                      selected={pipeNode}
                      onSelect={setPipeNode}
                    />
                  </Card>
                </div>

                <div className="ov-rail">
                  <Card title="Consumer lag" hint="across groups">
                    <div className="big-number" style={{ fontSize: 34 }}>
                      {metrics?.consumer_lag != null ? (
                        metrics.consumer_lag.toLocaleString("en-US")
                      ) : (
                        <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>Unavailable</span>
                      )}
                    </div>
                    <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--text-muted)" }}>
                      {metrics?.consumer_lag === 0
                        ? "No backlog · all caught up"
                        : metrics?.consumer_lag != null
                          ? "Backlog draining · workers catching up"
                          : "Workers not reporting yet"}
                    </p>
                    <p className="metric-definition" style={{ marginTop: 10 }}>
                      Sum across worker groups · refreshed ~10s via worker heartbeats.
                    </p>
                  </Card>

                  {pipeNode ? (
                    <Card
                      title={pipeNode}
                      hint="reported by /api/v1/ready"
                      actions={
                        <button type="button" className="btn" onClick={() => setPipeNode(null)} aria-label="Close inspector">
                          ✕
                        </button>
                      }
                    >
                      <InspectorRows service={pipeNode} wsConnected={connected} />
                    </Card>
                  ) : null}
                </div>
              </div>
            ) : null}

            {route === "analytics" ? (
              <>
                <Card
                  title="Key metrics"
                  hint={connected ? "live via WebSocket — click a metric to drill in" : "REST polling fallback"}
                >
                  <KpiOverview
                    metrics={metrics}
                    onMetric={(key) => {
                      if (key === "failed") navigate("failures");
                      else if (key === "lag" || key === "producers") navigate("pipeline");
                      else navigate("analytics");
                    }}
                  />
                </Card>

                <Throughput metrics={metrics} series={series} />
                <div className="grid-2col">
                  <EventTypes metrics={metrics} onDrill={(t) => navigate("events", { type: t })} />
                  <EventSources metrics={metrics} onDrill={(s) => navigate("events", { source: s })} />
                </div>
                <div className="grid-2col">
                  <Latency metrics={metrics} />
                  <FailureRate metrics={metrics} />
                </div>
                <Card title="Consumer lag" hint="sum across worker groups · refreshed ~10s via worker heartbeats">
                  <div className="big-number">
                    {metrics?.consumer_lag != null ? (
                      metrics.consumer_lag.toLocaleString("en-US")
                    ) : (
                      <span style={{ fontSize: 15, color: "var(--text-secondary)" }}>Unavailable</span>
                    )}
                    {metrics?.consumer_lag != null ? <span className="value-unit">events behind</span> : null}
                  </div>
                  <p className="metric-definition">
                    Broker highwatermark − consumer position per assigned partition, self-reported by each worker
                    through Redis heartbeats every ~10s.
                  </p>
                </Card>
              </>
            ) : null}

            {route === "events" ? (
              <EventExplorer
                key={`${loc.params.get("type") ?? ""}-${loc.params.get("source") ?? ""}-${loc.params.get("q") ?? ""}`}
                initialQuery={loc.params.get("q") ?? ""}
                initialType={loc.params.get("type") ?? ""}
                initialSource={loc.params.get("source") ?? ""}
              />
            ) : null}

            {route === "failures" ? <FailuresView metrics={metrics} /> : null}

            {route === "account" ? <AccountPage /> : null}

            {route === "api-keys" ? <ApiKeysPage /> : null}

            {route === "integrations" ? <IntegrationPage /> : null}

            {route === "sources" ? (
              <>
                <div className="grid-2col">
                  <EventTypes metrics={metrics} onDrill={(t) => navigate("events", { type: t })} />
                  <EventSources metrics={metrics} onDrill={(s) => navigate("events", { source: s })} />
                </div>
                <p className="metric-definition">
                  Clicking a type or source opens the Event Explorer pre-filtered to those events (filters apply to
                  loaded rows).
                </p>
              </>
            ) : null}

            {route === "pipeline" ? (
              <>
                <Card title="Event flow" hint={`live throughput ${metrics?.events_per_second ?? 0} ev/s · click a node`}>
                  <PipelineGraph wsConnected={connected} active={(metrics?.events_per_second ?? 0) > 0} eventsPerSecond={metrics?.events_per_second ?? 0} />
                </Card>
                <SystemHealth wsConnected={connected} />
              </>
            ) : null}

            {route === "health" ? <SystemHealth wsConnected={connected} /> : null}

            {route === "simulator" ? (
              <>
                <EventSimulator />
                <Card title="Demo environment" hint="external client application">
                  <div className="launch-card">
                    <div>
                      <h3>Demo Store</h3>
                      <p>
                        A simulated customer application whose checkout funnel generates real business events through
                        PulseStream's public API — open it alongside this dashboard to watch events flow end-to-end.
                      </p>
                    </div>
                    <a className="btn accent" href="http://localhost:3001/" target="_blank" rel="noreferrer">
                      Open Demo Store ↗
                    </a>
                  </div>
                </Card>
              </>
            ) : null}
          </div>

          <StatusBar wsConnected={connected} apiUp={healthSnap.apiReachable} updatedAt={lastUpdate} />
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        navigate={navigate}
        onToggleCollapse={() => window.dispatchEvent(new Event("ps:toggle-collapse"))}
      />
    </div>
  );
}
/** Compact inspector rows for a selected pipeline node (right rail). */
function InspectorRows({ service, wsConnected }: { service: string; wsConnected: boolean }) {
  const snap = useHealth();
  return (
    <>
      {serviceDetailRows(service, snap, wsConnected).map((row) => (
        <DetailRow key={row.label} label={row.label}>
          {row.value || "Not available"}
        </DetailRow>
      ))}
    </>
  );
}
