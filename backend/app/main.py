from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings, get_settings
from .errors import install_error_handlers
from .logging_config import configure_logging
from .middleware import RequestContextMiddleware
from .routes import router
from .security import JWKSVerifier
from .supabase import SupabaseGateway


def create_app(
    settings: Settings | None = None,
    *,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """Build the API. The optional transport is only for isolated integration tests."""
    config = settings or get_settings()
    configure_logging(config.log_level)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        timeout = httpx.Timeout(
            config.http_timeout_seconds,
            connect=min(config.http_timeout_seconds, 5.0),
            pool=min(config.http_timeout_seconds, 5.0),
        )
        limits = httpx.Limits(
            max_connections=config.http_max_connections,
            max_keepalive_connections=min(
                config.http_keepalive_connections,
                config.http_max_connections,
            ),
            keepalive_expiry=30.0,
        )
        async with httpx.AsyncClient(
            timeout=timeout,
            limits=limits,
            transport=upstream_transport,
            follow_redirects=False,
            trust_env=False,
            headers={"User-Agent": f"ck-sys-api/{config.app_version}"},
        ) as client:
            application.state.settings = config
            application.state.supabase_http = client
            application.state.supabase = SupabaseGateway(config, client)
            application.state.jwt_verifier = JWKSVerifier(config, client)
            yield

    docs_url = "/docs" if config.docs_enabled else None
    openapi_url = "/openapi.json" if config.docs_enabled else None
    application = FastAPI(
        title=config.app_name,
        version=config.app_version,
        description=(
            "User-scoped Python API for CK SYS. Supabase PostgreSQL is the only "
            "application data store; mutations are atomic and idempotent."
        ),
        lifespan=lifespan,
        docs_url=docs_url,
        redoc_url=None,
        openapi_url=openapi_url,
    )

    # Added from inner to outer by Starlette: compression, CORS/host checks, then
    # the request context layer so even error responses receive no-store headers.
    application.add_middleware(GZipMiddleware, minimum_size=1_024, compresslevel=5)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "X-Request-ID",
        ],
        expose_headers=["X-Request-ID"],
        max_age=0,
    )
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=config.trusted_hosts)
    application.add_middleware(RequestContextMiddleware, production=config.is_production)

    install_error_handlers(application)
    application.include_router(router)
    application.dependency_overrides[get_settings] = lambda: config
    return application


app = create_app()
