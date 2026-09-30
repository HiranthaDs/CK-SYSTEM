from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import math
import random
import re
from dataclasses import dataclass
from math import ceil
from typing import Any, Literal
from uuid import UUID

import httpx

from .config import Settings
from .errors import ApiError
from .models import MutationResponse, PageResponse, ProfileAccess

logger = logging.getLogger(__name__)

READABLE_SOURCES = frozenset(
    {
        "current_user_access",
        "admin_user_access",
        "roles",
        "employees",
        "employee_compensation_history",
        "conversion_types",
        "piecework_rates",
        "inventory_items",
        "raw_material_purchases",
        "conversions",
        "conversion_workers",
        "daily_work",
        "daily_work_piecework",
        "overtime_work_view",
        "production_runs",
        "sales",
        "sale_items",
        "sale_payments",
        "payrolls",
        "payroll_details",
        "payroll_payments",
        "stock_adjustments",
        "journal_entries",
        "journal_lines",
        "stock_movements",
        "inventory_position",
        "inventory_stage_summary",
        "company_inventory_position",
        "company_inventory_stage_summary",
        "production_daily_summary",
        "account_balances",
        "account_balances_by_year",
        "ledger_view",
        "employee_open_earnings",
        "sales_outstanding",
        "payroll_outstanding",
        "audit_log",
    }
)

# Each collection gets a deterministic unique final ordering column. This makes
# both offset pages stable and keyset pages safe when many records share a date.
SOURCE_TIEBREAKERS: dict[str, str] = {
    "current_user_access": "user_id",
    "admin_user_access": "user_id",
    "roles": "id",
    "employees": "id",
    "employee_compensation_history": "id",
    "conversion_types": "id",
    "piecework_rates": "id",
    "inventory_items": "id",
    "raw_material_purchases": "id",
    "conversions": "id",
    "conversion_workers": "id",
    "daily_work": "id",
    "daily_work_piecework": "id",
    "overtime_work_view": "id",
    "production_runs": "id",
    "sales": "id",
    "sale_items": "id",
    "sale_payments": "id",
    "payrolls": "id",
    "payroll_details": "id",
    "payroll_payments": "id",
    "stock_adjustments": "id",
    "journal_entries": "id",
    "journal_lines": "id",
    "stock_movements": "id",
    "inventory_position": "item_id",
    "inventory_stage_summary": "stage",
    "company_inventory_position": "item_id",
    "company_inventory_stage_summary": "stage",
    "production_daily_summary": "production_date",
    "account_balances": "account_code",
    "account_balances_by_year": "account_code",
    "ledger_view": "id",
    "employee_open_earnings": "source_id",
    "sales_outstanding": "id",
    "payroll_outstanding": "id",
    "audit_log": "id",
}

# Company-private sources are always constrained here as a defense in depth in
# addition to database RLS. Only identity/configuration and the intentionally
# shared physical inventory catalogue/availability views remain unscoped.
UNSCOPED_SOURCES = frozenset(
    {
        "current_user_access",
        "roles",
        "conversion_types",
        "piecework_rates",
        "inventory_items",
        "inventory_position",
        "inventory_stage_summary",
    }
)
COMPANY_SCOPED_SOURCES = READABLE_SOURCES - UNSCOPED_SOURCES

