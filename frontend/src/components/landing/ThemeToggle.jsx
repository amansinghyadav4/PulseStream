import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "../icons";
import { prefsAllowed } from "./CookieConsent";

const STORAGE_KEY = "ps_theme";

/** Page ground per theme — also written to <html> and the theme-color meta so
 *  the browser chrome and the area behind the page match. */
export function themeGround(theme) {
  return theme === "dark" ? "#141110" : "#eeeade";
}

function readStoredTheme() {
  try {
    const local = window.localStorage.getItem(STORAGE_KEY);
    if (local === "light" || local === "dark") return local;
  } catch {
    /* storage restricted */
  }
  try {
    const session = window.sessionStorage.getItem(STORAGE_KEY);
    if (session === "light" || session === "dark") return session;
  } catch {
    /* storage restricted */
  }
  return null;
}

/**
 * Initial landing theme:
 *  1. the choice stored on this device (localStorage), else the visit-scoped
 *     copy (sessionStorage, used when preference storage was declined),
 *  2. otherwise the operating-system preference,
 *  3. otherwise light.
 * index.html applies the same order in an inline pre-paint script, so this only
 * has to agree with it — it is never the thing that prevents a flash.
 */
export function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  const stored = readStoredTheme();
  if (stored) return stored;
  try {
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
  } catch {
    /* matchMedia unavailable */
  }
  return "light";
}

/** Remember the choice. With preference storage allowed it is remembered
 *  across visits; otherwise it holds for this visit only (sessionStorage). */
export function persistTheme(theme) {
  try {
    if (prefsAllowed()) {
      window.localStorage.setItem(STORAGE_KEY, theme);
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, theme);
    }
  } catch {
    /* storage unavailable — the theme still applies for this page view */
  }
}

/**
 * Owns the landing page's theme. The attribute lives on <html> so the whole
 * document (scrollbars, form controls, the area behind the sticky nav) follows
 * it; the dashboard never reads it, keeping the two surfaces independent.
 */
export function useLandingTheme() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-ps-theme", theme);
    root.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", themeGround(theme));
  }, [theme]);

  const toggle = () =>
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      persistTheme(next);
      return next;
    });

  return { theme, toggle };
}

/**
 * Animated sun/moon dark/light toggle for the PulseStream landing page.
 * A real <button> with aria-pressed, so it is keyboard-operable and announced
 * correctly; the motion collapses to an instant swap under reduced motion.
 */
export function ThemeToggle({ theme, onToggle, className = "" }) {
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className={`ls-theme-toggle ${isDark ? "is-dark" : "is-light"} ${className}`.trim()}
      onClick={onToggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={isDark}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      <span className="ls-theme-toggle-track" aria-hidden="true">
        <span className="ls-theme-toggle-thumb">
          <span className="ls-theme-icon ls-theme-icon-sun">
            <IconSun size={13} />
          </span>
          <span className="ls-theme-icon ls-theme-icon-moon">
            <IconMoon size={13} />
          </span>
        </span>
      </span>
    </button>
  );
}
