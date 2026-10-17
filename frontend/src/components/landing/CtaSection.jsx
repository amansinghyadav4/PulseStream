import { Reveal, scrollToSection, SECTION } from "./shared";
import { IconArrowRight } from "../icons";

/**
 * Final conversion moment — deep burgundy ground, cream type, one decision to
 * make. Primary action mirrors the hero; the secondary stays on-page.
 */
export function CtaSection({ navigate, onOpenAuth }) {
  return (
    <section id={SECTION.final} className="ls-final-wrap">
      <Reveal className="ls-final">
        <h2 className="ls-h2">Ready to see your events in real time?</h2>
        <p className="ls-sub">
          Connect your application to PulseStream and get operational
          visibility from ingestion to analytics.
        </p>
        <div className="ls-final-cta">
          <button
            type="button"
            className="ls-btn ls-btn-cream ls-btn-lg ls-btn-magnetic"
            onClick={() => (onOpenAuth ? onOpenAuth("signup") : navigate("signup"))}
          >
            Get started free
            <IconArrowRight size={14} />
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-outline-cream ls-btn-lg"
            onClick={() => scrollToSection(SECTION.developer)}
          >
            View documentation
          </button>
        </div>
      </Reveal>
    </section>
  );
}
