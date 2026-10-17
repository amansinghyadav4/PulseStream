import { useReveal } from "./motion";
import { formatCount } from "../../lib/format";

/**
 * In-page section ids. The app uses a HASH router, so landing anchors are
 * scrolled to imperatively — never through `href="#..."`, which would rewrite
 * window.location.hash and be parsed as a route change.
 */
export const SECTION = {
  product: "ls-product",
  features: "ls-features",
  how: "ls-how",
  developer: "ls-developer",
  final: "ls-final",
};

/** Live value, or an honest em dash when the platform is not reporting it.
 *  Nothing on this page is a fabricated or illustrative number. */
export function metricText(v) {
  return v == null ? "—" : formatCount(v);
}

/** part / (part + other) as a percentage — "—" unless both halves are known. */
export function ratePct(part, other) {
  if (part == null || other == null) return "—";
  const whole = part + other;
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

/** Scroll to an in-page section without touching location.hash (hash router). */
export function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el || typeof el.scrollIntoView !== "function") return;
  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

/**
 * Reveals its children once they scroll into view. Where IntersectionObserver
 * is unavailable (jsdom, older browsers) the content renders visible
 * immediately — the animation is decoration, never a gate on the content.
 */
export function Reveal({ as: Tag = "div", id, className = "", children }) {
  const [ref, inView] = useReveal();
  return (
    <Tag
      id={id}
      ref={ref}
      className={`ls-reveal ${className}${inView ? " is-in" : ""}`}
    >
      {children}
    </Tag>
  );
}
