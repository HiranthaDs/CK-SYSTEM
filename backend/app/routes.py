from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query, Request, status

from .config import Settings, get_settings
from .dependencies import (
    IdempotencyKey,
    PageParams,
    Pagination,
    Principal,
    get_gateway,
    get_principal,
    require_any_permission,
    require_permission,
)
from .errors import ApiError
from .models import (
    AccountBalanceRecord,
    AdjustmentPost,
    AdjustmentRecord,
    ConversionPost,
    ConversionRecord,
    ConversionTypeRecord,
    ConversionTypeUpsert,
    DailyWorkRecord,
    DailyWorkUpsert,
    DashboardResponse,
    EmployeeRecord,
    EmployeeUpsert,
    GenericRecord,
    HealthResponse,
    InventoryPositionRecord,
    InventoryStage,
    InventoryStageSummary,
    InventorySummary,
    JournalPost,
    JournalRecord,
    LedgerLineRecord,
    MutationResponse,
    OpenEarningRecord,
    OvertimeRecord,
    OvertimeUpsert,
    PageResponse,
    PaymentRecord,
    PayrollPaymentPost,
    PayrollPost,
    PayrollRecord,
    PieceworkRateRecord,
    PieceworkRateUpsert,
    ProductionDailySummaryRecord,
    ProductionPost,
    ProductionRecord,
    ProductionSummary,
    ProfileAccess,
    PurgeBusinessDataRequest,
    RawMaterialPurchasePost,
    RawMaterialPurchaseRecord,
    ReadinessResponse,
    ReverseRequest,
    SalePaymentPost,
    SalePost,
    SaleRecord,
)
from .supabase import QueryFilter, SupabaseGateway


router = APIRouter(prefix="/api/v1")
Gateway = Annotated[SupabaseGateway, Depends(get_gateway)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

# Keep every payroll read on the base workforce schema. Optional employee
# profile fields are deployed separately and must not make payroll unavailable.
_PAYROLL_SELECT = (
    "*,payroll_details(*),payroll_payments(*),"
    "employee:employees!payrolls_employee_id_fkey("
    "id,employee_no,name,nic,phone,address,epf_no,etf_ref,joined_date,"
    "job_role,employment_type,shift,pay_model,monthly_rate,daily_rate,ot_rate,"
    "bank_details,status)"
)

# Keep line-item labels with every full invoice read so corrections, printing,
# and customer messages never have to guess a product name from its UUID.
_SALE_SELECT = (
    "*,sale_items(*,item:inventory_items!sale_items_item_id_fkey(id,name,sku,unit)),"
    "sale_payments(*)"
)

_PIECEWORK_RATE_SELECT = (
    "*,conversion_type:conversion_types!piecework_rates_conversion_type_id_fkey("
    "id,name,default_chip_name,status)"
)
_CONVERSION_SELECT = (
    "*,conversion_workers(*),conversion_type:conversion_types("
    "id,name,default_chip_name,status),"
    "source_item:inventory_items!conversions_source_item_id_fkey(name,sku),"
    "output_item:inventory_items!conversions_output_item_id_fkey(name,sku)"
)
_CONVERSION_LEGACY_SELECT = (
    "*,conversion_workers(*),"
    "source_item:inventory_items!conversions_source_item_id_fkey(name,sku),"
    "output_item:inventory_items!conversions_output_item_id_fkey(name,sku)"
)


@dataclass(frozen=True, slots=True)
class CollectionFilters:
    q: str | None
    status: str | None
    from_date: date | None
    to_date: date | None
    sort: str | None
    descending: bool


def get_collection_filters(
    q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    status_value: Annotated[
        str | None,
        Query(alias="status", min_length=1, max_length=40, pattern=r"^[a-z_]+$"),
    ] = None,
    from_date: date | None = None,
    to_date: date | None = None,
    sort: Annotated[
        str | None, Query(min_length=1, max_length=60, pattern=r"^[a-z_][a-z0-9_]*$")
    ] = None,
    descending: bool = True,
) -> CollectionFilters:
    if from_date and to_date and from_date > to_date:
        raise ApiError(422, "from_date cannot be later than to_date", code="invalid_date_range")
    return CollectionFilters(q, status_value, from_date, to_date, sort, descending)


CollectionQuery = Annotated[CollectionFilters, Depends(get_collection_filters)]


def _principal(permission: str) -> Any:
    return Depends(require_permission(permission))


def _principal_any(*permissions: str) -> Any:
    return Depends(require_any_permission(*permissions))


def _payload(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_none=True)


def _filters(
    values: CollectionFilters,
    *,
    date_column: str | None,
    search_column: str | None,
    include_status: bool = True,
    extra: list[QueryFilter] | None = None,
) -> list[QueryFilter]:
    result = list(extra or [])
    if include_status and values.status:
        result.append(QueryFilter("status", "eq", values.status))
    if values.q and search_column:
        term = values.q.replace("*", "").replace("%", "")
        if term:
            result.append(QueryFilter(search_column, "ilike", f"*{term}*"))
    if date_column and values.from_date:
        result.append(QueryFilter(date_column, "gte", values.from_date.isoformat()))
    if date_column and values.to_date:
        result.append(QueryFilter(date_column, "lte", values.to_date.isoformat()))
    return result


def _order(
    values: CollectionFilters,
    *,
    allowed: set[str],
    default: str,
) -> str:
    column = values.sort or default
    if column not in allowed:
        raise ApiError(
            422,
            f"sort must be one of: {', '.join(sorted(allowed))}",
            code="invalid_sort",
        )
    return f"{column}.{'desc' if values.descending else 'asc'}"


async def _list(
    request: Request,
    gateway: SupabaseGateway,
    principal: Principal,
    pagination: Pagination,
    *,
    source: str,
    select: str = "*",
    order: str,
    filters: list[QueryFilter] | None = None,
) -> PageResponse[dict[str, Any]]:
    return await gateway.select_page(
        source,
        token=principal.token,
        request_id=request.state.request_id,
        page=pagination.page,
        page_size=pagination.page_size,
        select=select,
        order=order,
        filters=filters,
        pagination_mode=pagination.mode,
        cursor=pagination.cursor,
    )


async def _get(
    request: Request,
    gateway: SupabaseGateway,
    principal: Principal,
    *,
    source: str,
    record_id: UUID,
    select: str = "*",
) -> dict[str, Any]:
    return await gateway.select_one(
        source,
        str(record_id),
        token=principal.token,
        request_id=request.state.request_id,
        select=select,
    )


async def _execute(
    request: Request,
    gateway: SupabaseGateway,
    principal: Principal,
    idempotency_key: str,
    operation: str,
    payload: dict[str, Any],
) -> MutationResponse:
    return await gateway.execute(
        operation,
        payload,
        idempotency_key,
        token=principal.token,
        request_id=request.state.request_id,
    )


def _replacement(record_id: UUID, replacement: Any) -> dict[str, Any]:
    return {"target": {"id": str(record_id)}, "replacement": _payload(replacement)}


def _reversal(record_id: UUID, body: ReverseRequest | None) -> dict[str, Any]:
    payload: dict[str, Any] = {"id": str(record_id)}
    if body and body.reason:
        payload["reason"] = body.reason
    return payload


def _ensure_parent(value: UUID | None, expected: UUID, field: str) -> None:
    if value is not None and value != expected:
        raise ApiError(422, f"{field} does not match the URL", code="parent_id_mismatch")


# Health and identity


@router.get("/health/live", response_model=HealthResponse, tags=["health"])
async def liveness(settings: SettingsDep) -> HealthResponse:
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        version=settings.app_version,
        environment=settings.app_env,
    )


