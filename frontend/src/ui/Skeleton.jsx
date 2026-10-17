/** A single shimmering placeholder block. Width/height in px. */
export function Skeleton({ width, height = 12, style }) {
  return (
    <span
      className="skeleton"
      style={{ display: "block", width, height, ...style }}
      aria-hidden
    />
  );
}

export function SkeletonLines({ rows = 3, lastWidth }) {
  return (
    <div role="status" aria-label="Loading data">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton skeleton-text" style={i === rows - 1 ? { width: lastWidth ?? "60%" } : undefined} />
      ))}
    </div>
  );
}
