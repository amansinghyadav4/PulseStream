import { Reveal } from "./shared";
import {
  IconBolt,
  IconCode,
  IconCommit,
  IconLayers,
  IconShield,
} from "../icons";

const TRUST_ITEMS = [
  { Icon: IconLayers, label: "Multi-tenant ready" },
  { Icon: IconShield, label: "Per-workspace API keys" },
  { Icon: IconBolt, label: "Live WebSocket metrics" },
  { Icon: IconCode, label: "One-request integration" },
  { Icon: IconCommit, label: "Failure tracking" },
  { Icon: IconLayers, label: "Consumer lag monitoring" },
];

/**
 * Capability marquee under the hero. A slow, quiet loop (pure CSS transform,
 * pauses on hover, static and wrapped on small screens / reduced motion) —
 * it names what the platform does without claiming logos or customers it
 * does not have.
 */
export function TrustMarquee() {
  return (
    <Reveal className="ls-marquee" as="section">
      <span className="ls-marquee-title">Built for</span>
      <div className="ls-marquee-track">
        {[...TRUST_ITEMS, ...TRUST_ITEMS].map((t, i) => (
          <span className="ls-marquee-item" key={`${t.label}-${i}`} aria-hidden={i >= TRUST_ITEMS.length}>
            <t.Icon size={14} />
            {t.label}
          </span>
        ))}
      </div>
    </Reveal>
  );
}