@router.get("/health/ready", response_model=ReadinessResponse, tags=["health"])
async def readiness(request: Request, settings: SettingsDep, gateway: Gateway) -> ReadinessResponse:
    await asyncio.gather(
        gateway.auth_health(),
        gateway.schema_health(),
        request.app.state.jwt_verifier.ensure_ready(),
    )
    return ReadinessResponse(
        status="ready",
        service=settings.app_name,
        version=settings.app_version,
        environment=settings.app_env,
        checks={
            "supabase_auth": "ok",
            "supabase_jwks": "ok",
            "supabase_schema": "ok",
        },
    )


@router.get("/me", response_model=ProfileAccess, tags=["identity"])
async def current_profile(
    principal: Annotated[Principal, Depends(get_principal)],
) -> ProfileAccess:
    return principal.profile


@router.get("/dashboard", response_model=DashboardResponse, tags=["dashboard"])
async def dashboard(
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("dashboard.read")],
    year: Annotated[int | None, Query(ge=2000, le=2200)] = None,
) -> dict[str, Any]:
    return await gateway.dashboard(
        year,
        token=principal.token,
        request_id=request.state.request_id,
    )


# Employees and workforce


@router.get("/employees", response_model=PageResponse[EmployeeRecord], tags=["employees"])
async def list_employees(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("employees.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="employees",
        order=_order(filters, allowed={"employee_no", "name", "joined_date", "created_at"}, default="name"),
        filters=_filters(filters, date_column="joined_date", search_column="name"),
    )


@router.get("/employees/{employee_id}", response_model=EmployeeRecord, tags=["employees"])
async def get_employee(
    employee_id: UUID,
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("employees.read")],
) -> Any:
    return await _get(request, gateway, principal, source="employees", record_id=employee_id)


