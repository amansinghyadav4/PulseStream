import { useState } from "react";
import type { FormEvent } from "react";
import { AuthLayout } from "./AuthLayout";
import { FormBanner, SubmitButton, TextField } from "./fields";
import { useAuth } from "../../context/AuthContext";
import { ApiError } from "../../lib/apiClient";
import { PASSWORD_MIN_LENGTH, validateEmail, validatePasswordStrength } from "../../lib/authValidation";
import { navigateTo } from "../../lib/router";

export function SignupPage() {
  const { signup } = useAuth();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const emailErr = validateEmail(email);
    const pwErr = validatePasswordStrength(password);
    setErrors({ email: emailErr, password: pwErr });
    if (emailErr || pwErr) return;

    setLoading(true);
    try {
      await signup(email.trim(), password, fullName);
      navigateTo("overview");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setErrors((prev) => ({ ...prev, email: "An account with this email already exists." }));
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError("Too many attempts. Please wait a moment and try again.");
      } else if (err instanceof ApiError && err.status === 422) {
        setFormError("Please check your details and try again.");
      } else {
        setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start monitoring your event pipeline in minutes."
      footer={
        <span>
          Already have an account?{" "}
          <a href="#/login" className="auth-link">
            Sign in
          </a>
        </span>
      }
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        {formError ? <FormBanner kind="error">{formError}</FormBanner> : null}
        <TextField
          label="Full name"
          type="text"
          name="name"
          autoComplete="name"
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
      </form>
    </AuthLayout>
  );
}
