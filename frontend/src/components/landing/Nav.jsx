import { useState } from "react";
import { useScrolled } from "./motion";
import { ThemeToggle } from "./ThemeToggle";
import { scrollToSection, SECTION } from "./shared";
import { IconMenu, IconPulse, IconX } from "../icons";

/** Marketing nav. Every entry targets a real section on this page — there is
 *  no docs/pricing route in the app, so nothing here can dead-end. */
const NAV_LINKS = [
  { label: "Product", target: SECTION.product },
  { label: "Features", target: SECTION.features },
  { label: "Pricing", target: SECTION.final },
  { label: "Docs", target: SECTION.developer },
  { label: "Integrations", target: SECTION.developer },
  { label: "About", target: SECTION.how },
];

/**
 * Sticky top bar. Transparent and airy at the top of the page, then compacts
 * into a frosted bar once the visitor scrolls (one boolean, all visual
 * transition handled in CSS). Section links are BUTTONS — never anchors — so
 * the hash router never sees an in-page jump as a route change.
 *
 * Sign in / Get started open the in-page authentication dialog (`onOpenAuth`)
 * instead of leaving the marketing page; the `#/login` and `#/signup` routes
 * still work for direct links and bookmarks.
 */
export function LandingNav({ navigate, onOpenAuth, theme, onToggleTheme }) {
  const scrolled = useScrolled(24);
  const [menuOpen, setMenuOpen] = useState(false);

  const goTo = (target) => {
    setMenuOpen(false);
    scrollToSection(target);
  };

  return (
    <header className={`ls-nav${scrolled ? " is-scrolled" : ""}`}>
      <div className="ls-nav-inner">
        <button type="button" className="ls-brand" onClick={() => goTo(SECTION.product)}>
          <span className="ls-brand-mark"><IconPulse size={16} /></span>
          <span className="ls-brand-text">
            <span className="ls-brand-name">PulseStream</span>
            <span className="ls-brand-sub">Real-Time Event Analytics</span>
          </span>
        </button>

        <nav className="ls-nav-links" aria-label="Sections">
          {NAV_LINKS.map((l) => (
            <button
              type="button"
              className="ls-nav-link"
              key={l.label}
              onClick={() => goTo(l.target)}
            >
              {l.label}
            </button>
          ))}
        </nav>

        <div className="ls-nav-cta">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button
            type="button"
            className="ls-btn ls-btn-ghost ls-nav-signin"
            onClick={() => onOpenAuth?.("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-primary"
            onClick={() => onOpenAuth?.("signup")}
          >
            Get started free
          </button>
          <button
            type="button"
            className="ls-nav-toggle"
            aria-expanded={menuOpen}
            aria-controls="ls-nav-sheet"
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <IconX size={16} /> : <IconMenu size={16} />}
          </button>
        </div>
      </div>

      <div id="ls-nav-sheet" className={`ls-nav-sheet${menuOpen ? " is-open" : ""}`}>
        {NAV_LINKS.map((l) => (
          <button type="button" className="ls-nav-link" key={l.label} onClick={() => goTo(l.target)}>
            {l.label}
          </button>
        ))}
        <button
          type="button"
          className="ls-nav-link"
          onClick={() => {
            setMenuOpen(false);
            onOpenAuth?.("signin");
          }}
        >
          Sign in
        </button>
      </div>
    </header>
  );
}
