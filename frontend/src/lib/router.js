import { useEffect, useState } from "react";

/** Dashboard (protected) routes — require an authenticated session. */
export const DASHBOARD_ROUTES = [
  "overview",
  "analytics",
  "events",
  "failures",
  "sources",
  "pipeline",
  "health",
  "simulator",
  "api-keys",
  "integrations",
  "account",
];

/** Public auth routes — rendered outside the dashboard shell. Authenticated
 *  users are redirected away from the credential-entry ones (see AUTH_REDIRECT). */
export const AUTH_ROUTES = ["login", "signup", "forgot-password", "reset-password", "logout"];

export const ROUTES = [...DASHBOARD_ROUTES, ...AUTH_ROUTES, "landing"];

/** Routes an already-authenticated user should be bounced away from (to the
 *  dashboard). `logout` is intentionally excluded — it performs an action. */
export const AUTH_REDIRECT_ROUTES = ["login", "signup", "forgot-password", "reset-password"];

const DASHBOARD_SET = DASHBOARD_ROUTES;
export function isDashboardRoute(route) {
  return DASHBOARD_SET.includes(route);
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const route = ROUTES.includes(path) ? path : "overview";
  return { route, params: new URLSearchParams(query) };
}

/**
 * Hash router — deep-linkable routes with query params. Hash routing keeps the
 * static SPA deploy (nginx) free of server-side rewrite rules while supporting
 * both dashboard and auth routes.
 * Example: "#/events?type=order.created&source=demo-store"
 */
export function useHashRoute() {
  const [location, setLocation] = useState(parseHash);

  useEffect(() => {
    const onChange = () => setLocation(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = (route, params) => {
    const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
    window.location.hash = `/${route}${qs}`;
    window.scrollTo({ top: 0 });
  };

  return { location, navigate };
}

/** Imperative navigation for use outside React (guards, redirects). */
export function navigateTo(route, params) {
  const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  window.location.hash = `/${route}${qs}`;
}
