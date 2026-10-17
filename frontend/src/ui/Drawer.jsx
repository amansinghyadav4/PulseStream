import { useEffect, useRef } from "react";

/** Right-side detail drawer with overlay, ESC-to-close, focus trap, and scroll locking. */
export function Drawer({
  title,
  onClose,
  children,
  subtitle,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    // Remember what had focus so we can restore it when the drawer closes.
    const prevFocus = document.activeElement;

    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );

    const onKey = (e) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Trap Tab focus inside the modal drawer.
      if (e.key === "Tab") {
        const items = focusables();
        if (items.length === 0) {
          e.preventDefault();
          panelRef.current?.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const activeInPanel = panelRef.current?.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !activeInPanel)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !activeInPanel)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    // Move focus into the drawer on open (first focusable, else the panel).
    (focusables()[0] ?? panelRef.current)?.focus();

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prevFocus?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="drawer-overlay" onClick={onClose} role="presentation">
      <aside
        ref={panelRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Details panel"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <div className="drawer-subtitle">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Key/value row used inside drawers; value may be a node for honest N/A states. */
export function DetailRow({ label, children }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{children}</span>
    </div>
  );
}
