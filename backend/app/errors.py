from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


logger = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(
        self,
        status_code: int,
        detail: str,
        *,
        code: str = "api_error",
        title: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code
        self.title = title or _default_title(status_code)
        self.headers = headers or {}


def _default_title(status_code: int) -> str:
    return {
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        409: "Conflict",
        413: "Payload Too Large",
        422: "Validation Error",
        429: "Too Many Requests",
        500: "Internal Server Error",
        502: "Bad Gateway",
        503: "Service Unavailable",
    }.get(status_code, "Request Failed")


def _problem(
    request: Request,
    status_code: int,
    detail: str,
    *,
    title: str | None = None,
    code: str,
    errors: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": f"https://ck-sys.local/problems/{code}",
        "title": title or _default_title(status_code),
        "status": status_code,
        "detail": detail,
        "instance": request.url.path,
        "request_id": getattr(request.state, "request_id", "-"),
        "code": code,
    }
    if errors:
        body["errors"] = errors
    return body


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_problem(
                request,
                exc.status_code,
                exc.detail,
                title=exc.title,
                code=exc.code,
            ),
            headers=exc.headers,
            media_type="application/problem+json",
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = []
        for error in exc.errors():
            item = dict(error)
            # Validation responses describe where/why without reflecting submitted
            # values, which could otherwise expose sensitive fields to logs/clients.
            item.pop("input", None)
            item.pop("url", None)
            if "ctx" in item:
                item["ctx"] = {key: str(value) for key, value in item["ctx"].items()}
            errors.append(item)
        return JSONResponse(
            status_code=422,
            content=_problem(
                request,
                422,
                "The request did not pass validation.",
                code="request_validation_failed",
                errors=errors,
            ),
            media_type="application/problem+json",
        )

    @app.exception_handler(HTTPException)
    async def http_error_handler(request: Request, exc: HTTPException) -> JSONResponse:
        detail = str(exc.detail) if not isinstance(exc.detail, dict) else "Request failed"
        return JSONResponse(
            status_code=exc.status_code,
            content=_problem(
                request,
                exc.status_code,
                detail,
                code="http_error",
            ),
            headers=exc.headers,
            media_type="application/problem+json",
        )

    @app.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled request failure")
        return JSONResponse(
            status_code=500,
            content=_problem(
                request,
                500,
                "An unexpected error occurred.",
                code="internal_error",
            ),
            media_type="application/problem+json",
        )