@router.get(
    "/employees/{employee_id}/compensation-history",
    response_model=PageResponse[GenericRecord],
    tags=["employees"],
)
async def employee_compensation_history(
    employee_id: UUID,
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("payroll.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="employee_compensation_history",
        order=_order(
            filters,
            allowed={"effective_from", "changed_at"},
            default="effective_from",
        ),
        filters=_filters(
            filters,
            date_column="effective_from",
            search_column=None,
            include_status=False,
            extra=[QueryFilter("employee_id", "eq", str(employee_id))],
        ),
    )


@router.post(
    "/employees",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["employees"],
)
async def create_employee(
    body: EmployeeUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "employee.upsert", _payload(body)
    )


@router.patch("/employees/{employee_id}", response_model=MutationResponse, tags=["employees"])
async def update_employee(
    employee_id: UUID,
    body: EmployeeUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
) -> MutationResponse:
    payload = _payload(body)
    payload["id"] = str(employee_id)
    return await _execute(request, gateway, principal, idempotency_key, "employee.upsert", payload)


@router.delete("/employees/{employee_id}", response_model=MutationResponse, tags=["employees"])
async def delete_employee(
    employee_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "employee.delete",
        {"id": str(employee_id)},
    )


@router.get(
    "/conversion-types",
    response_model=PageResponse[ConversionTypeRecord],
    tags=["inventory"],
)
async def list_conversion_types(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[
        Principal,
        _principal_any("inventory.read", "production.read", "employees.read"),
    ],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="conversion_types",
        order=_order(filters, allowed={"name", "created_at"}, default="name"),
        filters=_filters(filters, date_column=None, search_column="name"),
    )


@router.post(
    "/conversion-types",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["inventory"],
)
async def create_conversion_type(
    body: ConversionTypeUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[
        Principal,
        _principal_any("inventory.write", "production.write", "employees.write"),
    ],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "conversion_type.upsert", _payload(body)
    )


@router.patch(
    "/conversion-types/{conversion_type_id}",
    response_model=MutationResponse,
    tags=["inventory"],
)
async def update_conversion_type(
    conversion_type_id: UUID,
    body: ConversionTypeUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[
        Principal,
        _principal_any("inventory.write", "production.write", "employees.write"),
    ],
) -> MutationResponse:
    payload = _payload(body)
    payload["id"] = str(conversion_type_id)
    return await _execute(
        request, gateway, principal, idempotency_key, "conversion_type.upsert", payload
    )


@router.delete(
    "/conversion-types/{conversion_type_id}",
    response_model=MutationResponse,
    tags=["inventory"],
)
async def delete_conversion_type(
    conversion_type_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[
        Principal,
        _principal_any("inventory.write", "production.write", "employees.write"),
    ],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "conversion_type.delete",
        {"id": str(conversion_type_id)},
    )


@router.get(
    "/piecework-rates",
    response_model=PageResponse[PieceworkRateRecord],
    tags=["employees"],
)
async def list_piecework_rates(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[
        Principal,
        _principal_any("employees.read", "inventory.read", "production.read"),
    ],
    conversion_type_id: UUID | None = None,
) -> Any:
    extra = (
        [QueryFilter("conversion_type_id", "eq", str(conversion_type_id))]
        if conversion_type_id
        else []
    )
    order = _order(
        filters,
        allowed={"work_type", "effective_from", "created_at"},
        default="effective_from",
    )
    query_filters = _filters(
        filters,
        date_column="effective_from",
        search_column="work_type",
        extra=extra,
    )
    try:
        return await _list(
            request,
            gateway,
            principal,
            pagination,
            source="piecework_rates",
            select=_PIECEWORK_RATE_SELECT,
            order=order,
            filters=query_filters,
        )
    except ApiError as exc:
        # Deployments that are one migration behind still have the complete
        # legacy rate master. Keep it readable while clearly failing any query
        # that explicitly depends on the new conversion-type column.
        if exc.code != "supabase_schema_unavailable" or conversion_type_id is not None:
            raise
        return await _list(
            request,
            gateway,
            principal,
            pagination,
            source="piecework_rates",
            order=order,
            filters=query_filters,
        )


@router.post(
    "/piecework-rates",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["employees"],
)
async def create_piecework_rate(
    body: PieceworkRateUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[
        Principal,
        _principal_any("employees.write", "inventory.write", "production.write"),
    ],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "piecework_rate.upsert", _payload(body)
    )


@router.patch(
    "/piecework-rates/{rate_id}", response_model=MutationResponse, tags=["employees"]
)
async def update_piecework_rate(
    rate_id: UUID,
    body: PieceworkRateUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[
        Principal,
        _principal_any("employees.write", "inventory.write", "production.write"),
    ],
) -> MutationResponse:
    payload = _payload(body)
    payload["id"] = str(rate_id)
    return await _execute(
        request, gateway, principal, idempotency_key, "piecework_rate.upsert", payload
    )


@router.delete(
    "/piecework-rates/{rate_id}", response_model=MutationResponse, tags=["employees"]
)
async def delete_piecework_rate(
    rate_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[
        Principal,
        _principal_any("employees.write", "inventory.write", "production.write"),
    ],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "piecework_rate.delete",
        {"id": str(rate_id)},
    )


@router.get("/daily-work", response_model=PageResponse[DailyWorkRecord], tags=["workforce"])
async def list_daily_work(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("employees.read")],
    employee_id: UUID | None = None,
) -> Any:
    extra = [QueryFilter("employee_id", "eq", str(employee_id))] if employee_id else []
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="daily_work",
        select="*,daily_work_piecework(*)",
        order=_order(filters, allowed={"work_date", "created_at"}, default="work_date"),
        filters=_filters(
            filters,
            date_column="work_date",
            search_column=None,
            extra=extra,
        ),
    )


@router.post(
    "/daily-work",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["workforce"],
)
async def create_daily_work(
    body: DailyWorkUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "daily_work.upsert", _payload(body)
    )


@router.patch("/daily-work/{work_id}", response_model=MutationResponse, tags=["workforce"])
async def update_daily_work(
    work_id: UUID,
    body: DailyWorkUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
) -> MutationResponse:
    payload = _payload(body)
    payload["id"] = str(work_id)
    return await _execute(request, gateway, principal, idempotency_key, "daily_work.upsert", payload)


@router.delete("/daily-work/{work_id}", response_model=MutationResponse, tags=["workforce"])
async def reverse_daily_work(
    work_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "daily_work.reverse",
        _reversal(work_id, body),
    )


@router.get("/overtime", response_model=PageResponse[OvertimeRecord], tags=["workforce"])
async def list_overtime(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[
        Principal,
        _principal_any("employees.read", "payroll.read", "reports.read"),
    ],
    employee_id: UUID | None = None,
) -> Any:
    extra = [QueryFilter("employee_id", "eq", str(employee_id))] if employee_id else []
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="overtime_work_view",
        order=_order(
            filters,
            allowed={"work_date", "employee_name", "amount", "created_at"},
            default="work_date",
        ),
        filters=_filters(
            filters,
            date_column="work_date",
            search_column="employee_name",
            extra=extra,
        ),
    )