FilterOperator = Literal["eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "ilike"]
PaginationMode = Literal["offset", "cursor"]
_ORDER_RE = re.compile(r"^(?P<column>[a-z_][a-z0-9_]*)\.(?P<direction>asc|desc)$")
_RETRYABLE_STATUS = frozenset({408, 425, 429, 502, 503, 504})
_CURSOR_VERSION = 1


@dataclass(frozen=True, slots=True)
class QueryFilter:
    column: str
    operator: FilterOperator
    value: str | int | float | bool


@dataclass(frozen=True, slots=True)
class _CursorState:
    position: str | int | float | bool
    tie: str | int | float | bool
    page: int
    total: int


class SupabaseGateway:
    """Small user-scoped PostgREST gateway; it never holds application data."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client

    async def auth_health(self) -> dict[str, Any]:
        url = f"{self._settings.supabase_base_url}/auth/v1/health"
        headers = {
            "apikey": self._settings.publishable_key,
            "Accept": "application/json",
            "Cache-Control": "no-store, no-cache",
        }
        try:
            response = await self._send_with_retry(
                "GET", url, headers=headers, retry_safe=True
            )
            response.raise_for_status()
            data = response.json()
            return data if isinstance(data, dict) else {"status": "ok"}
        except (httpx.HTTPError, ValueError) as exc:
            raise ApiError(
                503,
                "Supabase Auth is unavailable",
                code="supabase_unavailable",
            ) from exc

    async def schema_health(self) -> dict[str, str]:
        """Verify that the ERP Data API contract exists without bypassing RLS."""
        url = f"{self._settings.rest_url}/current_user_access"
        headers = {
            "apikey": self._settings.publishable_key,
            "Accept": "application/json",
            "Accept-Profile": self._settings.supabase_schema,
            "Cache-Control": "no-store, no-cache",
        }
        try:
            response = await self._send_with_retry(
                "GET",
                url,
                params={"select": "user_id", "limit": "0"},
                headers=headers,
                retry_safe=True,
            )
        except httpx.HTTPError as exc:
            raise ApiError(
                503,
                "Supabase Data API is unavailable",
                code="supabase_unavailable",
            ) from exc

        try:
            body = response.json() if response.content else {}
        except ValueError:
            body = {}
        pg_code = str(body.get("code") or "") if isinstance(body, dict) else ""

        if response.is_success:
            return {"status": "ok"}
        # The contract is intentionally not granted to the anonymous role. A
        # permission error proves PostgREST can resolve the object while keeping
        # the readiness probe outside every user's data boundary.
        if response.status_code in {401, 403} and pg_code == "42501":
            return {"status": "protected"}
        if pg_code in {"PGRST202", "PGRST204", "PGRST205"}:
            raise ApiError(
                503,
                "The Supabase ERP schema is not deployed. Apply all database migrations.",
                code="supabase_schema_unavailable",
            )
        raise ApiError(
            503,
            "Supabase Data API readiness check failed",
            code="supabase_unavailable",
        )

    async def fetch_profile(
        self, token: str, request_id: str, expected_user_id: str
    ) -> ProfileAccess:
        data = await self._request(
            "GET",
            "current_user_access",
            token=token,
            request_id=request_id,
            params={
                "select": "user_id,display_name,email,is_active,is_super_admin,companies",
                "user_id": f"eq.{expected_user_id}",
                "limit": "1",
            },
            retry_safe=True,
        )
        if not isinstance(data, list) or not data:
            raise ApiError(403, "No active ERP profile is assigned", code="profile_not_authorized")
        profile = ProfileAccess.model_validate(data[0])
        if str(profile.user_id) != expected_user_id:
            raise ApiError(403, "Profile identity mismatch", code="profile_not_authorized")
        if not profile.is_active:
            raise ApiError(403, "The ERP profile is inactive", code="profile_inactive")
        return profile

    async def select_page(
        self,
        source: str,
        *,
        token: str,
        request_id: str,
        page: int,
        page_size: int,
        select: str = "*",
        order: str | None = None,
        filters: list[QueryFilter] | None = None,
        pagination_mode: PaginationMode = "offset",
        cursor: str | None = None,
        company_id: UUID | str | None = None,
    ) -> PageResponse[dict[str, Any]]:
        self._assert_source(source)
        if page < 1 or page_size < 1:
            raise ApiError(422, "Invalid pagination bounds", code="invalid_pagination")
        if page_size > self._settings.max_page_size and pagination_mode == "offset":
            raise ApiError(422, "Page size exceeds the configured limit", code="invalid_pagination")

        stable_order, order_column, direction, tie_column = self._stable_order(source, order)
        query_filters = self._scope_filters(source, company_id, filters)
        fingerprint = self._query_fingerprint(query_filters, select)
        # Keep query parameters as an ordered list. PostgREST accepts repeated
        # column filters (for example date >= start AND date <= end), while a
        # dict silently discarded the first bound and produced incorrect
        # reports for every date range.
        params: list[tuple[str, str]] = [
            ("select", select),
            ("limit", str(page_size + 1 if pagination_mode == "cursor" else page_size)),
            ("order", stable_order),
        ]

        cursor_state: _CursorState | None = None
        if pagination_mode == "offset":
            if cursor is not None:
                raise ApiError(422, "Cursor is not valid for offset pagination", code="invalid_cursor")
            params.append(("offset", str((page - 1) * page_size)))
        else:
            if page != 1:
                raise ApiError(
                    422,
                    "Page cannot be combined with cursor pagination",
                    code="invalid_pagination",
                )
            if cursor:
                cursor_state = self._decode_cursor(
                    cursor,
                    source=source,
                    order_column=order_column,
                    direction=direction,
                    tie_column=tie_column,
                    fingerprint=fingerprint,
                )
                params.append(
                    (
                        "or",
                        self._cursor_predicate(
                            order_column,
                            direction,
                            tie_column,
                            cursor_state,
                        ),
                    )
                )

        for item in query_filters:
            params.append((item.column, self._filter_value(item)))

        count_requested = pagination_mode == "offset" or cursor_state is None
        extra_headers = (
            {"Prefer": f"count={self._settings.pagination_count}"}
            if count_requested
            else None
        )
        data, headers = await self._request_with_headers(
            "GET",
            source,
            token=token,
            request_id=request_id,
            params=params,
            extra_headers=extra_headers,
            retry_safe=True,
        )
        if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
            raise ApiError(502, "Supabase returned an invalid collection", code="invalid_upstream")

        if pagination_mode == "cursor":
            response_page = cursor_state.page if cursor_state else 1
            total = (
                cursor_state.total
                if cursor_state
                else self._parse_total(headers.get("content-range"), fallback=len(data))
            )
            has_more = len(data) > page_size
            items = data[:page_size]
            next_cursor = None
            if has_more and items:
                next_cursor = self._encode_cursor(
                    source=source,
                    order_column=order_column,
                    direction=direction,
                    tie_column=tie_column,
                    fingerprint=fingerprint,
                    item=items[-1],
                    page=response_page + 1,
                    total=total,
                )
            return PageResponse[dict[str, Any]](
                items=items,
                total=total,
                page=response_page,
                page_size=page_size,
                pages=ceil(total / page_size) if total else 0,
                pagination_mode="cursor",
                next_cursor=next_cursor,
                has_more=has_more,
                total_is_estimate=self._settings.pagination_count != "exact",
            )

        total = self._parse_total(headers.get("content-range"), fallback=len(data))
        return PageResponse[dict[str, Any]](
            items=data,
            total=total,
            page=page,
            page_size=page_size,
            pages=ceil(total / page_size) if total else 0,
            pagination_mode="offset",
            has_more=page * page_size < total,
            total_is_estimate=self._settings.pagination_count != "exact",
        )

    async def select_one(
        self,
        source: str,
        record_id: str,
        *,
        token: str,
        request_id: str,
        select: str = "*",
        company_id: UUID | str | None = None,
    ) -> dict[str, Any]:
        self._assert_source(source)
        params: list[tuple[str, str]] = [
            ("select", select),
            ("id", f"eq.{record_id}"),
            ("limit", "1"),
        ]
        for item in self._scope_filters(source, company_id, None):
            params.append((item.column, self._filter_value(item)))
        data = await self._request(
            "GET",
            source,
            token=token,
            request_id=request_id,
            params=params,
            retry_safe=True,
        )
        if not isinstance(data, list) or not data:
            raise ApiError(404, "Record not found", code="record_not_found")
        if not isinstance(data[0], dict):
            raise ApiError(502, "Supabase returned an invalid record", code="invalid_upstream")
        return data[0]

    async def select_all(
        self,
        source: str,
        *,
        token: str,
        request_id: str,
        select: str = "*",
        order: str | None = None,
        filters: list[QueryFilter] | None = None,
        max_rows: int = 10_000,
        company_id: UUID | str | None = None,
    ) -> list[dict[str, Any]]:
        """Read a bounded result using keysets; never accumulate an unbounded export."""
        if max_rows < 1:
            raise ValueError("max_rows must be positive")
        rows: list[dict[str, Any]] = []
        page_size = min(self._settings.max_page_size, max_rows)
        cursor: str | None = None
        while True:
            result = await self.select_page(
                source,
                token=token,
                request_id=request_id,
                page=1,
                page_size=page_size,
                select=select,
                order=order,
                filters=filters,
                pagination_mode="cursor",
                cursor=cursor,
                company_id=company_id,
            )
            if len(rows) + len(result.items) > max_rows:
                raise ApiError(413, "Result exceeds the safe row limit", code="result_too_large")
            rows.extend(result.items)
            if not result.has_more:
                return rows
            if not result.next_cursor or len(rows) >= max_rows:
                raise ApiError(413, "Result exceeds the safe row limit", code="result_too_large")
            cursor = result.next_cursor

    async def execute(
        self,
        operation: str,
        payload: dict[str, Any],
        idempotency_key: str,
        *,
        token: str,
        request_id: str,
        company_id: UUID | str,
    ) -> MutationResponse:
        scoped_payload = dict(payload)
        scoped_payload["company_id"] = str(company_id)
        body = {
            "p_operation": operation,
            "p_payload": scoped_payload,
            "p_idempotency_key": idempotency_key,
        }
        data = await self._request(
            "POST",
            "rpc/erp_execute",
            token=token,
            request_id=request_id,
            json=body,
            extra_headers={
                "Prefer": "return=representation",
                "Idempotency-Key": idempotency_key,
            },
            # The database owns the idempotency record in the same transaction,
            # so a lost response can be retried without duplicating the mutation.
            retry_safe=True,
        )
        data = self._unwrap_rpc(data)
        if not isinstance(data, dict):
            raise ApiError(502, "ERP transaction returned an invalid result", code="invalid_upstream")
        return MutationResponse.model_validate(data)

    async def create_auth_user(
        self,
        *,
        email: str,
        password: str,
        display_name: str,
        request_id: str,
    ) -> UUID:
        secret = self._settings.secret_key
        if not secret:
            raise ApiError(
                503,
                "Server account creation is not configured",
                code="auth_admin_not_configured",
            )
        url = f"{self._settings.auth_issuer}/admin/users"
        headers = {
            "apikey": secret,
            "Authorization": f"Bearer {secret}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Request-ID": request_id,
            "Cache-Control": "no-store, no-cache",
        }
        try:
            response = await self._send_with_retry(
                "POST",
                url,
                headers=headers,
                json={
                    "email": email,
                    "password": password,
                    "email_confirm": True,
                    "user_metadata": {"full_name": display_name},
                },
                retry_safe=False,
            )
        except httpx.HTTPError as exc:
            raise ApiError(503, "Supabase Auth is unavailable", code="supabase_unavailable") from exc
        if not response.is_success:
            raise self._map_error(response)
        try:
            body = response.json()
            return UUID(str(body["id"]))
        except (ValueError, KeyError, TypeError) as exc:
            raise ApiError(502, "Supabase Auth returned an invalid user", code="invalid_upstream") from exc

    async def delete_auth_user(self, user_id: UUID, *, request_id: str) -> None:
        """Compensate a failed first-time provision; never used for normal deletion."""
        secret = self._settings.secret_key
        if not secret:
            return
        response = await self._send_with_retry(
            "DELETE",
            f"{self._settings.auth_issuer}/admin/users/{user_id}",
            headers={
                "apikey": secret,
                "Authorization": f"Bearer {secret}",
                "Accept": "application/json",
                "X-Request-ID": request_id,
                "Cache-Control": "no-store, no-cache",
            },
            retry_safe=False,
        )
        if not response.is_success:
            logger.error("Auth-user compensation failed", extra={"request_id": request_id})

    async def provision_user_access(
        self,
        *,
        target_user_id: UUID,
        display_name: str,
        company_codes: list[str],
        role_codes: list[str],
        is_super_admin: bool,
        token: str,
        request_id: str,
    ) -> MutationResponse:
        data = await self._request(
            "POST",
            "rpc/provision_user_access",
            token=token,
            request_id=request_id,
            json={
                "p_target_user_id": str(target_user_id),
                "p_display_name": display_name,
                "p_company_codes": company_codes,
                "p_role_codes": role_codes,
                "p_is_super_admin": is_super_admin,
            },
            retry_safe=False,
        )
        value = self._unwrap_rpc(data)
        if not isinstance(value, dict):
            raise ApiError(502, "Access provisioning returned an invalid result", code="invalid_upstream")
        return MutationResponse.model_validate(value)

    async def set_user_account_status(
        self,
        *,
        target_user_id: UUID,
        is_active: bool,
        token: str,
        request_id: str,
        idempotency_key: str,
    ) -> MutationResponse:
        data = await self._request(
            "POST",
            "rpc/set_user_account_status",
            token=token,
            request_id=request_id,
            json={
                "p_target_user_id": str(target_user_id),
                "p_is_active": is_active,
                "p_request_id": request_id,
                "p_idempotency_key": idempotency_key,
            },
            retry_safe=False,
        )
        value = self._unwrap_rpc(data)
        if not isinstance(value, dict):
            raise ApiError(502, "Account status returned an invalid result", code="invalid_upstream")
        return MutationResponse.model_validate(value)

    async def remove_user_account(
        self,
        *,
        target_user_id: UUID,
        confirmation_pin: str,
        token: str,
        request_id: str,
        idempotency_key: str,
    ) -> MutationResponse:
        data = await self._request(
            "POST",
            "rpc/remove_user_account",
            token=token,
            request_id=request_id,
            json={
                "p_target_user_id": str(target_user_id),
                "p_confirmation_pin": confirmation_pin,
                "p_request_id": request_id,
                "p_idempotency_key": idempotency_key,
            },
            retry_safe=False,
        )
        value = self._unwrap_rpc(data)
        if not isinstance(value, dict):
            raise ApiError(502, "Account removal returned an invalid result", code="invalid_upstream")
        return MutationResponse.model_validate(value)

    async def dashboard(
        self,
        year: int | None,
        *,
        token: str,
        request_id: str,
        company_id: UUID | str,
    ) -> dict[str, Any]:
        body = {"p_company_id": str(company_id), "p_year": year}
        data = await self._request(
            "POST",
            "rpc/erp_company_dashboard",
            token=token,
            request_id=request_id,
            json=body,
            retry_safe=True,
        )
        value = self._unwrap_rpc(data)
        if not isinstance(value, dict):
            raise ApiError(502, "Dashboard returned an invalid result", code="invalid_upstream")
        return value

    async def _request(
        self,
        method: str,
        path: str,
        *,
        token: str,
        request_id: str,
        params: dict[str, str] | list[tuple[str, str]] | None = None,
        json: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
        retry_safe: bool = False,
    ) -> Any:
        data, _ = await self._request_with_headers(
            method,
            path,
            token=token,
            request_id=request_id,
            params=params,
            json=json,
            extra_headers=extra_headers,
            retry_safe=retry_safe,
        )
        return data

    async def _request_with_headers(
        self,
        method: str,
        path: str,
        *,
        token: str,
        request_id: str,
        params: dict[str, str] | list[tuple[str, str]] | None = None,
        json: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
        retry_safe: bool = False,
    ) -> tuple[Any, httpx.Headers]:
        headers = {
            "apikey": self._settings.publishable_key,
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Accept-Profile": self._settings.supabase_schema,
            "Content-Profile": self._settings.supabase_schema,
            "X-Request-ID": request_id,
            "Cache-Control": "no-store, no-cache",
        }
        if extra_headers:
            headers.update(extra_headers)
        url = f"{self._settings.rest_url}/{path.lstrip('/')}"
        try:
            response = await self._send_with_retry(
                method,
                url,
                params=params,
                json=json,
                headers=headers,
                retry_safe=retry_safe,
            )
        except httpx.TimeoutException as exc:
            raise ApiError(503, "Supabase request timed out", code="supabase_timeout") from exc
        except httpx.HTTPError as exc:
            raise ApiError(503, "Supabase is unavailable", code="supabase_unavailable") from exc
        if response.is_error:
            raise self._map_error(response)
        if response.status_code == 204 or not response.content:
            return None, response.headers
        if len(response.content) > 64 * 1024 * 1024:
            raise ApiError(502, "Supabase response exceeded the safe limit", code="invalid_upstream")
        try:
            return response.json(), response.headers
        except ValueError as exc:
            raise ApiError(502, "Supabase returned invalid JSON", code="invalid_upstream") from exc

    async def _send_with_retry(
        self,
        method: str,
        url: str,
        *,
        retry_safe: bool,
        **kwargs: Any,
    ) -> httpx.Response:
        attempts = self._settings.http_retry_attempts if retry_safe else 1
        for attempt in range(attempts):
            try:
                response = await self._client.request(method, url, **kwargs)
            except httpx.TransportError:
                if attempt + 1 >= attempts:
                    raise
                await asyncio.sleep(self._retry_delay(attempt, None))
                continue

            if response.status_code not in _RETRYABLE_STATUS or attempt + 1 >= attempts:
                return response
            await asyncio.sleep(self._retry_delay(attempt, response.headers.get("retry-after")))
        raise RuntimeError("HTTP retry loop exited unexpectedly")  # pragma: no cover

    def _retry_delay(self, attempt: int, retry_after: str | None) -> float:
        if retry_after and retry_after.isdigit():
            return min(float(retry_after), self._settings.http_retry_max_seconds)
        base = min(
            self._settings.http_retry_base_seconds * (2**attempt),
            self._settings.http_retry_max_seconds,
        )
        return min(base * random.uniform(0.8, 1.2), self._settings.http_retry_max_seconds)

    def _map_error(self, response: httpx.Response) -> ApiError:
        try:
            body = response.json()
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        pg_code = str(body.get("code") or "")[:32]
        upstream_message = str(body.get("message") or body.get("details") or "").strip()
        status = response.status_code
        code = "supabase_error"
        detail = "The database request was rejected"
        if pg_code in {"PGRST200", "PGRST202", "PGRST204", "PGRST205"}:
            status, code = 503, "supabase_schema_unavailable"
            detail = (
                "The Supabase ERP schema update is not deployed. "
                "Apply all database migrations and reload the Data API schema."
            )
        elif status == 401:
            code, detail = "supabase_auth_failed", "The Supabase session was rejected"
        elif status == 403 or pg_code == "42501":
            status, code = 403, "insufficient_database_permission"
            detail = "You do not have permission to perform this database operation"
        elif status == 404 or pg_code == "PGRST116":
            status, code, detail = 404, "record_not_found", "Record not found"
        elif status == 409 or pg_code in {"23503", "23505"}:
            status, code = 409, "data_conflict"
            detail = upstream_message[:500] or "The operation conflicts with existing data"
        elif pg_code in {"22003", "22007", "22023", "22P02", "23502", "23514", "P0001"}:
            status, code = 422, "business_rule_violation"
            detail = upstream_message[:500] or "The operation violates a business rule"
        elif status == 429:
            code, detail = "supabase_rate_limited", "Supabase is temporarily rate limited"
        elif status >= 500:
            status, code, detail = 502, "supabase_bad_gateway", "The database is temporarily unavailable"
        logger.info(
            "Supabase request rejected",
            extra={"upstream_status": response.status_code, "postgres_code": pg_code},
        )
        headers: dict[str, str] = {}
        retry_after = response.headers.get("retry-after")
        if retry_after and len(retry_after) <= 100:
            headers["Retry-After"] = retry_after
        return ApiError(status, detail, code=code, headers=headers)

    def _stable_order(self, source: str, order: str | None) -> tuple[str, str, str, str]:
        if not order:
            raise ApiError(
                500,
                "The collection is missing a deterministic order",
                code="invalid_collection_configuration",
            )
        first = order.split(",", 1)[0]
        match = _ORDER_RE.fullmatch(first)
        if not match:
            raise ApiError(
                500,
                "The collection has an invalid order",
                code="invalid_collection_configuration",
            )
        column = match.group("column")
        direction = match.group("direction")
        tie_column = SOURCE_TIEBREAKERS[source]
        stable = first if tie_column == column else f"{first},{tie_column}.{direction}"
        return stable, column, direction, tie_column

    @staticmethod
    def _query_fingerprint(filters: list[QueryFilter], select: str) -> str:
        payload = {
            "select": select,
            "filters": [
                [item.column, item.operator, item.value]
                for item in sorted(filters, key=lambda row: (row.column, row.operator, str(row.value)))
            ],
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]

    def _encode_cursor(
        self,
        *,
        source: str,
        order_column: str,
        direction: str,
        tie_column: str,
        fingerprint: str,
        item: dict[str, Any],
        page: int,
        total: int,
    ) -> str:
        position = item.get(order_column)
        tie = item.get(tie_column)
        if not self._cursor_scalar(position) or not self._cursor_scalar(tie):
            raise ApiError(
                502,
                "Supabase omitted a pagination key",
                code="invalid_upstream",
            )
        payload = {
            "v": _CURSOR_VERSION,
            "s": source,
            "o": order_column,
            "d": direction,
            "k": tie_column,
            "f": fingerprint,
            "p": page,
            "t": total,
            "x": position,
            "y": tie,
        }
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    def _decode_cursor(
        self,
        cursor: str,
        *,
        source: str,
        order_column: str,
        direction: str,
        tie_column: str,
        fingerprint: str,
    ) -> _CursorState:
        try:
            padded = cursor + "=" * (-len(cursor) % 4)
            raw = base64.b64decode(padded, altchars=b"-_", validate=True)
            if len(raw) > 3_072:
                raise ValueError("cursor is too large")
            payload = json.loads(raw)
        except (UnicodeEncodeError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError, ValueError):
            raise ApiError(422, "Cursor is invalid or expired", code="invalid_cursor") from None
        if (
            not isinstance(payload, dict)
            or payload.get("v") != _CURSOR_VERSION
            or payload.get("s") != source
            or payload.get("o") != order_column
            or payload.get("d") != direction
            or payload.get("k") != tie_column
            or payload.get("f") != fingerprint
            or not self._cursor_scalar(payload.get("x"))
            or not self._cursor_scalar(payload.get("y"))
            or isinstance(payload.get("p"), bool)
            or not isinstance(payload.get("p"), int)
            or not 2 <= payload["p"] <= 1_000_000_000
            or isinstance(payload.get("t"), bool)
            or not isinstance(payload.get("t"), int)
            or not 0 <= payload["t"] <= 9_223_372_036_854_775_807
        ):
            raise ApiError(422, "Cursor does not match this query", code="invalid_cursor")
        return _CursorState(
            position=payload["x"],
            tie=payload["y"],
            page=payload["p"],
            total=payload["t"],
        )

    def _cursor_predicate(
        self,
        order_column: str,
        direction: str,
        tie_column: str,
        state: _CursorState,
    ) -> str:
        operator = "lt" if direction == "desc" else "gt"
        position = self._logic_literal(state.position)
        if tie_column == order_column:
            return f"({order_column}.{operator}.{position})"
        tie = self._logic_literal(state.tie)
        return (
            f"({order_column}.{operator}.{position},"
            f"and({order_column}.eq.{position},{tie_column}.{operator}.{tie}))"
        )

    @staticmethod
    def _cursor_scalar(value: Any) -> bool:
        if isinstance(value, bool):
            return True
        if isinstance(value, (str, int)):
            return len(value) <= 1_024 if isinstance(value, str) else True
        return isinstance(value, float) and math.isfinite(value)

    @staticmethod
    def _logic_literal(value: str | int | float | bool) -> str:
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int):
            return str(value)
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ApiError(422, "Cursor contains an invalid number", code="invalid_cursor")
            return repr(value)
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'

    @staticmethod
    def _unwrap_rpc(data: Any) -> Any:
        if isinstance(data, list) and len(data) == 1:
            return data[0]
        return data

    @staticmethod
    def _parse_total(content_range: str | None, *, fallback: int) -> int:
        if not content_range or "/" not in content_range:
            return fallback
        value = content_range.rsplit("/", 1)[1]
        return int(value) if value.isdigit() else fallback

    @staticmethod
    def _filter_value(item: QueryFilter) -> str:
        if item.operator == "in":
            return f"in.({item.value})"
        value = str(item.value).lower() if isinstance(item.value, bool) else str(item.value)
        return f"{item.operator}.{value}"

    @staticmethod
    def _scope_filters(
        source: str,
        company_id: UUID | str | None,
        filters: list[QueryFilter] | None,
    ) -> list[QueryFilter]:
        scoped = list(filters or [])
        if source not in COMPANY_SCOPED_SOURCES:
            return scoped
        if company_id is None:
            raise ApiError(
                500,
                "A company context is required for this data source",
                code="company_context_missing",
            )

        expected = str(company_id)
        supplied = [item for item in scoped if item.column == "company_id"]
        if any(item.operator != "eq" or str(item.value) != expected for item in supplied):
            raise ApiError(
                403,
                "A data query cannot override the selected company",
                code="company_scope_mismatch",
            )
        if not supplied:
            scoped.append(QueryFilter("company_id", "eq", expected))
        return scoped

    @staticmethod
    def _assert_source(source: str) -> None:
        if source not in READABLE_SOURCES:
            raise RuntimeError(f"Unapproved PostgREST source: {source}")
