from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.dependencies import Principal, get_gateway, get_principal
from app.errors import ApiError
from app.main import create_app
from app.models import MutationResponse, ProfileAccess, PurgeBusinessDataRequest
from app.routes import production_summary
from app.supabase import QueryFilter, SupabaseGateway


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "supabase_url": "https://example.supabase.co",
        "supabase_publishable_key": "sb_publishable_test_key_1234567890",
        "trusted_hosts": ["testserver", "localhost", "127.0.0.1"],
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_settings_reject_secret_keys() -> None:
    with pytest.raises(ValidationError, match="publishable"):
        settings(supabase_publishable_key="sb_secret_test_key_1234567890")


def test_purge_request_requires_exact_phrase_and_acknowledgement() -> None:
    with pytest.raises(ValidationError):
        PurgeBusinessDataRequest(
            confirmation="delete all business data",  # type: ignore[arg-type]
            acknowledge_irreversible=True,
        )
    with pytest.raises(ValidationError):
        PurgeBusinessDataRequest(
            confirmation="DELETE ALL BUSINESS DATA",
            acknowledge_irreversible=False,  # type: ignore[arg-type]
        )


class PurgeGateway:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def execute(
        self,
        operation: str,
        payload: dict[str, Any],
        idempotency_key: str,
        *,
        token: str,
        request_id: str,
    ) -> MutationResponse:
        self.calls.append(
            {
                "operation": operation,
                "payload": payload,
                "idempotency_key": idempotency_key,
                "token": token,
                "request_id": request_id,
            }
        )
        return MutationResponse(ok=True, operation=operation, id=None)


def principal(*permissions: str) -> Principal:
    user_id = UUID("00000000-0000-0000-0000-000000000001")
    return Principal(
        user_id=user_id,
        token="test-token",
        claims={"sub": str(user_id)},
        profile=ProfileAccess(
            user_id=user_id,
            display_name="Test administrator",
            is_active=True,
            role_codes=["admin"],
            permission_codes=list(permissions),
        ),
    )


@pytest.mark.asyncio
async def test_admin_can_request_atomic_business_data_purge() -> None:
    gateway = PurgeGateway()
    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: gateway
    app.dependency_overrides[get_principal] = lambda: principal("system.admin")
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/v1/admin/purge-business-data",
            headers={
                "Idempotency-Key": "purge-request-001",
                "X-Request-ID": "purge-test-request",
            },
            json={
                "confirmation": "DELETE ALL BUSINESS DATA",
                "acknowledge_irreversible": True,
            },
        )

    assert response.status_code == 200
    assert response.json()["operation"] == "system.purge_business_data"
    assert gateway.calls == [
        {
            "operation": "system.purge_business_data",
            "payload": {
                "confirmation": "DELETE ALL BUSINESS DATA",
                "acknowledge_irreversible": True,
            },
            "idempotency_key": "purge-request-001",
            "token": "test-token",
            "request_id": "purge-test-request",
        }
    ]


@pytest.mark.asyncio
async def test_non_admin_cannot_request_business_data_purge() -> None:
    gateway = PurgeGateway()
    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: gateway
    app.dependency_overrides[get_principal] = lambda: principal("dashboard.read")
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/v1/admin/purge-business-data",
            headers={"Idempotency-Key": "purge-request-002"},
            json={
                "confirmation": "DELETE ALL BUSINESS DATA",
                "acknowledge_irreversible": True,
            },
        )

    assert response.status_code == 403
    assert response.json()["code"] == "permission_denied"
    assert gateway.calls == []


