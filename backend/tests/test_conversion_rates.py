from __future__ import annotations

from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.dependencies import Principal, get_gateway, get_principal
from app.main import create_app
from app.models import (
    CompanyAccess,
    ConversionWorkerInput,
    MutationResponse,
    PieceworkRateUpsert,
    ProfileAccess,
)
from app.supabase import SupabaseGateway

COMPANY_ID = UUID("10000000-0000-0000-0000-000000000001")


def settings() -> Settings:
    return Settings(
        _env_file=None,
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="sb_publishable_test_key_1234567890",
        trusted_hosts=["testserver", "localhost", "127.0.0.1"],
    )


def principal(*permissions: str) -> Principal:
    user_id = UUID("00000000-0000-0000-0000-000000000001")
    company = CompanyAccess(
        company_id=COMPANY_ID,
        code="CK",
        name="CK Plastics",
        is_primary=True,
        role_codes=["operations"],
        permission_codes=list(permissions),
    )
    return Principal(
        user_id=user_id,
        token="test-token",
        claims={"sub": str(user_id)},
        profile=ProfileAccess(
            user_id=user_id,
            display_name="Operations user",
            is_active=True,
            companies=[company],
        ),
        company_id=company.company_id,
        company=company,
    )


class MutationGateway:
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
        company_id: UUID | str,
    ) -> MutationResponse:
        self.calls.append(
            {
                "operation": operation,
                "payload": payload,
                "idempotency_key": idempotency_key,
                "token": token,
                "request_id": request_id,
                "company_id": str(company_id),
            }
        )
        return MutationResponse(
            ok=True,
            operation=operation,
            id=UUID("00000000-0000-0000-0000-000000000010"),
        )


def test_saved_rate_can_supply_task_and_amount_snapshot() -> None:
    linked = ConversionWorkerInput.model_validate(
        {
            "employee_id": "00000000-0000-0000-0000-000000000002",
            "rate_id": "00000000-0000-0000-0000-000000000003",
            "quantity_kg": 12.5,
        }
    )
    assert linked.task is None
    assert linked.rate_per_kg is None

    with pytest.raises(ValidationError, match="manual worker allocation"):
        ConversionWorkerInput.model_validate(
            {
                "employee_id": "00000000-0000-0000-0000-000000000002",
                "quantity_kg": 12.5,
            }
        )


def test_piecework_rate_accepts_conversion_type_without_duplicate_label() -> None:
    rate = PieceworkRateUpsert.model_validate(
        {
            "conversion_type_id": "00000000-0000-0000-0000-000000000004",
            "rate_per_kg": "8.50",
            "effective_from": "2026-09-21",
        }
    )
    assert rate.work_type is None
    assert rate.conversion_type_id == UUID("00000000-0000-0000-0000-000000000004")


@pytest.mark.asyncio
async def test_operations_user_can_create_conversion_rate() -> None:
    gateway = MutationGateway()
    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: gateway
    app.dependency_overrides[get_principal] = lambda: principal("inventory.write")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/api/v1/piecework-rates",
            headers={"Idempotency-Key": "conversion-rate-001"},
            json={
                "conversion_type_id": "00000000-0000-0000-0000-000000000004",
                "rate_per_kg": 8.5,
                "effective_from": "2026-09-21",
            },
        )

    assert response.status_code == 201, response.text
    assert gateway.calls[0]["operation"] == "piecework_rate.upsert"
    assert gateway.calls[0]["payload"]["conversion_type_id"] == (
        "00000000-0000-0000-0000-000000000004"
    )


@pytest.mark.asyncio
async def test_conversion_type_list_is_an_allowed_gateway_source() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/rest/v1/conversion_types"
        assert request.url.params["order"] == "name.asc,id.asc"
        return httpx.Response(
            200,
            json=[
                {
                    "id": "00000000-0000-0000-0000-000000000004",
                    "name": "PP",
                    "default_chip_name": "PP Chips",
                    "status": "active",
                }
            ],
            headers={"content-range": "0-0/1"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        gateway = SupabaseGateway(settings(), upstream)
        app = create_app(settings())
        app.dependency_overrides[get_gateway] = lambda: gateway
        app.dependency_overrides[get_principal] = lambda: principal("inventory.read")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            response = await client.get(
                "/api/v1/conversion-types",
                params={"descending": "false"},
            )

    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["default_chip_name"] == "PP Chips"


@pytest.mark.asyncio
async def test_piecework_rates_fall_back_to_legacy_select_when_type_link_is_missing() -> None:
    selects: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/rest/v1/piecework_rates"
        select = request.url.params["select"]
        selects.append(select)
        if "conversion_type:" in select:
            return httpx.Response(
                400,
                json={
                    "code": "PGRST200",
                    "message": "Could not find the requested relationship in the schema cache",
                },
            )
        return httpx.Response(
            200,
            json=[{
                "id": "00000000-0000-0000-0000-000000000004",
                "work_type": "Legacy cut",
                "rate_per_kg": 8.5,
                "effective_from": "2026-09-01",
                "effective_to": None,
                "status": "active",
            }],
            headers={"content-range": "0-0/1"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        gateway = SupabaseGateway(settings(), upstream)
        app = create_app(settings())
        app.dependency_overrides[get_gateway] = lambda: gateway
        app.dependency_overrides[get_principal] = lambda: principal("inventory.read")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            response = await client.get(
                "/api/v1/piecework-rates",
                params={"descending": "false"},
            )

    assert response.status_code == 200, response.text
    assert selects == [
        "*,conversion_type:conversion_types!piecework_rates_conversion_type_id_fkey(id,name,default_chip_name,status)",
        "*",
    ]
    assert response.json()["items"][0]["work_type"] == "Legacy cut"


@pytest.mark.asyncio
async def test_conversions_fall_back_to_legacy_select_when_type_link_is_missing() -> None:
    selects: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/rest/v1/conversions"
        select = request.url.params["select"]
        selects.append(select)
        if "conversion_type:" in select:
            return httpx.Response(
                400,
                json={
                    "code": "PGRST200",
                    "message": "Could not find the requested relationship in the schema cache",
                },
            )
        return httpx.Response(
            200,
            json=[{
                "id": "00000000-0000-0000-0000-000000000020",
                "reference_no": "CV-0001",
                "conversion_date": "2026-09-21",
                "source_item_id": "00000000-0000-0000-0000-000000000021",
                "output_item_id": "00000000-0000-0000-0000-000000000022",
                "input_kg": 100,
                "output_kg": 95,
                "status": "posted",
                "conversion_workers": [],
                "source_item": {"name": "Bulk rubber", "sku": "RM-01"},
                "output_item": {"name": "Rubber chip", "sku": "CH-01"},
            }],
            headers={"content-range": "0-0/1"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        gateway = SupabaseGateway(settings(), upstream)
        app = create_app(settings())
        app.dependency_overrides[get_gateway] = lambda: gateway
        app.dependency_overrides[get_principal] = lambda: principal("inventory.read")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            response = await client.get("/api/v1/conversions")

    assert response.status_code == 200, response.text
    assert len(selects) == 2
    assert "conversion_type:" in selects[0]
    assert "conversion_type:" not in selects[1]
    assert response.json()["items"][0]["source_item_name"] == "Bulk rubber"
