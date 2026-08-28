export const PASSWORD_MIN_LENGTH = 10; // mirrors backend settings.password_min_length

// Pragmatic email shape check — the server does authoritative validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: string): string | null {
  const v = value.trim();
  if (!v) return "Email is required.";
  if (!EMAIL_RE.test(v)) return "Enter a valid email address.";
  return null;
}

export function validatePasswordPresent(value: string): string | null {
  if (!value) return "Password is required.";
  return null;
}

/** Signup / reset policy: mirrors the server's minimum-length + no-whitespace rule. */
export function validatePasswordStrength(value: string): string | null {
  if (!value) return "Password is required.";
  if (value.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (value.trim() !== value) return "Password must not have leading or trailing spaces.";
  return null;
}
