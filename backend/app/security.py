from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
import jwt
from jwt import InvalidTokenError

from .config import Settings
from .errors import ApiError


logger = logging.getLogger(__name__)


def _unauthorized(detail: str = "Invalid or expired access token") -> ApiError:
    return ApiError(
        401,
        detail,
        code="invalid_access_token",
        headers={"WWW-Authenticate": "Bearer"},
    )


@dataclass(frozen=True, slots=True)
class VerifiedToken:
    subject: UUID
    claims: dict[str, Any]


class JWKSVerifier:
    """Asynchronous, bounded-cache verifier for Supabase ES256 access tokens."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client
        self._keys: dict[str, dict[str, Any]] = {}
        self._expires_at = 0.0
        self._last_refresh = 0.0
        self._lock = asyncio.Lock()

    async def warm(self) -> None:
        await self._refresh(force=True)

    async def ensure_ready(self) -> None:
        await self._refresh()

    async def verify(self, token: str) -> VerifiedToken:
        if not token or len(token) > 16_384:
            raise _unauthorized()
        try:
            header = jwt.get_unverified_header(token)
        except InvalidTokenError as exc:
            raise _unauthorized() from exc

        algorithm = header.get("alg")
        key_id = header.get("kid")
        token_type = header.get("typ")
        if (
            algorithm != self._settings.jwt_algorithm
            or not isinstance(key_id, str)
            or not key_id
            or len(key_id) > 256
            or token_type not in (None, "JWT")
        ):
            raise _unauthorized("Only keyed ES256 Supabase access tokens are accepted")

        key = await self._get_key(key_id)
        try:
            claims = self._decode(token, key)
        except jwt.InvalidSignatureError:
            # A rotation may have occurred. Refresh at most once per verification attempt.
            if time.monotonic() - self._last_refresh >= 30:
                await self._refresh(force=True)
            key = self._keys.get(key_id)
            if key is None:
                raise _unauthorized()
            try:
                claims = self._decode(token, key)
            except (InvalidTokenError, TypeError, ValueError) as exc:
                raise _unauthorized() from exc
        except (InvalidTokenError, TypeError, ValueError) as exc:
            raise _unauthorized() from exc

        if claims.get("role") != "authenticated":
            raise _unauthorized("A signed-in user access token is required")
        if claims.get("is_anonymous") is True:
            raise _unauthorized("Anonymous Supabase sessions are not allowed")
        try:
            subject = UUID(str(claims["sub"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise _unauthorized() from exc
        issued_at = claims.get("iat")
        expires_at = claims.get("exp")
        if (
            isinstance(issued_at, bool)
            or not isinstance(issued_at, (int, float))
            or not math.isfinite(issued_at)
            or isinstance(expires_at, bool)
            or not isinstance(expires_at, (int, float))
            or not math.isfinite(expires_at)
            or issued_at > expires_at
        ):
            raise _unauthorized()
        return VerifiedToken(subject=subject, claims=claims)

    def _decode(self, token: str, jwk: dict[str, Any]) -> dict[str, Any]:
        public_key = jwt.algorithms.ECAlgorithm.from_jwk(jwk)
        return jwt.decode(
            token,
            key=public_key,
            algorithms=[self._settings.jwt_algorithm],
            audience=self._settings.jwt_audience,
            issuer=self._settings.auth_issuer,
            leeway=self._settings.jwt_leeway_seconds,
            options={
                "require": ["sub", "iss", "aud", "iat", "exp", "role"],
                "verify_signature": True,
                "verify_aud": True,
                "verify_exp": True,
                "verify_iat": True,
                "verify_iss": True,
            },
        )

    async def _get_key(self, key_id: str) -> dict[str, Any]:
        now = time.monotonic()
        if now >= self._expires_at or not self._keys:
            await self._refresh()
        key = self._keys.get(key_id)
        if key is not None:
            return key

        # Unknown KIDs do not cause unlimited upstream refreshes under attack.
        if time.monotonic() - self._last_refresh >= 30:
            await self._refresh(force=True)
            key = self._keys.get(key_id)
        if key is None:
            raise _unauthorized()
        return key

    async def _refresh(self, *, force: bool = False) -> None:
        async with self._lock:
            now = time.monotonic()
            if not force and self._keys and now < self._expires_at:
                return
            try:
                response = await self._fetch_jwks(force=force)
                if len(response.content) > 1_048_576:
                    raise ValueError("JWKS response is too large")
                document = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("JWKS refresh failed", extra={"upstream": "supabase_auth"})
                if self._keys and now < self._expires_at:
                    return
                raise ApiError(
                    503,
                    "Authentication keys are temporarily unavailable",
                    code="jwks_unavailable",
                ) from exc

            keys: dict[str, dict[str, Any]] = {}
            document_keys = document.get("keys", []) if isinstance(document, dict) else []
            if not isinstance(document_keys, list) or len(document_keys) > 32:
                document_keys = []
            for item in document_keys:
                if not isinstance(item, dict):
                    continue
                kid = item.get("kid")
                key_ops = item.get("key_ops")
                if (
                    isinstance(kid, str)
                    and kid
                    and len(kid) <= 256
                    and item.get("kty") == "EC"
                    and item.get("crv") == "P-256"
                    and item.get("alg") in (None, self._settings.jwt_algorithm)
                    and item.get("use") in (None, "sig")
                    and (
                        key_ops is None
                        or (isinstance(key_ops, list) and "verify" in key_ops)
                    )
                ):
                    keys[kid] = item
            if not keys:
                raise ApiError(
                    503,
                    "Supabase JWKS contains no usable ES256 verification key",
                    code="jwks_unavailable",
                )
            self._keys = keys
            self._last_refresh = now
            self._expires_at = now + self._jwks_ttl(response)

    async def _fetch_jwks(self, *, force: bool) -> httpx.Response:
        headers = {
            "apikey": self._settings.publishable_key,
            "Accept": "application/json",
        }
        if force:
            headers["Cache-Control"] = "no-cache"

        for attempt in range(self._settings.http_retry_attempts):
            try:
                response = await self._client.get(self._settings.jwks_url, headers=headers)
            except httpx.TransportError:
                if attempt + 1 >= self._settings.http_retry_attempts:
                    raise
                delay = min(
                    self._settings.http_retry_base_seconds * (2**attempt),
                    self._settings.http_retry_max_seconds,
                )
                await asyncio.sleep(delay)
                continue
            if (
                response.status_code in {408, 425, 429, 502, 503, 504}
                and attempt + 1 < self._settings.http_retry_attempts
            ):
                delay = min(
                    self._settings.http_retry_base_seconds * (2**attempt),
                    self._settings.http_retry_max_seconds,
                )
                await asyncio.sleep(delay)
                continue
            response.raise_for_status()
            return response
        raise RuntimeError("JWKS retry loop exited unexpectedly")  # pragma: no cover

    def _jwks_ttl(self, response: httpx.Response) -> float:
        ttl = float(self._settings.jwks_cache_ttl_seconds)
        match = re.search(r"(?:^|,)\s*max-age=(\d+)", response.headers.get("cache-control", ""))
        if match:
            ttl = min(ttl, float(match.group(1)))
        age = response.headers.get("age", "")
        if age.isdigit():
            ttl = max(0.0, ttl - float(age))
        return ttl
