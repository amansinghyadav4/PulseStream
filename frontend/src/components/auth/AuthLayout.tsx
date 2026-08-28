import type { ReactNode } from "react";
import { IconPulse } from "../icons";

/**
 * Split-panel SaaS authentication shell: a brand/marketing rail (hidden on
 * mobile) beside the form card. Responsive down to a single column; the form
 * card is centered and width-capped on every breakpoint.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  back,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Optional escape hatch rendered above the card heading (e.g. back to landing). */
  back?: ReactNode;
}) {
  return (
    <div className="auth-shell">
      <aside className="auth-aside" aria-hidden="true">
        <div className="auth-aside-inner">
          <div className="auth-brand">
            <span className="brand-mark">
              <IconPulse size={18} />
            </span>
            <div>
              <div className="auth-brand-name">PulseStream</div>
              <div className="auth-brand-sub">Real-Time Event Analytics</div>
            </div>
          </div>
          <div className="auth-aside-copy">
            <h2>Operational visibility, in real time.</h2>
            <p>
              Ingest, process and visualize your event pipeline — throughput, latency, failures and
              consumer lag — from one multi-tenant workspace.
            </p>
          </div>
          <ul className="auth-aside-points">
            <li>Isolated per-organization metrics</li>
            <li>Live WebSocket dashboard with polling fallback</li>
            <li>Secure, session-based access</li>
          </ul>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-brand">
            <span className="brand-mark">
              <IconPulse size={16} />
            </span>
            <span className="auth-brand-name">PulseStream</span>
          </div>
          {back ?? null}
          <header className="auth-head">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </header>
          {children}
          {footer ? <div className="auth-foot">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
