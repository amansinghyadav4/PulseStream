/**
 * Page header — the one place every dashboard page states where it is.
 *
 * The eyebrow mirrors the navigation group the route lives in, so the page
 * and the sidebar never disagree about the section. Actions sit on the same
 * baseline as the title; the underline belongs to the header, not the page.
 */
export const PAGE_GROUP = {
  overview: "Monitoring",
  analytics: "Monitoring",
  events: "Investigate",
  failures: "Investigate",
  sources: "Investigate",
  pipeline: "Platform",
  health: "Platform",
  "api-keys": "Developer",
  integrations: "Developer",
  simulator: "Tools",
  account: "Account",
};

export function PageHeader({ title, description, group, actions }) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {group ? <p className="page-eyebrow">{group}</p> : null}
        <div className="hero-title">
          <h1>{title}</h1>
        </div>
        {description ? <p className="hero-tagline">{description}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
