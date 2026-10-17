# Google sign-in (optional OAuth provider)

PulseStream ships with email + password authentication (cookie sessions, CSRF,
Argon2id). Google sign-in is an **optional, additive** provider: it uses the same
session mechanism and the same organization model, and when it is not configured
the API reports it as unavailable and the UI hides the button. There is no mock
or fake sign-in path anywhere in the codebase.

- Backend: `app/services/google_oauth.py`, endpoints in `app/api/routes_auth.py`
- Frontend: `frontend/src/components/auth/forms.jsx` (`GoogleButton`),
  rendered by the login/signup pages and the landing-page modal
- Provider discovery: `GET /api/v1/auth/providers` → `{"google": true|false}`
- Table: `user_identities` (migration `0003_user_identities`)

---

## 1. Required configuration

All values come from the environment — nothing is hardcoded.

| Variable | Required | Meaning |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | yes (to enable) | OAuth client id from Google Cloud |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes (to enable) | OAuth client secret (never logged, never sent to the browser) |
| `GOOGLE_OAUTH_REDIRECT_URI` | yes | Must match the Google console entry **exactly** |
| `GOOGLE_OAUTH_STATE_TTL_SECONDS` | no (600) | How long a started sign-in stays valid |
| `FRONTEND_BASE_URL` | recommended | SPA origin used for the post-handshake redirect |

Both the client id and secret must be non-empty: `Settings.google_oauth_enabled`
is derived from them, so a half-configured deployment stays disabled rather than
half-working.

In Docker Compose these are pass-through (`docker-compose.yml`,
`infra/docker-compose.prod.yml`); locally they are read from `.env`
(see `.env.example`).

## 2. Google Cloud setup

1. Google Cloud Console → **APIs & Services → Credentials**.
2. **Create credentials → OAuth client ID → Web application**.
3. Authorized redirect URI — add the value of `GOOGLE_OAUTH_REDIRECT_URI`
   verbatim. Locally that is:

   ```
   http://localhost:8001/api/v1/auth/google/callback
   ```

   Note: the API container publishes port **8001** (`8001:8000`), so the
   callback must use 8001, not 8000. Google rejects `http` origins other than
   `localhost`; for any real deployment use an `https://` URI (the settings
   validator refuses non-https redirect URIs when `APP_ENV=production`).
4. Copy the generated client id and secret into the environment:
   `GOOGLE_OAUTH_CLIENT_ID=…`, `GOOGLE_OAUTH_CLIENT_SECRET=…`.
5. Restart the API so the new environment is picked up.

Google's **consent screen** must be configured for the project (External or
Internal and a support email); test users must be added while the app is in
"Testing".

## 3. Flow, and how each requirement is met

```
browser ──GET /api/v1/auth/google/start?next=login──▶ API
   API sets ps_oauth_state (httpOnly, SameSite=Lax, path=/api/v1/auth/google)
   API 302 ▶ accounts.google.com (client_id, redirect_uri, scope=openid email profile, state)
                       │  user consents
                       ▼
   GET /api/v1/auth/google/callback?code=…&state=…
      1. state must be:  signed (HMAC-SHA256) ✓  unexpired ✓  == cookie ✓
      2. code exchanged at https://oauth2.googleapis.com/token (TLS, client secret)
      3. id_token claims validated: iss, aud, exp, email present, email_verified
      4. resolve/create/link the local user
      5. create a normal DB session + ps_session/ps_csrf cookies
   API 302 ▶ {FRONTEND_BASE_URL}/#/overview          (success)
        or ▶ {FRONTEND_BASE_URL}/#/login?oauth_error=… (any failure)
```

