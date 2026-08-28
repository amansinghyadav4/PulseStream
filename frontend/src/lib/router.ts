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
] as const;

/** Public auth routes — rendered outside the dashboard shell. Authenticated
 *  users are redirected away from the credential-entry ones (see AUTH_REDIRECT). */
export const AUTH_ROUTES = ["login", "signup", "forgot-password", "reset-password", "logout"] as const;

export const ROUTES = [...DASHBOARD_ROUTES, ...AUTH_ROUTES, "landing"] as const;
export type Route = (typeof ROUTES)[number];

/** Routes an already-authenticated user should be bounced away from (to the
 *  dashboard). `logout` is intentionally excluded — it performs an action. */
export const AUTH_REDIRECT_ROUTES: readonly Route[] = ["login", "signup", "forgot-password", "reset-password"];

/** Routes reachable without a session. */
export const PUBLIC_ROUTES: readonly Route[] = [...AUTH_ROUTES, "landing"];

const DASHBOARD_SET: readonly string[] = DASHBOARD_ROUTES;
export function isDashboardRoute(route: Route): boolean {
  return DASHBOARD_SET.includes(route);
}

export interface RouteLocation {
  route: Route;
  params: URLSearchParams;
}

function parseHash(): RouteLocation {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const route = (ROUTES as readonly string[]).includes(path) ? (path as Route) : "overview";
  return { route, params: new URLSearchParams(query) };
}

/**
 * Hash router — deep-linkable routes with query params. Hash routing keeps the
 * static SPA deploy (nginx) free of server-side rewrite rules while supporting
 * both dashboard and auth routes.
 * Example: "#/events?type=order.created&source=demo-store"
 */
export function useHashRoute(): {
  location: RouteLocation;
  navigate: (route: Route, params?: Record<string, string>) => void;
} {
  const [location, setLocation] = useState<RouteLocation>(parseHash);

  useEffect(() => {
    const onChange = () => setLocation(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = (route: Route, params?: Record<string, string>) => {
    const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
    window.location.hash = `/${route}${qs}`;
    window.scrollTo({ top: 0 });
  };

  return { location, navigate };
}

/** Imperative navigation for use outside React (guards, redirects). */
export function navigateTo(route: Route, params?: Record<string, string>): void {
  const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  window.location.hash = `/${route}${qs}`;
}
