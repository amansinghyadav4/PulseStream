export function Skeleton({ w }: { w?: string }) {
  return <span className="skeleton" style={{ display: "inline-block", width: w ?? "100%" }} aria-hidden />;
}

export function SkeletonLines({ rows = 3, lastWidth }: { rows?: number; lastWidth?: string }) {
  return (
    <div role="status" aria-label="Loading data">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton skeleton-text" style={i === rows - 1 ? { width: lastWidth ?? "60%" } : undefined} />
      ))}
    </div>
  );
}
