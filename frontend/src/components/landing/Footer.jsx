import { scrollToSection, SECTION } from "./shared";
import { IconPulse } from "../icons";

/**
 * Footer. Every interactive entry resolves to something that exists: an
 * in-page section, the signup route or the login route. The Legal column is
 * rendered as plain text because this deployment publishes no legal pages —
 * inventing routes for them would dead-end the visitor.
 */
export function LandingFooter({ navigate }) {
  const groups = [
    {
      title: "Product",
      items: [
        { label: "Overview", onClick: () => scrollToSection(SECTION.product) },
        { label: "Features", onClick: () => scrollToSection(SECTION.features) },
        { label: "How it works", onClick: () => scrollToSection(SECTION.how) },
      ],
    },
    {
      title: "Developers",
      items: [
        { label: "Documentation", onClick: () => scrollToSection(SECTION.developer) },
        { label: "Integrations", onClick: () => scrollToSection(SECTION.developer) },
        { label: "Get started free", onClick: () => navigate("signup") },
      ],
    },
    {
      title: "Company",
      items: [
        { label: "About", onClick: () => scrollToSection(SECTION.how) },
        { label: "Sign in", onClick: () => navigate("login") },
      ],
    },
    { title: "Legal", items: [{ label: "Terms" }, { label: "Privacy" }, { label: "Security" }] },
  ];

  return (
    <footer className="ls-foot">
      <div className="ls-foot-inner">
        <div className="ls-foot-brand">
          <span className="ls-brand-mark"><IconPulse size={15} /></span>
          <span className="ls-brand-name">PulseStream</span>
          <p className="ls-foot-tag">Real-time event analytics for multi-tenant workspaces.</p>
        </div>
        <div className="ls-foot-cols">
          {groups.map((g) => (
            <div className="ls-foot-col" key={g.title}>
              <h3 className="ls-foot-title">{g.title}</h3>
              <ul className="ls-foot-list">
                {g.items.map((it) => (
                  <li key={it.label}>
                    {it.onClick ? (
                      <button type="button" className="ls-foot-link" onClick={it.onClick}>
                        {it.label}
                      </button>
                    ) : (
                      <span className="ls-foot-static">{it.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="ls-foot-bar">PulseStream — event ingestion, processing and analytics.</div>
    </footer>
  );
}
