import { useLayoutEffect, useState } from "react";
import { useScrollProgress } from "./landing/motion";
import { themeGround, useLandingTheme } from "./landing/ThemeToggle";
import { LandingNav } from "./landing/Nav";
import { Hero } from "./landing/Hero";
import { TrustMarquee } from "./landing/Marquee";
import { Problem } from "./landing/Problem";
import { PipelineSection } from "./landing/PipelineSection";
import { AnalyticsShowcase } from "./landing/AnalyticsShowcase";
import { BentoFeatures } from "./landing/BentoFeatures";
import { DevSection } from "./landing/DevSection";
import { CtaSection } from "./landing/CtaSection";
import { LandingFooter } from "./landing/Footer";
import { CookieConsent } from "./landing/CookieConsent";
import { AuthModal } from "./auth/AuthModal";

/**
 * Public marketing page for PulseStream. Rendered by App for route "landing"
 * with the unauthenticated metrics snapshot, so every figure shown is either a
 * real reading or an em dash.
 *
 * Composition root only — each scroll-story section lives in its own file
 * under ./landing/. It also owns the three page-level concerns:
 *  - the landing theme (light cream / dark espresso), applied to <html> so the
 *    document ground, scrollbars and browser chrome follow it
 *  - the authentication dialog, so Sign in / Get started never leave the page
 *  - the cookie/consent banner
 * The document root's background is restored on unmount, so the (always dark)
 * dashboard is unaffected.
 */
export function LandingPage({ metrics, navigate }) {
  const beamRef = useScrollProgress();
  const { theme, toggle: toggleTheme } = useLandingTheme();
  const [authMode, setAuthMode] = useState(null);

  // Layout effect (not effect) so the ground is set before the browser paints —
  // the inline script in index.html covers the very first load, this covers
  // every navigation back to the landing page and every theme switch.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const prevBg = root.style.backgroundColor;
    const prevScheme = root.style.colorScheme;
    root.style.backgroundColor = themeGround(theme);
    root.style.colorScheme = theme;
    return () => {
      root.style.backgroundColor = prevBg;
      root.style.colorScheme = prevScheme;
    };
  }, [theme]);

  return (
    <div className="ls">
      <LandingNav
        navigate={navigate}
        onOpenAuth={setAuthMode}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <main className="ls-main" ref={beamRef}>
        <span className="ls-beam" aria-hidden />
        <Hero metrics={metrics} navigate={navigate} onOpenAuth={setAuthMode} />
        <TrustMarquee />
        <Problem />
        <PipelineSection />
        <AnalyticsShowcase metrics={metrics} />
        <BentoFeatures />
        <DevSection navigate={navigate} />
        <CtaSection navigate={navigate} onOpenAuth={setAuthMode} />
      </main>

      <LandingFooter navigate={navigate} />

      {authMode ? (
        <AuthModal mode={authMode} onClose={() => setAuthMode(null)} onSwitch={setAuthMode} />
      ) : null}

      <CookieConsent />
    </div>
  );
}
