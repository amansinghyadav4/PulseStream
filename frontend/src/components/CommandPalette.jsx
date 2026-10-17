import { useEffect, useMemo, useRef, useState } from "react";



/**
 * ⌘K / Ctrl+K command palette — grouped Navigation / Actions / Soon.
 * "Search events" is a real action: it deep-links into the Event Explorer
 * with the query pre-applied to loaded rows. Future actions are clearly
 * DISABLED placeholders.
 */
export function CommandPalette({
  open,
  onClose,
  navigate,
  onToggleCollapse,
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (label) => !q || label.toLowerCase().includes(q);
    return [
      {
        label: "Navigation",
        items: (
          [
            ["go-overview", "Go to Overview", () => navigate("overview")],
            ["go-analytics", "Go to Live Analytics", () => navigate("analytics")],
            ["go-events", "Go to Events", () => navigate("events")],
            ["go-failures", "Go to Failures", () => navigate("failures")],
            ["go-sources", "Go to Sources", () => navigate("sources")],
            ["go-pipeline", "Go to Pipeline", () => navigate("pipeline")],
            ["go-health", "Go to System Health", () => navigate("health")],
            ["go-simulator", "Go to Traffic Lab", () => navigate("simulator")],
            ["go-api-keys", "Go to API Keys", () => navigate("api-keys")],
            ["go-integrations", "Go to Integrations", () => navigate("integrations")],
            ["go-account", "Go to Account", () => navigate("account")],
          ]
        )
          .map(([id, label, run]) => ({ id, label, run }))
          .filter((c) => match(c.label)),
      },
      {
        label: "Actions",
        items: [
          {
            id: "search-events",
            label: query ? `Search events for “${query.trim()}”` : "Search events",
            hint: query ? "↵" : undefined,
            run: () => navigate("events", query.trim() ? { q: query.trim() } : undefined),
          },
          { id: "refresh-data", label: "Refresh data", hint: "R", run: () => window.dispatchEvent(new Event("ps:refresh")) },
          { id: "toggle-sidebar", label: "Toggle sidebar collapse", hint: "Ctrl B", run: onToggleCollapse },
          {
            id: "open-store",
            label: "Open Demo Store ↗",
            hint: "external",
            run: () => window.open("http://localhost:3001/", "_blank", "noreferrer"),
          },
        ].filter((c) => match(c.label)),
      },
      {
        label: "Soon",
        items: [
          { id: "replay-event", label: "Replay selected event…", disabled: true },
          { id: "ack-failure", label: "Acknowledge failure…", disabled: true },
        ],
      },
    ];
  }, [query, navigate, onToggleCollapse]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  if (!open) return null;

  const runAt = (i) => {
    const cmd = flat[i];
    if (!cmd || cmd.disabled || !cmd.run) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  let renderIndex = -1;

  return (
    <div className="cmdk-overlay" onClick={onClose} role="presentation">
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Type a command or search events…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Command search"
        />
        <div className="cmdk-list" ref={listRef}>
          {flat.length === 0 ? (
            <div className="cmdk-empty">No matching commands</div>
          ) : (
            groups.map((group) =>
              group.items.length === 0 ? null : (
                <div key={group.label}>
                  <div className="nav-group-label">{group.label}</div>
                  {group.items.map((cmd) => {
                    renderIndex += 1;
                    const i = renderIndex;
                    return cmd.disabled ? (
                      <button
                        key={cmd.id}
                        type="button"
                        className="cmdk-item"
                        disabled
                        style={{ opacity: 0.45, cursor: "not-allowed" }}
                      >
                        <span style={{ flex: 1 }}>{cmd.label}</span>
                        <span className="kbd-hint">soon</span>
                      </button>
                    ) : (
                      <button
                        key={cmd.id}
                        type="button"
                        className={`cmdk-item ${i === cursor ? "highlighted" : ""}`}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => runAt(i)}
                      >
                        <span style={{ flex: 1 }}>{cmd.label}</span>
                        {cmd.hint ? <span className="kbd-hint">{cmd.hint}</span> : null}
                      </button>
                    );
                  })}
                </div>
              )
            )
          )}
        </div>
        <div className="cmdk-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
