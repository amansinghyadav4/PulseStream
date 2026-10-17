import { useEffect, useRef, useState } from "react";

/**
 * Landing-page motion primitives. No animation library — everything here is
 * CSS transitions/keyframes driven by small, cheap hooks:
 *
 *   - useReveal     IntersectionObserver → adds a class once, one-shot
 *   - useCountUp    rAF number animation, triggered on reveal
 *   - useScrolled   boolean for the navbar's scrolled state
 *   - usePrefersReducedMotion
 *
 * Shared rules (matching the platform's honesty/no-noise discipline):
 *   - animation is decoration: when IO/rAF/matchMedia are missing (jsdom,
 *     older browsers) every hook degrades to "final state immediately"
 *   - prefers-reduced-motion always collapses to the final state
 *   - only transform/opacity are ever animated — no layout thrash
 *   - listeners are passive and always cleaned up
 */

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}

const ioAvailable = () =>
  typeof window !== "undefined" && typeof window.IntersectionObserver === "function";

/**
 * One-shot in-view reveal. Returns a ref for the element and a boolean that
 * flips true the first time the element enters the viewport. The consumer
 * maps the boolean to a CSS class; the CSS owns timing and easing.
 */
export function useReveal({ threshold = 0.15, rootMargin = "0px 0px -8% 0px" } = {}) {
  const ref = useRef(null);
  const [inView, setInView] = useState(() => !ioAvailable());

  useEffect(() => {
    const el = ref.current;
    if (!el || !ioAvailable()) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold, rootMargin]);

  return [ref, inView];
}

/** rAF count-up used by KPI numbers. Resolves immediately (final value) when
 *  motion is reduced or duration is 0, so the number is never gated on JS. */
export function animateValue(from, to, durationMs, onUpdate) {
  if (durationMs <= 0 || to === from) {
    onUpdate(to);
    return () => {};
  }
  let raf = 0;
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - t, 3);
    onUpdate(from + (to - from) * eased);
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/**
 * Animated numeric readout. Animates every time `value` changes (crossing the
 * reveal threshold the first time, then on live updates). Non-numeric input
 * renders the fallback untouched — never a fabricated number.
 */
export function useCountUp(value, { duration = 600, format } = {}) {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const from = typeof prevRef.current === "number" ? prevRef.current : value;
    prevRef.current = value;
    if (typeof value !== "number") {
      setDisplay(value);
      return;
    }
    const write = (v) =>
      setDisplay(typeof format === "function" ? format(v) : v);
    return animateValue(from, value, reduced ? 0 : duration, write);
  }, [value, duration, reduced, format]);

  return display;
}

/**
 * Boolean for "the page has been scrolled past `offset`". One passive
 * listener; used only for the navbar's compact/frosted state.
 */
export function useScrolled(offset = 24) {
  const [scrolled, setScrolled] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.scrollY > offset;
  });

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        setScrolled(window.scrollY > offset);
        raf = 0;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [offset]);

  return scrolled;
}

/**
 * Scroll progress through the page (0..1) via a single passive scroll
 * listener — drives the tracing beam. Writes one CSS variable per frame at
 * most; the beam itself is a transform, never a layout property.
 */
export function useScrollProgress() {
  const ref = useRef(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      // 0 when the element's top enters the viewport, 1 when its bottom leaves.
      const total = rect.height - vh;
      const done = Math.min(1, Math.max(0, -rect.top / (total > 0 ? total : 1)));
      el.style.setProperty("--beam-progress", done.toFixed(4));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [reduced]);

  return ref;
}
