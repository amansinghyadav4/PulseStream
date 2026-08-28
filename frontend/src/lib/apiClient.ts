/**
 * Shared API client for the authenticated SPA.
 *
 * Responsibilities:
 *  - Send the session cookie automatically (`credentials: "include"`).
 *  - Echo the double-submit CSRF token (`ps_csrf` cookie) in the
 *    `X-CSRF-Token` header on every state-changing request. The backend
 *    (`app/core/csrf.py`) rejects mutating requests whose header/cookie differ.
 *  - Parse the structured error envelope `{ error: { code, message, details } }`
 *    into a typed `ApiError`.
 *  - Handle expired/absent sessions globally: a 401 on any call the SPA did not
 *    explicitly flag as an auth attempt dispatches `ps:auth-expired`, which the
 *    AuthProvider listens for to drop to the unauthenticated state and redirect
 *    to Login. Login/signup/forgot/reset opt out (their 401s are user-facing).
 */

export const CSRF_COOKIE = "ps_csrf";
export const CSRF_HEADER = "X-CSRF-Token";
export const AUTH_EXPIRED_EVENT = "ps:auth-expired";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || `request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code || "error";
    this.details = body.details;
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface RequestOptions {
  /** When true, a 401 does NOT trigger the global auth-expired redirect. Used
   *  by the auth forms themselves, where a 401 is an expected user-facing error. */
  silent401?: boolean;
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const isMutation = !SAFE_METHODS.has(method.toUpperCase());

  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (isMutation) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "include",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    // Network / connection failure — normalize to an ApiError the UI can show.
    throw new ApiError(0, { code: "network_error", message: "unable to reach the server" });
  }

  if (res.status === 401 && !opts.silent401) {
    // Session is gone or invalid: notify the app to reset to unauthenticated.
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  }

  if (res.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const envelope = (payload as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(res.status, envelope ?? { code: "error", message: `request failed (${res.status})` });
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PUT", path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PATCH", path, body, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};