@router.post(
    "/overtime",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["workforce"],
)
async def create_overtime(
    body: OvertimeUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "overtime.upsert", _payload(body)
    )


@router.patch(
    "/overtime/{overtime_id}", response_model=MutationResponse, tags=["workforce"]
)
async def update_overtime(
    overtime_id: UUID,
    body: OvertimeUpsert,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
) -> MutationResponse:
    payload = _payload(body)
    payload["id"] = str(overtime_id)
    return await _execute(
        request, gateway, principal, idempotency_key, "overtime.upsert", payload
    )


@router.delete(
    "/overtime/{overtime_id}", response_model=MutationResponse, tags=["workforce"]
)
async def reverse_overtime(
    overtime_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("employees.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "overtime.reverse",
        _reversal(overtime_id, body),
    )


@router.get(
    "/open-earnings", response_model=PageResponse[OpenEarningRecord], tags=["workforce"]
)
async def list_open_earnings(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("payroll.read")],
    employee_id: UUID | None = None,
    source_type: Annotated[str | None, Query(pattern=r"^[a-z_]+$")] = None,
) -> Any:
    extra: list[QueryFilter] = []
    if employee_id:
        extra.append(QueryFilter("employee_id", "eq", str(employee_id)))
    if source_type:
        extra.append(QueryFilter("source_type", "eq", source_type))
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="employee_open_earnings",
        order=_order(filters, allowed={"work_date", "employee_name", "amount"}, default="work_date"),
        filters=_filters(
            filters,
            date_column="work_date",
            search_column="employee_name",
            include_status=False,
            extra=extra,
        ),
    )


# Inventory reads


