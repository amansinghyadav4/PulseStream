import { useEffect, useState } from "react";
import { FormBanner, SubmitButton, TextField } from "./fields";
import { useAuth } from "../../context/AuthContext";
import { ApiError } from "../../lib/apiClient";
import { PASSWORD_MIN_LENGTH, validateEmail, validatePasswordPresent, validatePasswordStrength } from "../../lib/authValidation";
import { navigateTo } from "../../lib/router";
import { IconGoogle } from "../icons";

/**
 * The sign-in / sign-up FORMS, extracted so the standalone pages (route
 * `#/login`, `#/signup`) and the landing-page modal render literally the same
 * markup, validation rules, error mapping and AuthContext calls. There is one
 * implementation of each flow — the modal is a different shell, not a second
 * auth system. `onSuccess` lets a host (the modal) react; when it is omitted
 * the form falls back to the route navigation the pages always used.
 */

let _providersPromise = null;

/** Which OAuth providers the API actually reports as configured. Cached for the
 *  session and failure-tolerant: a failure hides the button rather than showing
 *  a Google button that cannot work. */
export function loadAuthProviders() {
  if (!_providersPromise) {
    _providersPromise = fetch("/api/v1/auth/providers", {
      headers: { Accept: "application/json" },
      credentials: "include",
    })
      .then((res) => (res.ok ? res.text() : ""))
      .then((text) => (text ? JSON.parse(text) : {}))
      .catch(() => ({}));
  }
  return _providersPromise;
}

export function useAuthProviders() {
  const [providers, setProviders] = useState({ google: false });
  useEffect(() => {
    let alive = true;
    loadAuthProviders().then((p) => {
      if (alive) setProviders({ google: p?.google === true });
    });
    return () => {
      alive = false;
    };
  }, []);
  return providers;
}

/** Human-readable message for a failed Google handshake. The API redirects back
 *  to the SPA with `?oauth_error=<code>` — we surface a plain sentence instead
 *  of a raw code, and never claim a sign-in succeeded when it did not. */
const OAUTH_ERRORS = {
  oauth_unavailable: "Google sign-in is not configured on this deployment.",
  oauth_state_invalid: "That sign-in link expired. Please try again.",
  oauth_exchange_failed: "Google could not verify the sign-in. Please try again.",
  oauth_email_unverified: "Your Google email address is not verified.",
  oauth_email_conflict: "An account already exists for that email. Sign in with your password instead.",
  oauth_disabled_account: "This account is inactive.",
  oauth_failed: "Google sign-in failed. Please try again.",
};

export function oauthErrorMessage(rawCode) {
  if (!rawCode) return null;
  return OAUTH_ERRORS[rawCode] || OAUTH_ERRORS.oauth_failed;
}

/** Reads `?oauth_error=` off the current hash route (the hash router keeps
 *  query params in `window.location.hash`, not `window.location.search`). */
export function readOAuthError() {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash || "";
  const qs = hash.split("?")[1] || "";
  if (!qs) return null;
  const code = new URLSearchParams(qs).get("oauth_error");
  return oauthErrorMessage(code);
}

/** Starts the server-side OAuth flow. This is a full-page navigation because
 *  the handshake (state cookie → Google → callback → session cookie) is
 *  intentionally server-driven; the SPA never sees a token. */
export function GoogleButton({ label, next = "login" }) {
  const { google } = useAuthProviders();
  if (!google) return null;
  return (
    <button
      type="button"
      className="ls-oauth-btn"
      onClick={() => {
        window.location.href = `/api/v1/auth/google/start?next=${encodeURIComponent(next)}`;
      }}
    >
      <IconGoogle size={16} className="ls-google-mark" />
      {label}
    </button>
  );
}

function useErrorText() {
  return (err, fallback) =>
    err instanceof ApiError ? err.message || fallback : fallback;
}

export function LoginForm({ onSuccess, autoFocus = true }) {
  const { login } = useAuth();
  const message = useErrorText();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(() => readOAuthError());
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    const emailErr = validateEmail(email);
    const pwErr = validatePasswordPresent(password);
    setErrors({ email: emailErr, password: pwErr });
    if (emailErr || pwErr) return;

    setLoading(true);
    try {
      await login(email.trim(), password);
      if (onSuccess) onSuccess();
      else navigateTo("overview");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setFormError("Invalid email or password.");
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError("Too many attempts. Please wait a moment and try again.");
      } else {
        setFormError(message(err, "Something went wrong. Please try again."));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      {formError ? <FormBanner kind="error">{formError}</FormBanner> : null}
      <TextField
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        autoFocus={autoFocus}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
        placeholder="you@company.com"
      />
      <TextField
        label="Password"
        type="password"
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        placeholder="Your password"
      />
      <div className="auth-row-end">
        <a href="#/forgot-password" className="auth-link">
          Forgot password?
        </a>
      </div>
      <SubmitButton loading={loading}>Sign in</SubmitButton>
      <GoogleButton label="Continue with Google" next="login" />
    </form>
  );
}

export function SignupForm({ onSuccess }) {
  const { signup } = useAuth();
  const message = useErrorText();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    const emailErr = validateEmail(email);
    const pwErr = validatePasswordStrength(password);
    setErrors({ email: emailErr, password: pwErr });
    if (emailErr || pwErr) return;

    setLoading(true);
    try {
      await signup(email.trim(), password, fullName);
      if (onSuccess) onSuccess();
      else navigateTo("overview");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setErrors((prev) => ({ ...prev, email: "An account with this email already exists." }));
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError("Too many attempts. Please wait a moment and try again.");
      } else if (err instanceof ApiError && err.status === 422) {
        setFormError("Please check your details and try again.");
      } else {
        setFormError(message(err, "Something went wrong. Please try again."));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      {formError ? <FormBanner kind="error">{formError}</FormBanner> : null}
      <TextField
        label="Full name"
        type="text"
        name="name"
        autoComplete="name"
        autoFocus
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        hint="Optional — used to name your workspace."
        placeholder="Ada Lovelace"
      />
      <TextField
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
        placeholder="you@company.com"
      />
      <TextField
        label="Password"
        type="password"
        name="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        placeholder="Create a strong password"
      />
      <SubmitButton loading={loading}>Create account</SubmitButton>
      <GoogleButton label="Sign up with Google" next="signup" />
    </form>
  );
}
