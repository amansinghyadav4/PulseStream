/**
 * Compact label/value rows.
 *
 * These are the *supporting* numbers: readable, densely stacked, aligned on a
 * shared right edge with tabular figures. Deliberately much smaller than the
 * page's hero metric so importance is communicated by size, not by boxing
 * every value in its own card.
 */
export function StatRows({ children, ariaLabel }) {
  return (
    <div className="stat-rows" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export function StatRow({
  label,
  value,
  unit,
  note,
  tone,
  onClick,
  ariaLabel,
  leading,
}) {
  const clickable = typeof onClick === "function";
  const unavailable = value === null || value === undefined;

  const content = (
    <>
      <span className="stat-row-label">
        {leading}
        {label}
      </span>
      <span className={`stat-row-value ${unavailable ? "na" : ""}`}>
        {unavailable ? (note ? "Unavailable" : "—") : value}
        {!unavailable && unit ? <span className="value-unit">{unit}</span> : null}
      </span>
      {note ? <span className="stat-row-note">{note}</span> : null}
    </>
  );

  if (!clickable) {
    return <div className={`stat-row ${tone ? `tone-${tone}` : ""}`}>{content}</div>;
  }

  return (
    <div
      className={`stat-row is-clickable ${tone ? `tone-${tone}` : ""}`}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel ?? `${label} — open details`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {content}
    </div>
  );
}
