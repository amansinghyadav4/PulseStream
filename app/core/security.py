"""Security primitives for server-side authentication (Increment B).

Two distinct hashing concerns, deliberately using two different algorithms:

* **Passwords** are hashed with **Argon2id** (memory-hard, slow by design) — the
  right tool for low-entropy, human-chosen secrets that must resist offline
  cracking. The raw password is never stored or logged.
* **Opaque tokens** (session tokens, password-reset tokens) are high-entropy
  random values (`secrets.token_urlsafe`), so a fast **SHA-256** digest is the
  correct choice: there is nothing to brute-force, and we only need a
  non-reversible lookup key. Using Argon2 here would add latency for no security
  benefit. Only the digest is persisted; the raw token lives solely in the
  httpOnly cookie (sessions) or the reset link (password reset).
"""
from __future__ import annotations

import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

# Argon2id is the default variant for PasswordHasher. Defaults are the argon2-cffi
# recommended parameters; tuning is a deployment concern documented in LEARNING.
_password_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    """Return an Argon2id hash string (includes algorithm + parameters + salt)."""
    return _password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """Constant-time-ish verify. Returns False on any mismatch or malformed hash,
    never raises, so callers can treat every failure as 'invalid credentials'."""
    try:
        return _password_hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError, Exception):
        return False


def needs_rehash(password_hash: str) -> bool:
    """True when the stored hash used weaker parameters than the current policy."""
    try:
        return _password_hasher.check_needs_rehash(password_hash)
    except Exception:
        return False


def generate_token(num_bytes: int = 32) -> str:
    """Cryptographically strong URL-safe opaque token (raw secret, shown once)."""
    return secrets.token_urlsafe(num_bytes)


def hash_token(token: str) -> str:
    """SHA-256 digest used as the DB lookup key for opaque tokens."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    """Constant-time comparison for token/CSRF values."""
    return secrets.compare_digest(a, b)
