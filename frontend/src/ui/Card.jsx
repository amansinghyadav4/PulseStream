/**
 * Section framing.
 *
 * Default (`variant="open"`) renders a heading row with a hairline rule and
 * content sitting directly on the page ground — the house default, so the
 * interface reads as one surface rather than a wall of boxes.
 *
 * `variant="plane"` adds a subtle raised surface, reserved for tools and
 * support columns where a genuine container helps.
 */
export function Card({
  title,
  id,
  hint,
  actions,
  children,
  ariaLabel,
  variant = "open",
  className = "",
}) {
  const classes = ["panel", variant === "plane" ? "plane" : "", "section-anchor", className]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classes} id={id} aria-label={ariaLabel ?? title}>
      {title || hint || actions ? (
        <div className="panel-head">
          {title ? <h2>{title}</h2> : null}
          {hint || actions ? (
            <div className="panel-head-aside">
              {hint ? <span className="hint">{hint}</span> : null}
              {actions ?? null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="panel-body">{children}</div>
    </section>
  );
}
