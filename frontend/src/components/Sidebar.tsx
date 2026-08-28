import { useEffect, useState } from "react";
import {
  IconActivity,
  IconAlertTriangle,
  IconBolt,
  IconGauge,
  IconHeartbeat,
  IconKey,
  IconList,
  IconPulse,
  IconStore,
  IconStream,
  IconTerminal,
} from "./icons";
import type { Route } from "../lib/router";
import { useAuth } from "../context/AuthContext";

type NavItemDef = {
  id: Route;
  label: string;
  Icon: typeof IconGauge;
};

const GROUPS: Array<{ label: string; items: NavItemDef[] }> = [
  {
    label: "Monitoring",
    items: [
      { id: "overview", label: "Overview", Icon: IconGauge },
      { id: "analytics", label: "Analytics", Icon: IconActivity },
    ],
  },
  {
    label: "Explore",
    items: [
      { id: "events", label: "Events", Icon: IconList },
      { id: "failures", label: "Failures", Icon: IconAlertTriangle },
      { id: "sources", label: "Sources", Icon: IconActivity },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { id: "pipeline", label: "Pipeline", Icon: IconStream },
      { id: "health", label: "Health", Icon: IconHeartbeat },
    ],
  },
  {
    label: "Developer",
    items: [
      { id: "api-keys", label: "API Keys", Icon: IconKey },
      { id: "integrations", label: "Integrations", Icon: IconTerminal },
    ],
  },
  {
    label: "Tools",
    items: [{ id: "simulator", label: "Simulator", Icon: IconBolt }],
  },
];

export const COLLAPSE_EVENT = "ps:toggle-collapse";

/**
 * Compact collapsible sidebar. Expanded = icon + label; collapsed = icon-only
 * with tooltips. State persists in localStorage; Ctrl+B toggles it.
 */
export function Sidebar({ route, navigate }: { route: Route; navigate: (r: Route) => void }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ps-sidebar") === "collapsed");
  const { user } = useAuth();

  useEffect(() => {
    const toggle = () => {
      setCollapsed((c) => {
        const next = !c;
        localStorage.setItem("ps-sidebar", next ? "collapsed" : "expanded");
        return next;
      });
    };
    window.addEventListener(COLLAPSE_EVENT, toggle);
    return () => window.removeEventListener(COLLAPSE_EVENT, toggle);
  }, []);

  const orgName = user?.organization?.name ?? null;
  const orgInitial = orgName ? orgName.charAt(0).toUpperCase() : "•";

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : "expanded"}`}>
      <button type="button" className="brand" onClick={() => navigate("landing")} aria-label="PulseStream — go to landing page">
        <span className="brand-mark">
          <IconPulse size={16} />
        </span>
        <span className="brand-text">
          <div className="brand-name">PulseStream</div>
          <div className="brand-sub">Event Analytics</div>
        </span>
      </button>

      {orgName ? (
        <div className="workspace-chip" data-tip={orgName} title={orgName}>
          <span className="workspace-avatar" aria-hidden="true">
            {orgInitial}
          </span>
          <span className="workspace-meta">
            <span className="workspace-label">Workspace</span>
            <span className="workspace-name">{orgName}</span>
          </span>
        </div>
      ) : null}

      {GROUPS.map((group) => (
        <div key={group.label}>
          <div className="nav-group-label">{group.label}</div>
          <nav className="nav" aria-label={`${group.label} sections`}>
            {group.items.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={`nav-item ${route === id ? "active" : ""}`}
                data-tip={label}
                onClick={() => navigate(id)}
                aria-current={route === id ? "page" : undefined}
              >
                <Icon size={15} />
                <span className="nav-label">{label}</span>
              </button>
            ))}
            {group.label === "Tools" ? (
              <a
                className="nav-item"
                href="http://localhost:3001/"
                target="_blank"
                rel="noreferrer"
                data-tip="Demo Store ↗"
              >
                <IconStore size={15} />
                <span className="nav-label">Demo Store ↗</span>
              </a>
            ) : null}
          </nav>
        </div>
      ))}

      <button
        type="button"
        className="collapse-btn"
        onClick={() => window.dispatchEvent(new Event(COLLAPSE_EVENT))}
        title="Toggle sidebar (Ctrl+B)"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? "»" : "« Collapse"}
      </button>

      {!collapsed ? (
        <div className="sidebar-footer">
          {user ? (
            <div className="sidebar-user">
              <button
                type="button"
                className={`user-chip ${route === "account" ? "active" : ""}`}
                onClick={() => navigate("account")}
                aria-current={route === "account" ? "page" : undefined}
                title="Account settings"
              >
                <span className="user-avatar" aria-hidden="true">
                  {(user.full_name || user.email).charAt(0).toUpperCase()}
                </span>
                <span className="user-meta">
                  <span className="user-name">{user.full_name || user.email}</span>
                  <span className="user-sub">View account</span>
                </span>
              </button>
              <button
                type="button"
                className="signout-btn"
                onClick={() => navigate("logout")}
                aria-label="Sign out"
                title="Sign out"
              >
                Sign out
              </button>
            </div>
          ) : null}
          <div className="sidebar-version">
            <span>version</span>
            <span>v0.1.0</span>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/** Mobile horizontal nav (shown below 900px). */
export function MobileNav({ route }: { route: Route }) {
  const items = GROUPS.flatMap((g) => g.items);
  return (
    <nav className="mobile-nav" aria-label="Sections">
      {items.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className={`nav-item ${route === id ? "active" : ""}`}
          onClick={() => {
            window.location.hash = `/${id}`;
            window.scrollTo({ top: 0 });
          }}
        >
          <Icon size={13} />
          <span className="nav-label">{label}</span>
        </button>
      ))}
      <a className="nav-item" href="http://localhost:3001/" target="_blank" rel="noreferrer">
        <IconStore size={13} />
        <span className="nav-label">Store ↗</span>
      </a>
    </nav>
  );
}
