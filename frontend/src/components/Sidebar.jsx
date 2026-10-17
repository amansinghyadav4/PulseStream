import { useEffect, useState } from "react";
import {
  IconActivity,
  IconAlertTriangle,
  IconBolt,
  IconChevronLeft,
  IconChevronRight,
  IconGauge,
  IconHeartbeat,
  IconKey,
  IconLayers,
  IconList,
  IconPulse,
  IconStore,
  IconStream,
  IconTerminal,
} from "./icons";
import { useAuth } from "../context/AuthContext";

/**
 * Navigation, grouped by what the operator is doing — not by technology.
 * Monitoring = is it healthy? · Investigate = what happened? ·
 * Platform = how is it wired? · Developer = how do I connect? · Tools = drive it.
 */
export const GROUPS = [
  {
    label: "Monitoring",
    items: [
      { id: "overview", label: "Overview", Icon: IconGauge },
      { id: "analytics", label: "Analytics", Icon: IconActivity },
    ],
  },
  {
    label: "Investigate",
    items: [
      { id: "events", label: "Events", Icon: IconList },
      { id: "failures", label: "Failures", Icon: IconAlertTriangle, badge: "failed" },
      { id: "sources", label: "Sources", Icon: IconLayers },
    ],
  },
  {
    label: "Platform",
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

function readCollapsed() {
  try {
    return localStorage.getItem("ps-sidebar") === "collapsed";
  } catch {
    return false;
  }
}

/**
 * Compact collapsible navigation rail. Expanded = glyph + label; collapsed =
 * glyph only with tooltips. State persists in localStorage; Ctrl+B toggles it.
 * The Failure count badge is live real data passed down from the metrics
 * snapshot — it is omitted entirely when the counter is unavailable.
 */
export function Sidebar({ route, navigate, failedCount }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { user } = useAuth();

  useEffect(() => {
    const toggle = () => {
      setCollapsed((c) => {
        const next = !c;
        try {
          localStorage.setItem("ps-sidebar", next ? "collapsed" : "expanded");
        } catch {
          /* storage unavailable — the toggle still works for this session */
        }
        return next;
      });
    };
    window.addEventListener(COLLAPSE_EVENT, toggle);
    return () => window.removeEventListener(COLLAPSE_EVENT, toggle);
  }, []);

  const orgName = user?.organization?.name ?? null;
  const orgInitial = orgName ? orgName.charAt(0).toUpperCase() : "•";
  const showBadge = typeof failedCount === "number" && failedCount > 0;

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : "expanded"}`}>
      <div className="sidebar-head">
        <button
          type="button"
          className="brand"
          onClick={() => navigate("landing")}
          aria-label="PulseStream — open the product page"
        >
          <span className="brand-mark">
            <IconPulse size={15} />
          </span>
          <span className="brand-text">
            <span className="brand-name">PulseStream</span>
            <span className="brand-sub">Event platform</span>
          </span>
        </button>

        <button
          type="button"
          className="collapse-btn"
          onClick={() => window.dispatchEvent(new Event(COLLAPSE_EVENT))}
          title="Toggle navigation (Ctrl+B)"
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
        </button>
      </div>

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

      <div className="sidebar-nav">
        {GROUPS.map((group) => (
          <nav key={group.label} aria-label={`${group.label} sections`}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map(({ id, label, Icon, badge }) => (
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
                {badge === "failed" && showBadge ? (
                  <span className="nav-badge" aria-label={`${failedCount} failed events`}>
                    {failedCount > 999 ? "999+" : failedCount}
                  </span>
                ) : null}
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
        ))}
      </div>

      {user ? (
        <div className="sidebar-foot">
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
                <span className="user-sub">Account settings</span>
              </span>
            </button>
          </div>
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
export function MobileNav({ route }) {
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
          aria-current={route === id ? "page" : undefined}
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
