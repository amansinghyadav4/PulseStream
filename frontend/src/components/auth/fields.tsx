import { useId, useState } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

/** Labeled text input with inline validation + accessible error wiring. */
export function TextField({
  label,
  error,
  hint,
  type = "text",
  ...props
}: {
  label: string;
  error?: string | null;
  hint?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const isPassword = type === "password";
  const [reveal, setReveal] = useState(false);
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`auth-field ${error ? "has-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <div className="auth-input-wrap">
        <input
          id={id}
          type={isPassword && reveal ? "text" : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...props}
        />
        {isPassword ? (
          <button
            type="button"
            className="auth-reveal"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? "Hide password" : "Show password"}
            aria-pressed={reveal}
            tabIndex={0}
          >
            {reveal ? "Hide" : "Show"}
          </button>
        ) : null}
      </div>
      {hint ? (
        <p className="auth-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="auth-error" id={errId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Primary submit button with a built-in loading (disabled + spinner) state. */
export function SubmitButton({
  loading,
  children,
  disabled,
  ...props
}: { loading?: boolean } & InputHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      className="auth-submit"
      disabled={loading || disabled}
      aria-busy={loading ? true : undefined}
      {...(props as object)}
    >
      {loading ? <span className="auth-spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Form-level error banner (e.g. invalid credentials, network failure). */
export function FormBanner({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  return (
    <div className={`auth-banner ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
