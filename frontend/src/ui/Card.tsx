import type { ReactNode } from "react";

/** Standard panel: uppercase section title, optional right-side hint/slot. */
export function Card({
  title,
  id,
  hint,
  actions,
  children,
  ariaLabel,
}: {
  title: string;
  id?: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <section className="panel section-anchor" id={id} aria-label={ariaLabel ?? title}>
      <div className="panel-head">
        <h2>{title}</h2>
        {hint ? <span className="hint">{hint}</span> : null}
        {actions ?? null}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}