@pytest.mark.asyncio
async def test_liveness_has_request_and_security_headers() -> None:
    app = create_app(settings())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(
            "/api/v1/health/live",
            headers={"X-Request-ID": "test-request-123"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.headers["x-request-id"] == "test-request-123"
    assert "no-store" in response.headers["cache-control"]
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_page_query_keeps_both_date_bounds() -> None:
    captured: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.extend(request.url.params.multi_items())
        return httpx.Response(
            200,
            json=[{"id": "00000000-0000-0000-0000-000000000001", "sale_date": "2026-09-16"}],
            headers={"content-range": "0-0/1"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        page = await gateway.select_page(
            "sales",
            token="test-token",
            request_id="test-request",
            page=1,
            page_size=25,
            order="sale_date.desc",
            filters=[
                QueryFilter("sale_date", "gte", "2026-01-01"),
                QueryFilter("sale_date", "lte", "2026-12-31"),
            ],
        )

    assert page.total == 1
    assert [(key, value) for key, value in captured if key == "sale_date"] == [
        ("sale_date", "gte.2026-01-01"),
        ("sale_date", "lte.2026-12-31"),
    ]


@pytest.mark.asyncio
async def test_schema_health_accepts_an_existing_protected_contract() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"code": "42501", "message": "permission denied for table current_user_access"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        result = await gateway.schema_health()

    assert result == {"status": "protected"}


@pytest.mark.asyncio
async def test_schema_health_rejects_a_missing_contract() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={
                "code": "PGRST205",
                "message": "Could not find the table 'public.current_user_access' in the schema cache",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        with pytest.raises(ApiError) as caught:
            await gateway.schema_health()

    assert caught.value.status_code == 503
    assert caught.value.code == "supabase_schema_unavailable"


@pytest.mark.asyncio
async def test_missing_postgrest_relationship_is_reported_as_schema_unavailable() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "code": "PGRST200",
                "message": "Could not find a relationship in the schema cache",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        with pytest.raises(ApiError) as caught:
            await gateway.select_page(
                "piecework_rates",
                token="test-token",
                request_id="test-request",
                page=1,
                page_size=25,
                select="*,conversion_type:conversion_types(id)",
                order="effective_from.desc",
            )

    assert caught.value.status_code == 503
    assert caught.value.code == "supabase_schema_unavailable"
    assert "migrations" in caught.value.detail


@pytest.mark.asyncio
async def test_cursor_pagination_is_stable_and_query_bound() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        rows = [
            {"id": "00000000-0000-0000-0000-000000000003", "sale_date": "2026-09-16"},
            {"id": "00000000-0000-0000-0000-000000000002", "sale_date": "2026-09-16"},
            {"id": "00000000-0000-0000-0000-000000000001", "sale_date": "2026-09-15"},
        ]
        return httpx.Response(200, json=rows, headers={"content-range": "0-2/30"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        first = await gateway.select_page(
            "sales",
            token="test-token",
            request_id="test-request",
            page=1,
            page_size=2,
            order="sale_date.desc",
            pagination_mode="cursor",
        )
        assert first.next_cursor
        second = await gateway.select_page(
            "sales",
            token="test-token",
            request_id="test-request",
            page=1,
            page_size=2,
            order="sale_date.desc",
            pagination_mode="cursor",
            cursor=first.next_cursor,
        )
        with pytest.raises(ApiError, match="does not match"):
            await gateway.select_page(
                "sales",
                token="test-token",
                request_id="test-request",
                page=1,
                page_size=2,
                order="sale_date.desc",
                filters=[QueryFilter("status", "eq", "posted")],
                pagination_mode="cursor",
                cursor=first.next_cursor,
            )

    assert first.has_more is True
    assert first.page == 1
    assert second.page == 2
    assert requests[1].url.params.get("or") == (
        '(sale_date.lt."2026-09-16",and(sale_date.eq."2026-09-16",'
        'id.lt."00000000-0000-0000-0000-000000000002"))'
    )


@pytest.mark.asyncio
async def test_production_summary_aggregates_bounded_database_rows() -> None:
    class SummaryGateway:
        async def select_all(self, source: str, **_: Any) -> list[dict[str, Any]]:
            if source == "production_daily_summary":
                return [
                    {
                        "production_date": "2026-09-15",
                        "run_count": 2,
                        "input_kg": "20.5",
                        "output_quantity": "18",
                        "total_cost": "500",
                    },
                    {
                        "production_date": "2026-09-16",
                        "run_count": 3,
                        "input_kg": "31",
                        "output_quantity": "28.25",
                        "total_cost": "750",
                    },
                ]
            assert source == "inventory_stage_summary"
            return [
                {"stage": "bulk", "item_count": 7, "total_quantity": "100", "total_value": "900"},
                {"stage": "chip", "item_count": 4, "total_quantity": "50", "total_value": "600"},
                {"stage": "finished", "item_count": 9, "total_quantity": "45", "total_value": "1200"},
            ]

    request = SimpleNamespace(state=SimpleNamespace(request_id="summary-test"))
    principal = SimpleNamespace(token="test-token")
    result = await production_summary(
        request,  # type: ignore[arg-type]
        SummaryGateway(),  # type: ignore[arg-type]
        principal,  # type: ignore[arg-type]
        date(2026, 9, 16),
    )

    assert result.today_runs == 3
    assert result.today_output_quantity == 28.25
    assert result.month_runs == 5
    assert result.month_output_quantity == 46.25
    assert result.bulk_item_count == 7
    assert result.chip_item_count == 4
    assert result.bulk_value + result.chip_value == 1500
    assert len(result.recent_daily) == 2

@pytest.mark.asyncio
@pytest.mark.parametrize('endpoint,permission', [
    ('/api/v1/payroll', 'payroll.read'),
    ('/api/v1/reports/payroll', 'reports.read'),
    ('/api/v1/payroll/00000000-0000-0000-0000-000000000002', 'payroll.read'),
])
async def test_payroll_reads_work_without_optional_employee_department(endpoint: str, permission: str) -> None:
    payroll_id = '00000000-0000-0000-0000-000000000002'
    row = {
        'id': payroll_id, 'reference_no': 'PAY-001', 'payroll_date': '2026-09-21',
        'salary_month': '2026-09', 'employee_id': '00000000-0000-0000-0000-000000000003',
        'status': 'posted', 'net_pay': '1200.00', 'payroll_details': [], 'payroll_payments': [],
        'employee': {'id': '00000000-0000-0000-0000-000000000003', 'name': 'Test Employee'},
    }
    def handler(request: httpx.Request) -> httpx.Response:
        select = request.url.params['select']
        # Reproduce the connected database: the optional profile migration is absent.
        if 'department' in select:
            return httpx.Response(400, json={'code': '42703', 'message': 'column employees_1.department does not exist'})
        assert 'employee:employees!payrolls_employee_id_fkey(' in select
        assert 'employee_epf_rate' not in select and 'department' not in select
        assert all(field in select for field in ('employee_no', 'name', 'nic', 'epf_no', 'etf_ref'))
        assert 'payroll_details(*)' in select and 'payroll_payments(*)' in select
        return httpx.Response(200, json=[row], headers={'content-range': '0-0/1'})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        gateway = SupabaseGateway(settings(), upstream)
        app = create_app(settings())
        app.dependency_overrides[get_gateway] = lambda: gateway
        app.dependency_overrides[get_principal] = lambda: principal(permission)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
            response = await client.get(endpoint)
    assert response.status_code == 200, response.text
    payload = response.json()
    result = payload if endpoint.endswith(payroll_id) else payload['items'][0]
    assert result['employee']['name'] == 'Test Employee'
    assert result['net_pay'] == '1200.00'


@pytest.mark.asyncio
async def test_payroll_report_filters_by_salary_month() -> None:
    captured: list[tuple[str, str]] = []
    row = {
        'id': '00000000-0000-0000-0000-000000000002',
        'reference_no': 'PAY-001',
        'payroll_date': '2026-10-01',
        'salary_month': '2026-09',
        'employee_id': '00000000-0000-0000-0000-000000000003',
        'status': 'posted',
        'payroll_details': [],
        'payroll_payments': [],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        captured.extend(request.url.params.multi_items())
        return httpx.Response(200, json=[row], headers={'content-range': '0-0/1'})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        gateway = SupabaseGateway(settings(), upstream)
        app = create_app(settings())
        app.dependency_overrides[get_gateway] = lambda: gateway
        app.dependency_overrides[get_principal] = lambda: principal('reports.read')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
            response = await client.get('/api/v1/reports/payroll?salary_month=2026-09')

    assert response.status_code == 200, response.text
    assert ('salary_month', 'eq.2026-09') in captured


@pytest.mark.asyncio
async def test_overtime_list_uses_the_overtime_read_model() -> None:
    captured_path = ""
    captured_params: list[tuple[str, str]] = []
    row = {
        "id": "00000000-0000-0000-0000-000000000010",
        "reference_no": "OT-001",
        "employee_id": "00000000-0000-0000-0000-000000000003",
        "employee_no": "EMP-003",
        "employee_name": "Test Employee",
        "work_date": "2026-09-22",
        "hours": "2.50",
        "rate": "750.00",
        "amount": "1875.00",
        "status": "posted",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_path
        captured_path = request.url.path
        captured_params.extend(request.url.params.multi_items())
        return httpx.Response(200, json=[row], headers={"content-range": "0-0/1"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        gateway = SupabaseGateway(settings(), upstream)
        app = create_app(settings())
        app.dependency_overrides[get_gateway] = lambda: gateway
        app.dependency_overrides[get_principal] = lambda: principal("employees.read")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.get(
                "/api/v1/overtime?employee_id=00000000-0000-0000-0000-000000000003"
                "&from_date=2026-09-01&to_date=2026-09-30"
            )

    assert response.status_code == 200, response.text
    assert captured_path.endswith("/rest/v1/overtime_work_view")
    assert ("employee_id", "eq.00000000-0000-0000-0000-000000000003") in captured_params
    assert ("work_date", "gte.2026-09-01") in captured_params
    assert response.json()["items"][0]["amount"] == "1875.00"


@pytest.mark.asyncio
async def test_overtime_post_reaches_the_audited_operation() -> None:
    gateway = PurgeGateway()
    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: gateway
    app.dependency_overrides[get_principal] = lambda: principal("employees.write")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/v1/overtime",
            headers={"Idempotency-Key": "ot-create-001"},
            json={
                "employee_id": "00000000-0000-0000-0000-000000000003",
                "work_date": "2026-09-22",
                "hours": 2.5,
                "rate": 750,
                "notes": "Month-end packing",
            },
        )

    assert response.status_code == 201, response.text
    assert gateway.calls[0]["operation"] == "overtime.upsert"
    assert gateway.calls[0]["payload"]["hours"] == "2.5"
