import { useState } from "react";
import type { FormEvent } from "react";
import { AuthLayout } from "./AuthLayout";
import { FormBanner, SubmitButton, TextField } from "./fields";
import { api, ApiError } from "../../lib/apiClient";
import { validateEmail } from "../../lib/authValidation";

interface ForgotResponse {
  status: string;
  message: string;
  reset_token?: string | null;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const err = validateEmail(email);
    setEmailError(err);
    if (err) return;

    setLoading(true);
    try {
      const res = await api.post<ForgotResponse>("/api/v1/auth/forgot-password", { email: email.trim() }, { silent401: true });
      setSent(true);
      // Non-production only: the backend surfaces the token so the flow is testable.
      if (res.reset_token) setDevToken(res.reset_token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setFormError("Too many attempts. Please wait a moment and try again.");
      } else {
        setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your account email and we'll send you a reset link."
      footer={
        <a href="#/login" className="auth-link">
          ← Back to sign in
        </a>
      }
    >
      {sent ? (
        <div className="auth-form">
          <FormBanner kind="success">
            If an account exists for <strong>{email.trim()}</strong>, a password reset link has been sent.
          </FormBanner>
          {devToken ? (
            <p className="auth-hint">
              Development mode — use this reset link:{" "}
              <a className="auth-link" href={`#/reset-password?token=${encodeURIComponent(devToken)}`}>
                Reset password
              </a>
            </p>
          ) : null}
        </div>
      ) : (
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          {formError ? <FormBanner kind="error">{formError}</FormBanner> : null}
          <TextField
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailError}
            placeholder="you@company.com"
          />
          <SubmitButton loading={loading}>Send reset link</SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}
