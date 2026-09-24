from __future__ import annotations

import json
from functools import lru_cache
from typing import Any, Literal

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _parse_list(value: Any) -> Any:
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return []
        if value.startswith("["):
            return json.loads(value)
        return [part.strip() for part in value.split(",") if part.strip()]
    return value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "backend/.env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "CK SYS ERP API"
    app_version: str = "1.0.0"
    app_env: str = "development"
    log_level: str = "INFO"
    docs_enabled: bool = True

    supabase_url: AnyHttpUrl
    supabase_publishable_key: SecretStr = Field(min_length=20)
    supabase_jwks_url: AnyHttpUrl | None = None
    supabase_schema: str = Field(default="public", pattern=r"^[a-z_][a-z0-9_]*$")

    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    trusted_hosts: list[str] = Field(
        default_factory=lambda: ["localhost", "127.0.0.1", "testserver"]
    )

    jwt_algorithm: str = "ES256"
    jwt_audience: str = "authenticated"
    jwt_leeway_seconds: int = Field(default=30, ge=0, le=300)
    # Supabase's JWKS edge cache is ten minutes. Never retain signing keys longer
    # than that in this process, so a retired key cannot become additionally stale.
    jwks_cache_ttl_seconds: int = Field(default=600, ge=30, le=600)

    http_timeout_seconds: float = Field(default=10.0, ge=1.0, le=60.0)
    http_max_connections: int = Field(default=100, ge=10, le=1000)
    http_keepalive_connections: int = Field(default=20, ge=1, le=200)
    http_retry_attempts: int = Field(default=3, ge=1, le=5)
    http_retry_base_seconds: float = Field(default=0.15, ge=0.05, le=2.0)
    http_retry_max_seconds: float = Field(default=2.0, ge=0.1, le=10.0)

    default_page_size: int = Field(default=25, ge=1, le=100)
    max_page_size: int = Field(default=100, ge=1, le=500)
    pagination_count: Literal["exact", "planned", "estimated"] = "estimated"
    inventory_summary_max_rows: int = Field(default=10_000, ge=100, le=100_000)

    @field_validator("cors_origins", "trusted_hosts", mode="before")
    @classmethod
    def parse_string_lists(cls, value: Any) -> Any:
        return _parse_list(value)

    @field_validator("cors_origins")
    @classmethod
    def validate_cors_origins(cls, value: list[str]) -> list[str]:
        if "*" in value:
            raise ValueError("CORS_ORIGINS cannot contain '*' when credentials are enabled")
        return [origin.rstrip("/") for origin in value]

    @field_validator("jwt_algorithm")
    @classmethod
    def require_es256(cls, value: str) -> str:
        if value.upper() != "ES256":
            raise ValueError("Only ES256 Supabase access tokens are accepted")
        return "ES256"

    @field_validator("supabase_publishable_key")
    @classmethod
    def require_publishable_key(cls, value: SecretStr) -> SecretStr:
        raw = value.get_secret_value()
        if not raw.startswith("sb_publishable_"):
            raise ValueError(
                "SUPABASE_PUBLISHABLE_KEY must be an sb_publishable_ key; "
                "never use a secret/service-role key for user-scoped requests"
            )
        return value

    @model_validator(mode="after")
    def validate_page_sizes(self) -> Settings:
        if self.default_page_size > self.max_page_size:
            raise ValueError("DEFAULT_PAGE_SIZE cannot exceed MAX_PAGE_SIZE")
        if self.http_retry_base_seconds > self.http_retry_max_seconds:
            raise ValueError("HTTP_RETRY_BASE_SECONDS cannot exceed HTTP_RETRY_MAX_SECONDS")

        base = self.supabase_url
        if base.username or base.password or base.query or base.fragment:
            raise ValueError("SUPABASE_URL must not contain credentials, a query, or a fragment")
        if base.path not in (None, "", "/"):
            raise ValueError("SUPABASE_URL must be the project origin without a path")
        if self.is_production and base.scheme != "https":
            raise ValueError("SUPABASE_URL must use HTTPS in production")

        if self.supabase_jwks_url is not None:
            configured = str(self.supabase_jwks_url).rstrip("/")
            expected = f"{self.auth_issuer}/.well-known/jwks.json"
            if configured != expected:
                raise ValueError(
                    "SUPABASE_JWKS_URL must be this project's Auth JWKS endpoint"
                )
        return self

    @property
    def supabase_base_url(self) -> str:
        return str(self.supabase_url).rstrip("/")

    @property
    def rest_url(self) -> str:
        return f"{self.supabase_base_url}/rest/v1"

    @property
    def auth_issuer(self) -> str:
        return f"{self.supabase_base_url}/auth/v1"

    @property
    def jwks_url(self) -> str:
        if self.supabase_jwks_url:
            return str(self.supabase_jwks_url)
        return f"{self.auth_issuer}/.well-known/jwks.json"

    @property
    def publishable_key(self) -> str:
        return self.supabase_publishable_key.get_secret_value()

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
