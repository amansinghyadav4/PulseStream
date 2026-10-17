from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEFAULT_DATABASE_URL = "postgresql+asyncpg://pulsestream:pulsestream@localhost:5432/pulsestream"
_DEFAULT_KAFKA_BOOTSTRAP = "localhost:9092"
_DEFAULT_REDIS_URL = "redis://localhost:6379/0"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    log_level: str = "INFO"
    database_url: str = _DEFAULT_DATABASE_URL
    cors_origins: str = "http://localhost:3000"
    max_batch_size: int = 1000
    max_body_bytes: int = 1_048_576
    kafka_enabled: bool = True
    kafka_bootstrap_servers: str = "localhost:9092"
    # Canonical topics (Phase 2A): application-events is the primary pipeline,
    # dead-letter-events is the DLQ for poison messages. The legacy name
    # `events.raw` is retired — do not reintroduce it.
    kafka_topic: str = "application-events"
    kafka_dlq_topic: str = "dead-letter-events"
    # Consumer foundation (Phase 2C) — reusable for persistence/analytics workers
    kafka_group_id: str = "persistence-workers"
    kafka_auto_offset_reset: str = "earliest"
    kafka_enable_auto_commit: bool = False
    # Redis (Phase 4) — analytics counters / caching
    redis_enabled: bool = True
    redis_url: str = "redis://localhost:6379/0"
    redis_key_prefix: str = "pulsestream:"
    # TTLs for Phase 4 Redis keys
    redis_idempotency_ttl: int = 86400  # 24h for pulsestream:seen:{event_id}
    redis_per_minute_ttl: int = 120  # 2 minutes for per-minute buckets

    # API-key authentication for event ingestion (security boundary).
    # Comma-separated keys; EMPTY disables auth entirely (local development).
    # Env: PULSESTREAM_API_KEYS — never hard-code real secrets in source.
    pulsestream_api_keys: str = ""

    # ---- Server-side authentication (Increment B) ----
    # Cookie-based, DB-backed sessions. The raw session token lives only in the
    # httpOnly cookie; the DB stores its hash. Secure flag is forced on in prod.
    session_cookie_name: str = "ps_session"
    session_ttl_seconds: int = 60 * 60 * 24 * 7  # 7 days
    session_cookie_samesite: str = "lax"  # lax allows top-level nav; blocks cross-site POST
    session_cookie_secure: bool = False  # dev over http; property forces True in prod
    session_cookie_domain: str | None = None
    # CSRF double-submit: non-httpOnly cookie + matching request header.
    csrf_cookie_name: str = "ps_csrf"
    csrf_header_name: str = "X-CSRF-Token"
    # Auth abuse throttling (per-process fixed window; see rate_limit.py).
    auth_rate_limit_max: int = 10
    auth_rate_limit_window_seconds: int = 60
    # Password policy + reset-token lifetime.
    password_min_length: int = 10
    password_reset_ttl_seconds: int = 60 * 30  # 30 minutes

    # ---- Google sign-in (optional OAuth provider) ----
    # Credentials come ONLY from the environment; there are no defaults that
    # could work by accident. Google sign-in is offered to the client only when
    # BOTH the client id and secret are set (see google_oauth_enabled).
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    # Must EXACTLY match a redirect URI registered in the Google Cloud console.
    # It is never taken from the request; only this configured value is sent.
    google_oauth_redirect_uri: str = "http://localhost:8001/api/v1/auth/google/callback"
    # How long a started sign-in may take before its state expires.
    google_oauth_state_ttl_seconds: int = 600
    # Base URL of the SPA, used as the post-handshake destination. The OAuth
    # callback never redirects anywhere the client asked for beyond a small,
    # fixed route allowlist appended to this origin (no open redirect).
    frontend_base_url: str = "http://localhost:3000"

    @property
    def session_cookie_secure_effective(self) -> bool:
        """Always Secure in production; configurable elsewhere (http dev)."""
        return self.session_cookie_secure or self.app_env == "production"

    @model_validator(mode="after")
    def _production_requires_configuration(self) -> "Settings":
        """Fail fast in production when endpoints were left at dev defaults.

        Rationale: every dependency client degrades gracefully (POST stays 201
        with Kafka/Redis down), which is correct at runtime but would silently
        run a crippled pipeline if production booted with localhost defaults.
        Rejects the exact development default strings; genuinely-intended
        loopback can be spelled via 127.0.0.1 (documented escape hatch).
        """
        if self.app_env == "production":
            offenders = [
                name
                for name, default in (
                    ("DATABASE_URL", _DEFAULT_DATABASE_URL),
                    ("KAFKA_BOOTSTRAP_SERVERS", _DEFAULT_KAFKA_BOOTSTRAP),
                    ("REDIS_URL", _DEFAULT_REDIS_URL),
                )
                if getattr(self, name.lower()) == default
            ]
            if offenders:
                raise ValueError(
                    f"APP_ENV=production requires real endpoints, still at development "
                    f"defaults: {', '.join(offenders)}"
                )
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def api_key_list(self) -> list[str]:
        return [key.strip() for key in self.pulsestream_api_keys.split(",") if key.strip()]

    @property
    def google_oauth_enabled(self) -> bool:
        """Google sign-in is available only when real credentials are present.
        Nothing is faked when they are absent — the API reports the provider as
        unavailable and the SPA hides the button."""
        return bool(
            self.google_oauth_client_id.strip() and self.google_oauth_client_secret.strip()
        )

    @property
    def frontend_origin(self) -> str:
        return self.frontend_base_url.rstrip("/")

    @property
    def google_oauth_redirect_uri_valid(self) -> bool:
        """Well-formed absolute http(s) URL, and https in production."""
        from urllib.parse import urlparse

        parsed = urlparse(self.google_oauth_redirect_uri)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return False
        if self.app_env == "production" and parsed.scheme != "https":
            return False
        return True


@lru_cache
def get_settings() -> Settings:
    return Settings()
