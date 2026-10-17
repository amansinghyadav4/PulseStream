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
import { RecentFailures } from "./components/RecentFailures";
import { PipelineStrip } from "./components/PipelineStrip";
import { PageHeader, PAGE_GROUP } from "./components/PageHeader";
import { EventExplorer } from "./components/EventExplorer";
import { FailuresView } from "./components/FailuresView";
import { SystemHealth } from "./components/SystemHealth";
import { SystemVerdict } from "./components/SystemVerdict";
import { EventSimulator } from "./components/EventSimulator";
import { ApiKeysPage } from "./components/ApiKeysPage";
import { IntegrationPage } from "./components/IntegrationPage";
import { LandingPage } from "./components/LandingPage";
import { Card } from "./ui/Card";
import { DetailRow } from "./ui/Drawer";
import { useHashRoute } from "./lib/router";
import { isDashboardRoute, AUTH_REDIRECT_ROUTES, navigateTo } from "./lib/router";
import { serviceDetailRows } from "./lib/serviceDetails";
import { formatCount } from "./lib/format";
import { useHealth } from "./hooks/useHealth";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./components/auth/LoginPage";
import { SignupPage } from "./components/auth/SignupPage";
import { ForgotPasswordPage } from "./components/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./components/auth/ResetPasswordPage";
import { LogoutPage } from "./components/auth/LogoutPage";
import { AccountPage } from "./components/auth/AccountPage";

