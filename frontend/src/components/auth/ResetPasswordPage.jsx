import { useState } from "react";
import { AuthLayout } from "./AuthLayout";
import { FormBanner, SubmitButton, TextField } from "./fields";
import { api, ApiError } from "../../lib/apiClient";
import { PASSWORD_MIN_LENGTH, validatePasswordStrength } from "../../lib/authValidation";

export function ResetPasswordPage({ location }) {
  const token = location.params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    const pwErr = validatePasswordStrength(password);
    const confirmErr = password !== confirm ? "Passwords do not match." : null;
    setErrors({ password: pwErr, confirm: confirmErr });
    if (pwErr || confirmErr) return;

    setLoading(true);
    try {
      await api.post("/api/v1/auth/reset-password", { token, new_password: password }, { silent401: true });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setFormError("This reset link is invalid or has expired. Request a new one.");
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
      title="Choose a new password"
      subtitle="Enter a new password for your account."
      footer={
        <a href="#/login" className="auth-link">
          ← Back to sign in
        </a>
      }
    >
      {done ? (
        <div className="auth-form">
          <FormBanner kind="success">Your password has been reset.</FormBanner>
          <a href="#/login" className="auth-submit auth-submit-link">
            Continue to sign in
          </a>
        </div>
      ) : !token ? (
        <FormBanner kind="error">
          This reset link is missing its token. Please{" "}
          <a href="#/forgot-password" className="auth-link">
            request a new one
          </a>
          .
        </FormBanner>
      ) : (
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          {formError ? <FormBanner kind="error">{formError}</FormBanner> : null}
          <TextField
            label="New password"
            type="password"
            name="new-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            placeholder="New password"
          />
          <TextField
            label="Confirm new password"
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={errors.confirm}
            placeholder="Re-enter new password"
          />
          <SubmitButton loading={loading}>Reset password</SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}
