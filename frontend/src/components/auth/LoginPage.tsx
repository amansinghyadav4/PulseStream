import { useState } from "react";
import type { FormEvent } from "react";
import { AuthLayout } from "./AuthLayout";
import { FormBanner, SubmitButton, TextField } from "./fields";
import { useAuth } from "../../context/AuthContext";
import { ApiError } from "../../lib/apiClient";
import { validateEmail, validatePasswordPresent } from "../../lib/authValidation";
import { navigateTo } from "../../lib/router";
import { IconArrowLeft } from "../icons";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const emailErr = validateEmail(email);
    const pwErr = validatePasswordPresent(password);
    setErrors({ email: emailErr, password: pwErr });
    if (emailErr || pwErr) return;

    setLoading(true);
    try {
      await login(email.trim(), password);
      navigateTo("overview");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setFormError("Invalid email or password.");
      } else if (err instanceof ApiError && err.status === 429) {
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
      title="Sign in"
      subtitle="Welcome back. Enter your credentials to access your workspace."
      back={
        // Explicit route navigation (not history.back()) so the control works on
        // a directly-opened /#/login URL with no previous entry to return to.
        <button type="button" className="auth-back" onClick={() => navigateTo("landing")}>
          <IconArrowLeft size={14} />
          Back to PulseStream
        </button>
      }
      footer={
        <>
          <span>
            New to PulseStream?{" "}
            <a href="#/signup" className="auth-link">
              Create an account
            </a>
          </span>
        </>
      }
    >
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
      </form>
    </AuthLayout>
  );
}
