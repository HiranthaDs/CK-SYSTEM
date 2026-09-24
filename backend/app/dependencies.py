from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import Depends, Header, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings
from .errors import ApiError
from .models import ProfileAccess
from .security import VerifiedToken
from .supabase import SupabaseGateway


bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True, slots=True)
class Principal:
    user_id: UUID
    token: str
    claims: dict[str, Any]
    profile: ProfileAccess

    @property
    def permissions(self) -> frozenset[str]:
        return frozenset(self.profile.permission_codes)

    @property
    def roles(self) -> frozenset[str]:
        return frozenset(self.profile.role_codes)


@dataclass(frozen=True, slots=True)
class Pagination:
    page: int
    page_size: int
    mode: Literal["offset", "cursor"]
    cursor: str | None


def get_gateway(request: Request) -> SupabaseGateway:
    return request.app.state.supabase


async def get_verified_token(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> tuple[str, VerifiedToken]:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise ApiError(
            401,
            "A Supabase user access token is required",
            code="missing_access_token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    verified = await request.app.state.jwt_verifier.verify(credentials.credentials)
    return credentials.credentials, verified


async def get_principal(
    request: Request,
    verified: Annotated[tuple[str, VerifiedToken], Depends(get_verified_token)],
    gateway: Annotated[SupabaseGateway, Depends(get_gateway)],
) -> Principal:
    token, claims = verified
    profile = await gateway.fetch_profile(
        token,
        request.state.request_id,
        expected_user_id=str(claims.subject),
    )
    return Principal(
        user_id=claims.subject,
        token=token,
        claims=claims.claims,
        profile=profile,
    )


def require_permission(permission: str) -> Callable[..., Principal]:
    async def dependency(
        principal: Annotated[Principal, Depends(get_principal)],
    ) -> Principal:
        if "system.admin" in principal.permissions or permission in principal.permissions:
            return principal
        raise ApiError(
            403,
            f"Permission required: {permission}",
            code="permission_denied",
        )

    return dependency


def require_any_permission(*permissions: str) -> Callable[..., Principal]:
    required = frozenset(permissions)
    if not required:
        raise ValueError("At least one permission is required")

    async def dependency(
        principal: Annotated[Principal, Depends(get_principal)],
    ) -> Principal:
        if "system.admin" in principal.permissions or principal.permissions & required:
            return principal
        raise ApiError(
            403,
            f"One of these permissions is required: {', '.join(sorted(required))}",
            code="permission_denied",
        )

    return dependency


def get_pagination(
    settings: Annotated[Settings, Depends(get_settings)],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int | None, Query(ge=1)] = None,
    pagination_mode: Annotated[Literal["offset", "cursor"], Query()] = "offset",
    cursor: Annotated[str | None, Query(min_length=16, max_length=4096)] = None,
) -> Pagination:
    size = page_size or settings.default_page_size
    if size > settings.max_page_size:
        raise ApiError(
            422,
            f"page_size cannot exceed {settings.max_page_size}",
            code="page_size_too_large",
        )
    if cursor is not None and pagination_mode != "cursor":
        raise ApiError(
            422,
            "cursor requires pagination_mode=cursor",
            code="invalid_pagination",
        )
    if pagination_mode == "cursor" and page != 1:
        raise ApiError(
            422,
            "page cannot be combined with cursor pagination",
            code="invalid_pagination",
        )
    return Pagination(page=page, page_size=size, mode=pagination_mode, cursor=cursor)


async def get_idempotency_key(
    value: Annotated[
        str | None,
        Header(
            alias="Idempotency-Key",
            min_length=8,
            max_length=128,
            pattern=r"^[A-Za-z0-9._:-]+$",
        ),
    ] = None,
) -> str:
    if value is None:
        raise ApiError(
            400,
            "Idempotency-Key header is required for every mutation",
            code="idempotency_key_required",
        )
    return value


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]
PageParams = Annotated[Pagination, Depends(get_pagination)]
IdempotencyKey = Annotated[str, Depends(get_idempotency_key)]