const PAGE_META = {
  overview: {
    title: "Overview",
    subtitle:
      "The verdict first, then the numbers behind it — ingest, the event path, composition and the newest records.",
  },
  analytics: {
    title: "Live Analytics",
    subtitle: "Throughput, types, sources, latency and failure rate — the full reported metric set.",
  },
  events: {
    title: "Events",
    subtitle: "Search every event stored in PostgreSQL. Open a row for its full payload and timeline.",
  },
  failures: {
    title: "Failures",
    subtitle: "Terminal processing failures and their dead-letter outcomes.",
  },
  sources: {
    title: "Sources",
    subtitle: "Which event types and producers are flowing, by share. Click a value to open it in Events.",
  },
  pipeline: {
    title: "Pipeline",
    subtitle: "Every stage of the event path with its live reading. Click a stage for reported detail.",
  },
  health: {
    title: "System Health",
    subtitle: "Raw dependency status from /api/v1/ready, refreshed every five seconds. Click a service for detail.",
  },
  simulator: {
    title: "Traffic Generator",
    subtitle: "Generate real traffic through the public ingestion API to exercise the whole pipeline.",
  },
  "api-keys": {
    title: "API Keys",
    subtitle: "Create and revoke the ingest keys that route events into this workspace.",
  },
  integrations: {
    title: "Integrations",
    subtitle: "Endpoint, authentication and payload schema for sending events from your application.",
  },
  account: { title: "Account", subtitle: "Your profile, workspace membership and current session." },
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

function LandingWithMetrics({ navigate }) {
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
  const [pipeNode, setPipeNode] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  useEffect(() => {
    if (metrics) setLastUpdate(new Date().toLocaleTimeString("en-GB", { hour12: false }));
  }, [metrics]);
  const healthSnap = useHealth();
  const meta = PAGE_META[route] ?? { title: "PulseStream", subtitle: "" };

  // ⌘K / Ctrl+K command menu · Ctrl+B sidebar collapse
  useEffect(() => {
    const onKey = (e) => {
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
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <Sidebar
        route={route}
        navigate={navigate}
        failedCount={typeof metrics?.events_failed_total === "number" ? metrics.events_failed_total : undefined}
      />

      <div className="main">
        <TopBar
          route={route}
          pageTitle={meta.title}
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

        <main className="content" id="main-content" tabIndex={-1}>
          <MobileNav route={route} />

          <PageHeader
            title={meta.title}
            description={meta.subtitle}
            group={PAGE_GROUP[route]}
            actions={
              route === "overview" ? (
                <>
                  <button type="button" className="btn" onClick={() => navigate("events")}>
                    Search events
                  </button>
                  <button type="button" className="btn accent" onClick={() => navigate("simulator")}>
                    Generate traffic
                  </button>
                </>
              ) : null
            }
          />

          <div className="stack">
            {route === "overview" ? (
              <div className="ov">
                <SystemVerdict
                  wsConnected={connected}
                  metrics={metrics}
                  selected={pipeNode}
                  onSelect={setPipeNode}
                  onOpenHealth={() => navigate("health")}
                  onOpenPipeline={() => navigate("pipeline")}
                />

                <div className="ov-hero">
                  <div className="ov-hero-main">
                    <Throughput metrics={metrics} series={series} wsConnected={connected} />
                  </div>

                  <aside className="ov-side" aria-label="Processing metrics">
                    <Card
                      title="Processing"
                      variant="plane"
                      hint={connected ? "live via WebSocket · click a metric to open its page" : "REST polling fallback"}
                    >
                      <KpiOverview
                        metrics={metrics}
                        exclude={["eventsPerSecond", "eventsPerMinute", "total"]}
                        onMetric={(key) => {
                          if (key === "failed") navigate("failures");
                          else if (key === "lag" || key === "producers") navigate("pipeline");
                          else navigate("analytics");
                        }}
                      />
                    </Card>

                    {pipeNode ? (
                      <Card
                        title={pipeNode}
                        variant="plane"
                        hint="reported by /api/v1/ready"
                        actions={
                          <button
                            type="button"
                            className="btn ghost icon sm"
                            onClick={() => setPipeNode(null)}
                            aria-label="Close inspector"
                          >
                            ✕
                          </button>
                        }
                      >
                        <InspectorRows service={pipeNode} wsConnected={connected} />
                      </Card>
                    ) : null}
                  </aside>
                </div>

                <PipelineStrip
                  wsConnected={connected}
                  metrics={metrics}
                  onOpen={() => navigate("pipeline")}
                />

                <div className="ov-split">
                  <EventTypes metrics={metrics} onDrill={(t) => navigate("events", { type: t })} />
                  <EventSources metrics={metrics} onDrill={(s) => navigate("events", { source: s })} />
                </div>

                <div className="ov-activity">
                  <ActivityFeed />
                  <RecentFailures />
                </div>
              </div>
            ) : null}

            {route === "analytics" ? (
              <>
                <div className="ov-hero">
                  <div className="ov-hero-main">
                    <Throughput metrics={metrics} series={series} wsConnected={connected} />
                    <div className="grid-2col">
                      <Latency metrics={metrics} />
                      <FailureRate metrics={metrics} />
                    </div>
                  </div>

                  <aside className="ov-side" aria-label="Supporting metrics">
                    <Card
                      title="Key metrics"
                      variant="plane"
                      hint={connected ? "live via WebSocket · click a metric to open its page" : "REST polling fallback"}
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

                    <Card
                      title="Consumer lag"
                      variant="plane"
                      hint="broker highwatermark − consumer position per assigned partition"
                    >
                      <div className="big-number">
                        {metrics?.consumer_lag != null ? (
                          formatCount(metrics.consumer_lag)
                        ) : (
                          <span className="stat-row-value na">Unavailable</span>
                        )}
                        {metrics?.consumer_lag != null ? <span className="value-unit">events behind</span> : null}
                      </div>
                      <p className="metric-definition">
                        Self-reported by each worker through Redis heartbeats every ~10s. Summed across all assigned
                        partitions; when the workers have not reported, no value is shown rather than a zero.
                      </p>
                    </Card>
                  </aside>
                </div>

                <div className="ov-split">
                  <EventTypes metrics={metrics} onDrill={(t) => navigate("events", { type: t })} />
                  <EventSources metrics={metrics} onDrill={(s) => navigate("events", { source: s })} />
                </div>
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
        </main>
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
function InspectorRows({ service, wsConnected }) {
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