@router.get("/inventory/summary", response_model=InventorySummary, tags=["inventory"])
async def inventory_summary(
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> InventorySummary:
    rows = await gateway.select_all(
        "inventory_stage_summary",
        token=principal.token,
        request_id=request.state.request_id,
        order="stage.asc",
        max_rows=3,
    )
    empty = InventoryStageSummary(item_count=0, total_quantity=Decimal("0"), total_value=Decimal("0"))
    summaries = {
        str(row.get("stage")): InventoryStageSummary.model_validate(row)
        for row in rows
        if row.get("stage") in {stage.value for stage in InventoryStage}
    }
    bulk = summaries.get(InventoryStage.BULK.value, empty)
    chips = summaries.get(InventoryStage.CHIP.value, empty)
    finished = summaries.get(InventoryStage.FINISHED.value, empty)
    return InventorySummary(
        bulk=bulk,
        chips=chips,
        finished=finished,
        total_quantity=bulk.total_quantity + chips.total_quantity + finished.total_quantity,
        total_value=bulk.total_value + chips.total_value + finished.total_value,
    )


async def _inventory_stage_page(
    stage_value: InventoryStage,
    request: Request,
    gateway: SupabaseGateway,
    pagination: Pagination,
    filters: CollectionFilters,
    principal: Principal,
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="inventory_position",
        order=_order(
            filters,
            allowed={"item_name", "quantity_on_hand", "inventory_value", "last_movement_at"},
            default="item_name",
        ),
        filters=_filters(
            filters,
            date_column=None,
            search_column="item_name",
            include_status=False,
            extra=[QueryFilter("stage", "eq", stage_value.value)],
        ),
    )


@router.get(
    "/inventory/bulk", response_model=PageResponse[InventoryPositionRecord], tags=["inventory"]
)
async def bulk_inventory(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> Any:
    return await _inventory_stage_page(
        InventoryStage.BULK, request, gateway, pagination, filters, principal
    )


@router.get(
    "/inventory/chips", response_model=PageResponse[InventoryPositionRecord], tags=["inventory"]
)
async def chip_inventory(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> Any:
    return await _inventory_stage_page(
        InventoryStage.CHIP, request, gateway, pagination, filters, principal
    )


@router.get(
    "/inventory/finished",
    response_model=PageResponse[InventoryPositionRecord],
    tags=["inventory"],
)
async def finished_inventory(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> Any:
    return await _inventory_stage_page(
        InventoryStage.FINISHED, request, gateway, pagination, filters, principal
    )


@router.get("/inventory/items", response_model=PageResponse[GenericRecord], tags=["inventory"])
async def inventory_items(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("inventory.read")],
    stage_value: Annotated[InventoryStage | None, Query(alias="stage")] = None,
) -> Any:
    extra = [QueryFilter("stage", "eq", stage_value.value)] if stage_value else []
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="inventory_items",
        order=_order(filters, allowed={"name", "sku", "stage", "created_at"}, default="name"),
        filters=_filters(
            filters,
            date_column=None,
            search_column="name",
            include_status=False,
            extra=extra,
        ),
    )


# Raw material purchases


@router.get(
    "/rm-purchases",
    response_model=PageResponse[RawMaterialPurchaseRecord],
    tags=["inventory"],
)
async def list_rm_purchases(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="raw_material_purchases",
        select="*,inventory_items(name,sku)",
        order=_order(filters, allowed={"purchase_date", "reference_no", "created_at"}, default="purchase_date"),
        filters=_filters(filters, date_column="purchase_date", search_column="reference_no"),
    )


@router.get(
    "/rm-purchases/{purchase_id}", response_model=RawMaterialPurchaseRecord, tags=["inventory"]
)
async def get_rm_purchase(
    purchase_id: UUID,
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> Any:
    return await _get(
        request,
        gateway,
        principal,
        source="raw_material_purchases",
        record_id=purchase_id,
        select="*,inventory_items(name,sku)",
    )


@router.post(
    "/rm-purchases",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["inventory"],
)
async def create_rm_purchase(
    body: RawMaterialPurchasePost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "rm_purchase.post", _payload(body)
    )


@router.patch(
    "/rm-purchases/{purchase_id}", response_model=MutationResponse, tags=["inventory"]
)
async def replace_rm_purchase(
    purchase_id: UUID,
    body: RawMaterialPurchasePost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "rm_purchase.replace",
        _replacement(purchase_id, body),
    )


@router.delete(
    "/rm-purchases/{purchase_id}", response_model=MutationResponse, tags=["inventory"]
)
async def reverse_rm_purchase(
    purchase_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "rm_purchase.reverse",
        _reversal(purchase_id, body),
    )


# Conversions


@router.get(
    "/conversions", response_model=PageResponse[ConversionRecord], tags=["inventory"]
)
async def list_conversions(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> Any:
    order = _order(
        filters,
        allowed={"conversion_date", "reference_no", "created_at"},
        default="conversion_date",
    )
    query_filters = _filters(
        filters,
        date_column="conversion_date",
        search_column="reference_no",
    )
    try:
        return await _list(
            request,
            gateway,
            principal,
            pagination,
            source="conversions",
            select=_CONVERSION_SELECT,
            order=order,
            filters=query_filters,
        )
    except ApiError as exc:
        if exc.code != "supabase_schema_unavailable":
            raise
        return await _list(
            request,
            gateway,
            principal,
            pagination,
            source="conversions",
            select=_CONVERSION_LEGACY_SELECT,
            order=order,
            filters=query_filters,
        )


@router.get("/conversions/{conversion_id}", response_model=ConversionRecord, tags=["inventory"])
async def get_conversion(
    conversion_id: UUID,
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> Any:
    try:
        return await _get(
            request,
            gateway,
            principal,
            source="conversions",
            record_id=conversion_id,
            select=_CONVERSION_SELECT,
        )
    except ApiError as exc:
        if exc.code != "supabase_schema_unavailable":
            raise
        return await _get(
            request,
            gateway,
            principal,
            source="conversions",
            record_id=conversion_id,
            select=_CONVERSION_LEGACY_SELECT,
        )


@router.post(
    "/conversions",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["inventory"],
)
async def create_conversion(
    body: ConversionPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "conversion.post", _payload(body)
    )


@router.patch("/conversions/{conversion_id}", response_model=MutationResponse, tags=["inventory"])
async def replace_conversion(
    conversion_id: UUID,
    body: ConversionPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "conversion.replace",
        _replacement(conversion_id, body),
    )


@router.delete("/conversions/{conversion_id}", response_model=MutationResponse, tags=["inventory"])
async def reverse_conversion(
    conversion_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "conversion.reverse",
        _reversal(conversion_id, body),
    )


# Production


@router.get("/production", response_model=PageResponse[ProductionRecord], tags=["production"])
async def list_production(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("production.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="production_runs",
        select=(
            "*,chip_item:inventory_items!production_runs_chip_item_id_fkey(name,sku),"
            "finished_item:inventory_items!production_runs_finished_item_id_fkey(name,sku),"
            "operator:employees!production_runs_operator_employee_id_fkey(name,employee_no)"
        ),
        order=_order(filters, allowed={"production_date", "reference_no", "created_at"}, default="production_date"),
        filters=_filters(filters, date_column="production_date", search_column="reference_no"),
    )


@router.get("/production/summary", response_model=ProductionSummary, tags=["production"])
async def production_summary(
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("production.read")],
    as_of: date | None = None,
) -> ProductionSummary:
    anchor = as_of or date.today()
    month_start = anchor.replace(day=1)
    recent_start = anchor - timedelta(days=6)
    range_start = min(month_start, recent_start)
    daily_rows, inventory_rows = await asyncio.gather(
        gateway.select_all(
            "production_daily_summary",
            token=principal.token,
            request_id=request.state.request_id,
            order="production_date.asc",
            filters=[
                QueryFilter("production_date", "gte", range_start.isoformat()),
                QueryFilter("production_date", "lte", anchor.isoformat()),
            ],
            max_rows=38,
        ),
        gateway.select_all(
            "inventory_stage_summary",
            token=principal.token,
            request_id=request.state.request_id,
            order="stage.asc",
            max_rows=3,
        ),
    )
    daily = [ProductionDailySummaryRecord.model_validate(row) for row in daily_rows]
    today = next((row for row in daily if row.production_date == anchor), None)
    month_rows = [row for row in daily if row.production_date >= month_start]
    empty_stage = InventoryStageSummary(
        item_count=0,
        total_quantity=Decimal("0"),
        total_value=Decimal("0"),
    )
    stages = {
        str(row.get("stage")): InventoryStageSummary.model_validate(row)
        for row in inventory_rows
        if row.get("stage") in {stage.value for stage in InventoryStage}
    }
    bulk = stages.get(InventoryStage.BULK.value, empty_stage)
    chips = stages.get(InventoryStage.CHIP.value, empty_stage)
    return ProductionSummary(
        as_of=anchor,
        month=anchor.strftime("%Y-%m"),
        today_runs=today.run_count if today else 0,
        today_input_kg=today.input_kg if today else Decimal("0"),
        today_output_quantity=today.output_quantity if today else Decimal("0"),
        month_runs=sum(row.run_count for row in month_rows),
        month_input_kg=sum((row.input_kg for row in month_rows), Decimal("0")),
        month_output_quantity=sum(
            (row.output_quantity for row in month_rows), Decimal("0")
        ),
        bulk_item_count=bulk.item_count,
        chip_item_count=chips.item_count,
        bulk_value=bulk.total_value,
        chip_value=chips.total_value,
        recent_daily=[row for row in daily if row.production_date >= recent_start],
    )


@router.get("/production/{production_id}", response_model=ProductionRecord, tags=["production"])
async def get_production(
    production_id: UUID,
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("production.read")],
) -> Any:
    return await _get(
        request,
        gateway,
        principal,
        source="production_runs",
        record_id=production_id,
        select=(
            "*,chip_item:inventory_items!production_runs_chip_item_id_fkey(name,sku),"
            "finished_item:inventory_items!production_runs_finished_item_id_fkey(name,sku),"
            "operator:employees!production_runs_operator_employee_id_fkey(name,employee_no)"
        ),
    )


@router.post(
    "/production",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["production"],
)
async def create_production(
    body: ProductionPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("production.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "production.post", _payload(body)
    )


@router.patch("/production/{production_id}", response_model=MutationResponse, tags=["production"])
async def replace_production(
    production_id: UUID,
    body: ProductionPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("production.write")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "production.replace",
        _replacement(production_id, body),
    )


@router.delete("/production/{production_id}", response_model=MutationResponse, tags=["production"])
async def reverse_production(
    production_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("production.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "production.reverse",
        _reversal(production_id, body),
    )


# Sales and receipts


@router.get("/sales-outstanding", response_model=PageResponse[GenericRecord], tags=["sales"])
async def sales_outstanding(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("sales.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="sales_outstanding",
        order=_order(filters, allowed={"sale_date", "invoice_no", "balance_due"}, default="sale_date"),
        filters=_filters(
            filters, date_column="sale_date", search_column="invoice_no", include_status=False
        ),
    )


@router.get("/sales", response_model=PageResponse[SaleRecord], tags=["sales"])
async def list_sales(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("sales.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="sales",
        select=_SALE_SELECT,
        order=_order(filters, allowed={"sale_date", "invoice_no", "reference_no", "created_at"}, default="sale_date"),
        filters=_filters(filters, date_column="sale_date", search_column="invoice_no"),
    )


@router.get("/sales/{sale_id}", response_model=SaleRecord, tags=["sales"])
async def get_sale(
    sale_id: UUID,
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("sales.read")],
) -> Any:
    return await _get(
        request,
        gateway,
        principal,
        source="sales",
        record_id=sale_id,
        select=_SALE_SELECT,
    )


@router.post(
    "/sales",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["sales"],
)
async def create_sale(
    body: SalePost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("sales.write")],
) -> MutationResponse:
    return await _execute(request, gateway, principal, idempotency_key, "sale.post", _payload(body))


@router.patch("/sales/{sale_id}", response_model=MutationResponse, tags=["sales"])
async def replace_sale(
    sale_id: UUID,
    body: SalePost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("sales.write")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "sale.replace",
        _replacement(sale_id, body),
    )


@router.delete("/sales/{sale_id}", response_model=MutationResponse, tags=["sales"])
async def reverse_sale(
    sale_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("sales.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "sale.reverse", _reversal(sale_id, body)
    )


@router.get("/sales/{sale_id}/payments", response_model=PageResponse[PaymentRecord], tags=["sales"])
async def list_sale_payments(
    sale_id: UUID,
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("sales.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="sale_payments",
        order=_order(filters, allowed={"payment_date", "reference_no", "created_at"}, default="payment_date"),
        filters=_filters(
            filters,
            date_column="payment_date",
            search_column="reference_no",
            extra=[QueryFilter("sale_id", "eq", str(sale_id))],
        ),
    )


@router.post(
    "/sales/{sale_id}/payments",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["sales"],
)
async def create_sale_payment(
    sale_id: UUID,
    body: SalePaymentPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("sales.write")],
) -> MutationResponse:
    _ensure_parent(body.sale_id, sale_id, "sale_id")
    payload = _payload(body)
    payload["sale_id"] = str(sale_id)
    return await _execute(
        request, gateway, principal, idempotency_key, "sale_payment.post", payload
    )


@router.delete(
    "/sales/{sale_id}/payments/{payment_id}", response_model=MutationResponse, tags=["sales"]
)
async def reverse_sale_payment(
    sale_id: UUID,
    payment_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("sales.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    del sale_id  # Parent path documents ownership; SQL validates the payment's actual sale.
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "sale_payment.reverse",
        _reversal(payment_id, body),
    )


# Payroll and payroll payments


@router.get("/payroll-outstanding", response_model=PageResponse[GenericRecord], tags=["payroll"])
async def payroll_outstanding(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("payroll.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="payroll_outstanding",
        order=_order(filters, allowed={"payroll_date", "salary_month", "balance_due"}, default="payroll_date"),
        filters=_filters(
            filters, date_column="payroll_date", search_column="reference_no", include_status=False
        ),
    )


@router.get("/payroll", response_model=PageResponse[PayrollRecord], tags=["payroll"])
async def list_payroll(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("payroll.read")],
    employee_id: UUID | None = None,
) -> Any:
    extra = [QueryFilter("employee_id", "eq", str(employee_id))] if employee_id else []
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="payrolls",
        select=_PAYROLL_SELECT,
        order=_order(filters, allowed={"payroll_date", "salary_month", "reference_no", "created_at"}, default="payroll_date"),
        filters=_filters(
            filters,
            date_column="payroll_date",
            search_column="reference_no",
            extra=extra,
        ),
    )


@router.get("/payroll/{payroll_id}", response_model=PayrollRecord, tags=["payroll"])
async def get_payroll(
    payroll_id: UUID,
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("payroll.read")],
) -> Any:
    return await _get(
        request,
        gateway,
        principal,
        source="payrolls",
        record_id=payroll_id,
        select=_PAYROLL_SELECT,
    )


@router.post(
    "/payroll",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["payroll"],
)
async def create_payroll(
    body: PayrollPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("payroll.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "payroll.post", _payload(body)
    )


@router.patch("/payroll/{payroll_id}", response_model=MutationResponse, tags=["payroll"])
async def replace_payroll(
    payroll_id: UUID,
    body: PayrollPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("payroll.write")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "payroll.replace",
        _replacement(payroll_id, body),
    )


@router.delete("/payroll/{payroll_id}", response_model=MutationResponse, tags=["payroll"])
async def reverse_payroll(
    payroll_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("payroll.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "payroll.reverse",
        _reversal(payroll_id, body),
    )


@router.get(
    "/payroll/{payroll_id}/payments",
    response_model=PageResponse[PaymentRecord],
    tags=["payroll"],
)
async def list_payroll_payments(
    payroll_id: UUID,
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("payroll.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="payroll_payments",
        order=_order(filters, allowed={"payment_date", "reference_no", "created_at"}, default="payment_date"),
        filters=_filters(
            filters,
            date_column="payment_date",
            search_column="reference_no",
            extra=[QueryFilter("payroll_id", "eq", str(payroll_id))],
        ),
    )


@router.post(
    "/payroll/{payroll_id}/payments",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["payroll"],
)
async def create_payroll_payment(
    payroll_id: UUID,
    body: PayrollPaymentPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("payroll.write")],
) -> MutationResponse:
    _ensure_parent(body.payroll_id, payroll_id, "payroll_id")
    payload = _payload(body)
    payload["payroll_id"] = str(payroll_id)
    return await _execute(
        request, gateway, principal, idempotency_key, "payroll_payment.post", payload
    )


@router.delete(
    "/payroll/{payroll_id}/payments/{payment_id}",
    response_model=MutationResponse,
    tags=["payroll"],
)
async def reverse_payroll_payment(
    payroll_id: UUID,
    payment_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("payroll.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    del payroll_id
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "payroll_payment.reverse",
        _reversal(payment_id, body),
    )


# Adjustments


@router.get(
    "/adjustments", response_model=PageResponse[AdjustmentRecord], tags=["inventory"]
)
async def list_adjustments(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("inventory.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="stock_adjustments",
        order=_order(filters, allowed={"adjustment_date", "reference_no", "created_at"}, default="adjustment_date"),
        filters=_filters(filters, date_column="adjustment_date", search_column="reference_no"),
    )


@router.post(
    "/adjustments",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["inventory"],
)
async def create_adjustment(
    body: AdjustmentPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "adjustment.post", _payload(body)
    )


@router.patch("/adjustments/{adjustment_id}", response_model=MutationResponse, tags=["inventory"])
async def replace_adjustment(
    adjustment_id: UUID,
    body: AdjustmentPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "adjustment.replace",
        _replacement(adjustment_id, body),
    )


@router.delete("/adjustments/{adjustment_id}", response_model=MutationResponse, tags=["inventory"])
async def reverse_adjustment(
    adjustment_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("inventory.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "adjustment.reverse",
        _reversal(adjustment_id, body),
    )


# Finance and reports


@router.get("/journals", response_model=PageResponse[JournalRecord], tags=["finance"])
async def list_journals(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("finance.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="journal_entries",
        select="*,journal_lines(*)",
        order=_order(filters, allowed={"journal_date", "reference_no", "created_at"}, default="journal_date"),
        filters=_filters(filters, date_column="journal_date", search_column="reference_no"),
    )


@router.get("/journals/{journal_id}", response_model=JournalRecord, tags=["finance"])
async def get_journal(
    journal_id: UUID,
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("finance.read")],
) -> Any:
    return await _get(
        request,
        gateway,
        principal,
        source="journal_entries",
        record_id=journal_id,
        select="*,journal_lines(*)",
    )


@router.post(
    "/journals",
    response_model=MutationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["finance"],
)
async def create_journal(
    body: JournalPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("finance.write")],
) -> MutationResponse:
    return await _execute(
        request, gateway, principal, idempotency_key, "journal.post", _payload(body)
    )


@router.patch("/journals/{journal_id}", response_model=MutationResponse, tags=["finance"])
async def replace_journal(
    journal_id: UUID,
    body: JournalPost,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("finance.write")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "journal.replace",
        _replacement(journal_id, body),
    )


@router.delete("/journals/{journal_id}", response_model=MutationResponse, tags=["finance"])
async def reverse_journal(
    journal_id: UUID,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("finance.write")],
    body: Annotated[ReverseRequest | None, Body()] = None,
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "journal.reverse",
        _reversal(journal_id, body),
    )


@router.get("/ledger", response_model=PageResponse[LedgerLineRecord], tags=["finance"])
async def ledger(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("finance.read")],
    journal_entry_id: UUID | None = None,
    year: Annotated[int | None, Query(ge=2000, le=2200)] = None,
    month: Annotated[str | None, Query(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])$")] = None,
    source_type: Annotated[str | None, Query(pattern=r"^[a-z_.]+$")] = None,
    category: Annotated[str | None, Query(pattern=r"^(asset|liability|equity|revenue|expense)$")] = None,
) -> Any:
    extra: list[QueryFilter] = []
    if journal_entry_id:
        extra.append(QueryFilter("journal_entry_id", "eq", str(journal_entry_id)))
    if source_type:
        extra.append(QueryFilter("source_type", "eq", source_type))
    if category:
        extra.append(QueryFilter("category", "eq", category))
    if month:
        month_start = date.fromisoformat(f"{month}-01")
        next_month = (
            date(month_start.year + 1, 1, 1)
            if month_start.month == 12
            else date(month_start.year, month_start.month + 1, 1)
        )
        extra.extend(
            [
                QueryFilter("entry_date", "gte", month_start.isoformat()),
                QueryFilter("entry_date", "lt", next_month.isoformat()),
            ]
        )
    elif year is not None:
        extra.extend(
            [
                QueryFilter("entry_date", "gte", f"{year}-01-01"),
                QueryFilter("entry_date", "lte", f"{year}-12-31"),
            ]
        )
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="ledger_view",
        order=_order(
            filters,
            allowed={"entry_date", "created_at", "line_no", "debit", "credit"},
            default="entry_date",
        ),
        filters=_filters(
            filters,
            date_column="entry_date",
            search_column="search_text",
            include_status=False,
            extra=extra,
        ),
    )


@router.get(
    "/account-balances",
    response_model=PageResponse[AccountBalanceRecord],
    tags=["finance"],
)
async def account_balances(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("finance.read")],
    year: Annotated[int | None, Query(ge=2000, le=2200)] = None,
) -> Any:
    extra = [QueryFilter("fiscal_year", "eq", year)] if year is not None else []
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="account_balances_by_year" if year is not None else "account_balances",
        order=_order(filters, allowed={"account_code", "account_name", "category", "balance"}, default="account_code"),
        filters=_filters(
            filters,
            date_column=None,
            search_column="account_name",
            include_status=False,
            extra=extra,
        ),
    )


@router.get("/reports/inventory", response_model=PageResponse[InventoryPositionRecord], tags=["reports"])
async def inventory_report(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("reports.read")],
    stage_value: Annotated[InventoryStage | None, Query(alias="stage")] = None,
) -> Any:
    extra = [QueryFilter("stage", "eq", stage_value.value)] if stage_value else []
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="inventory_position",
        order=_order(filters, allowed={"item_name", "stage", "quantity_on_hand", "inventory_value"}, default="item_name"),
        filters=_filters(
            filters,
            date_column=None,
            search_column="item_name",
            include_status=False,
            extra=extra,
        ),
    )


@router.get("/reports/sales", response_model=PageResponse[SaleRecord], tags=["reports"])
async def sales_report(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("reports.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="sales",
        select=_SALE_SELECT,
        order=_order(filters, allowed={"sale_date", "invoice_no", "total_amount"}, default="sale_date"),
        filters=_filters(filters, date_column="sale_date", search_column="invoice_no"),
    )


@router.get("/reports/payroll", response_model=PageResponse[PayrollRecord], tags=["reports"])
async def payroll_report(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("reports.read")],
    salary_month: Annotated[
        str | None, Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    ] = None,
) -> Any:
    extra = (
        [QueryFilter("salary_month", "eq", salary_month)] if salary_month else []
    )
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="payrolls",
        select=_PAYROLL_SELECT,
        order=_order(filters, allowed={"payroll_date", "salary_month", "net_pay"}, default="payroll_date"),
        filters=_filters(
            filters,
            date_column="payroll_date",
            search_column="reference_no",
            extra=extra,
        ),
    )


@router.get("/reports/ledger", response_model=PageResponse[LedgerLineRecord], tags=["reports"])
async def ledger_report(
    request: Request,
    gateway: Gateway,
    pagination: PageParams,
    filters: CollectionQuery,
    principal: Annotated[Principal, _principal("reports.read")],
) -> Any:
    return await _list(
        request,
        gateway,
        principal,
        pagination,
        source="journal_lines",
        select="*,journal_entries(*),accounts(*)",
        order=_order(filters, allowed={"created_at", "line_no", "debit", "credit"}, default="created_at"),
        filters=_filters(
            filters,
            date_column=None,
            search_column="description",
            include_status=False,
        ),
    )


@router.get(
    "/reports/financial-summary", response_model=DashboardResponse, tags=["reports"]
)
async def financial_summary_report(
    request: Request,
    gateway: Gateway,
    principal: Annotated[Principal, _principal("reports.read")],
    year: Annotated[int | None, Query(ge=2000, le=2200)] = None,
) -> dict[str, Any]:
    return await gateway.dashboard(
        year,
        token=principal.token,
        request_id=request.state.request_id,
    )


# System administration


@router.post(
    "/admin/purge-business-data",
    response_model=MutationResponse,
    tags=["administration"],
)
async def purge_business_data(
    body: PurgeBusinessDataRequest,
    request: Request,
    gateway: Gateway,
    idempotency_key: IdempotencyKey,
    principal: Annotated[Principal, _principal("system.admin")],
) -> MutationResponse:
    return await _execute(
        request,
        gateway,
        principal,
        idempotency_key,
        "system.purge_business_data",
        _payload(body),
    )
