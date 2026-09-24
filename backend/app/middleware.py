from __future__ import annotations

import logging
import time
from uuid import uuid4

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .logging_config import request_id_context


logger = logging.getLogger(__name__)


class RequestContextMiddleware:
    """Attach request/security headers without buffering request or response bodies."""

    def __init__(self, app: ASGIApp, *, production: bool = False) -> None:
        self.app = app
        self.production = production

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = Headers(scope=scope).get("x-request-id", "")
        request_id = incoming if _safe_request_id(incoming) else str(uuid4())
        scope.setdefault("state", {})["request_id"] = request_id
        context_token = request_id_context.set(request_id)
        started = time.perf_counter()
        status_code = 500

        async def send_with_headers(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["Referrer-Policy"] = "no-referrer"
                headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
                # Prevent browsers, proxies, service workers, and CDNs from retaining
                # ERP or identity responses on the user's device or between requests.
                headers["Cache-Control"] = "no-store, max-age=0"
                headers["Pragma"] = "no-cache"
                headers["Expires"] = "0"
                headers["Surrogate-Control"] = "no-store"
                if self.production:
                    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            logger.info(
                "Request completed",
                extra={
                    "method": scope.get("method", "-"),
                    "path": scope.get("path", "-"),
                    "status_code": status_code,
                    "duration_ms": duration_ms,
                },
            )
            request_id_context.reset(context_token)


def _safe_request_id(value: str) -> bool:
    return bool(value) and len(value) <= 128 and all(
        character.isalnum() or character in "-_.:" for character in value
    )