| Requirement | How it is satisfied |
|---|---|
| Credentials from environment | `GOOGLE_OAUTH_CLIENT_ID` / `…_SECRET` settings; no literals in code |
| No hardcoded secrets | `.env.example` ships the keys **empty**; provider disabled without values |
| Secure state validation | Signed (HMAC-SHA256 keyed by the client secret) + expiry + double-submit cookie compared with `secrets.compare_digest` |
| Trusted identity/token validation | `id_token` obtained directly from Google's TLS token endpoint with our client secret; `iss`/`aud`/`exp`/`email_verified` enforced |
| Validated redirect URI | Only the configured URI is ever sent; it must be absolute http(s) and https in production (`google_oauth_redirect_uri_valid`) |
| Safe existing-account / email conflict handling | Existing verified email ⇒ **link** the identity and sign in; disabled account ⇒ refused; otherwise create. Link is idempotent and race-safe |
| Session + cookie security preserved | Reuses `auth_service.create_session` and `_set_session_cookies` — httpOnly session, JS-readable CSRF, Secure in production, SameSite=Lax |
| Organization / tenant model | Identical: the user is a normal `users` row, so `/auth/me` provisions the organization exactly as for a password signup |
| Error handling | Every failure redirects back with `oauth_error=<code>` and **no session**; the SPA maps codes to plain sentences |
| Documented configuration | This file + `.env.example` + compose pass-through |

Error codes the SPA understands: `oauth_unavailable`, `oauth_state_invalid`,
`oauth_exchange_failed`, `oauth_email_unverified`, `oauth_email_conflict`,
`oauth_disabled_account`, `oauth_failed`.

## 4. Design decisions (and the trade-off taken)

- **Separate `user_identities` table** instead of columns on `users`. It leaves
  the existing schema (including the `NOT NULL password_hash`) untouched, allows
  more providers later, and makes `(provider, subject)` uniqueness the single
  source of truth for "this Google account is that user".
- **OAuth-created accounts get a random, never-disclosed password hash.** The
  column stays `NOT NULL`, password login keeps working unchanged, and there is
  no known plaintext that could authenticate against the account.
- **Linking an existing email account instead of erroring.** Google has verified
  control of that mailbox (`email_verified` is required), so the sign-in is the
  same human; refusing would strand every user who signed up with a password.
  An email arriving **unverified** is rejected outright.
- **ID-token signature verification is not re-done in-process.** The token is
  received by our server directly from Google over TLS in exchange for a request
  carrying the client secret, so it cannot be attacker-supplied. Claims are
  still fully validated. Verifying the JWT signature against Google's JWKS would
  add the `cryptography` dependency; that is the documented upgrade path — do it
  if the token ever arrives through a less trusted channel.

## 5. Verification status (honest)

Automated coverage — `tests/test_google_oauth_unit.py` (26 tests, no network):

- signed state round-trip, tampering, wrong secret, expiry floor, garbage input
- authorize URL carries only configured values
- `id_token` payload decoding, malformed rejection
- claim validation: valid, wrong issuer, wrong audience, expired, missing `sub`,
  missing email, unverified email, stringified `email_verified`
- account resolution: existing link, existing email (link, no duplicate user),
  disabled account refused, new account created with an unusable password
- redirects confined to the configured origin + route allowlist
- endpoints: `/auth/providers` reports `false` and `/auth/google/start` returns
  `503 oauth_unavailable` without credentials; with credentials set, `/start`
  returns a 302 to Google **with a signed state and httpOnly cookie**, and a
  forged callback state is rejected with no session.

**Not verified in this environment, and not claimed:** a real end-to-end
handshake against Google (browser consent → real tokens → real session). That
requires live credentials, a registered redirect URI and a browser. Manual
checklist for the operator:

1. Set the three credentials and restart the API.
2. `GET /api/v1/auth/providers` → `{"google": true}`.
3. Open `http://localhost:3000/#/landing`, click **Sign in** → **Continue with
   Google**, complete consent.
4. Expect the redirect back to `#/overview` and `GET /api/v1/auth/me` → 200 with
   an `organization`.
5. Confirm a row exists in `user_identities` for the Google `sub`, and that
   signing in again with the same Google account lands on the **same** user id.
6. Confirm a cancelled consent screen returns to `#/login?oauth_error=…` with no
   session cookie set.
