from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.dependencies import (
    Principal,
    get_gateway,
    get_principal,
    get_verified_token,
    require_any_permission,
    require_permission,
    resolve_company_access,
)
from app.errors import ApiError
from app.main import create_app
from app.models import CompanyAccess, MutationResponse, PageResponse, ProfileAccess, PurgeBusinessDataRequest
from app.routes import production_summary
from app.security import VerifiedToken
from app.supabase import QueryFilter, SupabaseGateway

COMPANY_ID = UUID("10000000-0000-0000-0000-000000000001")
OTHER_COMPANY_ID = UUID("20000000-0000-0000-0000-000000000002")


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


@pytest.mark.asyncio
async def test_auth_account_creation_requires_server_secret_key() -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))) as client:
        gateway = SupabaseGateway(settings(), client)
        with pytest.raises(ApiError) as caught:
            await gateway.create_auth_user(
                email="new.user@example.com",
                password="Strong-password-1!",
                display_name="New User",
                request_id="create-user-missing-secret",
            )

    assert caught.value.status_code == 503
    assert caught.value.code == "auth_admin_not_configured"
    assert "SUPABASE_SECRET_KEY" in caught.value.detail


@pytest.mark.asyncio
async def test_auth_account_creation_maps_duplicate_email_safely() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/auth/v1/admin/users")
        assert request.headers["apikey"].startswith("sb_secret_")
        assert "authorization" not in request.headers
        return httpx.Response(
            422,
            json={"code": "email_exists", "message": "User already registered"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(
            settings(supabase_secret_key="sb_secret_test_key_1234567890"),
            client,
        )
        with pytest.raises(ApiError) as caught:
            await gateway.create_auth_user(
                email="existing@example.com",
                password="Strong-password-1!",
                display_name="Existing User",
                request_id="create-user-duplicate",
            )

    assert caught.value.status_code == 409
    assert caught.value.code == "account_email_exists"
    assert caught.value.detail == "A login account already exists for this email address"


def test_purge_request_requires_exact_phrase_and_acknowledgement() -> None:
    with pytest.raises(ValidationError):
        PurgeBusinessDataRequest(
            confirmation="delete all business data",  # type: ignore[arg-type]
            acknowledge_irreversible=True,
            company_code="CK",
        )
    with pytest.raises(ValidationError):
        PurgeBusinessDataRequest(
            confirmation="DELETE ALL BUSINESS DATA",
            acknowledge_irreversible=False,  # type: ignore[arg-type]
            company_code="CK",
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
        return MutationResponse(ok=True, operation=operation, id=None)


def principal(*permissions: str) -> Principal:
    user_id = UUID("00000000-0000-0000-0000-000000000001")
    company = CompanyAccess(
        company_id=COMPANY_ID,
        code="CK",
        name="CK Plastics",
        is_primary=True,
        role_codes=["admin"],
        permission_codes=list(permissions),
    )
    return Principal(
        user_id=user_id,
        token="test-token",
        claims={"sub": str(user_id)},
        profile=ProfileAccess(
            user_id=user_id,
            display_name="Test administrator",
            is_active=True,
            is_super_admin="system.admin" in permissions,
            companies=[company],
        ),
        company_id=company.company_id,
        company=company,
    )


def multi_company_profile() -> ProfileAccess:
    user_id = UUID("00000000-0000-0000-0000-000000000001")
    return ProfileAccess(
        user_id=user_id,
        display_name="Multi-company administrator",
        is_active=True,
        is_super_admin=True,
        companies=[
            CompanyAccess(
                company_id=COMPANY_ID,
                code="CK",
                name="CK Plastics",
                is_primary=True,
                role_codes=["admin"],
                permission_codes=["dashboard.read", "system.admin"],
            ),
            CompanyAccess(
                company_id=OTHER_COMPANY_ID,
                code="AR",
                name="AR Plastics",
                role_codes=["admin"],
                permission_codes=["dashboard.read", "system.admin"],
            ),
        ],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "permission",
    [
        "dashboard.read",
        "employees.read",
        "employees.write",
        "inventory.read",
        "inventory.write",
        "production.read",
        "production.write",
        "sales.read",
        "sales.write",
        "payroll.read",
        "payroll.write",
        "finance.read",
        "finance.write",
        "reports.read",
        "audit.read",
    ],
)
async def test_company_admin_can_pass_every_ordinary_permission_guard(
    permission: str,
) -> None:
    admin = principal("system.admin")

    assert await require_permission(permission)(admin) is admin
    assert await require_any_permission("unrelated.permission", permission)(admin) is admin


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
                "company_code": "CK",
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
                "company_code": "CK",
            },
            "idempotency_key": "purge-request-001",
            "token": "test-token",
            "request_id": "purge-test-request",
            "company_id": str(COMPANY_ID),
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
                "company_code": "CK",
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


def test_company_resolution_defaults_to_primary_and_rejects_forged_company() -> None:
    profile = multi_company_profile()

    assert resolve_company_access(profile, None).company_id == COMPANY_ID
    assert resolve_company_access(profile, str(OTHER_COMPANY_ID)).code == "AR"
    with pytest.raises(ApiError) as caught:
        resolve_company_access(
            profile,
            UUID("30000000-0000-0000-0000-000000000003"),
        )

    assert caught.value.status_code == 403
    assert caught.value.code == "company_access_denied"


def test_single_company_account_cannot_open_the_other_company_portal() -> None:
    profile = multi_company_profile().model_copy(
        update={"companies": [multi_company_profile().companies[0]]}
    )

    assert resolve_company_access(profile, str(COMPANY_ID)).code == "CK"
    with pytest.raises(ApiError) as caught:
        resolve_company_access(profile, str(OTHER_COMPANY_ID))

    assert caught.value.status_code == 403
    assert caught.value.code == "company_access_denied"


@pytest.mark.asyncio
async def test_x_company_header_selects_company_and_rejects_forgery() -> None:
    profile = multi_company_profile()

    class CompanyGateway:
        def __init__(self) -> None:
            self.dashboard_company_ids: list[str] = []

        async def fetch_profile(self, *_: Any, **__: Any) -> ProfileAccess:
            return profile

        async def dashboard(
            self,
            _: int | None,
            *,
            token: str,
            request_id: str,
            company_id: UUID | str,
        ) -> dict[str, Any]:
            assert token == "test-token"
            assert request_id
            self.dashboard_company_ids.append(str(company_id))
            return {
                "year": 2026,
                "inventory": {"bulk": [], "chip": [], "finished": []},
                "finance": {},
                "workforce": {},
                "operations": {},
                "generated_at": "2026-09-27T00:00:00Z",
            }

    gateway = CompanyGateway()
    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: gateway
    app.dependency_overrides[get_verified_token] = lambda: (
        "test-token",
        VerifiedToken(subject=profile.user_id, claims={"sub": str(profile.user_id)}),
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        selected = await client.get(
            "/api/v1/dashboard",
            headers={"X-Company-ID": str(OTHER_COMPANY_ID)},
        )
        identity = await client.get(
            "/api/v1/me",
            headers={"X-Company-ID": str(OTHER_COMPANY_ID)},
        )
        forged = await client.get(
            "/api/v1/dashboard",
            headers={"X-Company-ID": "30000000-0000-0000-0000-000000000003"},
        )

    assert selected.status_code == 200, selected.text
    assert gateway.dashboard_company_ids == [str(OTHER_COMPANY_ID)]
    assert identity.json()["active_company_id"] == str(OTHER_COMPANY_ID)
    assert identity.json()["active_company_code"] == "AR"
    assert identity.json()["active_company_name"] == "AR Plastics"
    assert identity.json()["permission_codes"] == ["dashboard.read", "system.admin"]
    assert forged.status_code == 403
    assert forged.json()["code"] == "company_access_denied"


@pytest.mark.asyncio
async def test_super_admin_can_list_company_user_access() -> None:
    class AccessGateway:
        async def select_page(self, source: str, **_: Any) -> PageResponse[dict[str, Any]]:
            assert source == "admin_user_access"
            return PageResponse(
                items=[{
                    "company_id": str(COMPANY_ID),
                    "company_code": "CK",
                    "company_name": "CK Plastics",
                    "user_id": "00000000-0000-0000-0000-000000000010",
                    "display_name": "Accounts User",
                    "email": "accounts@example.com",
                    "profile_active": True,
                    "is_super_admin": False,
                    "membership_active": True,
                    "is_primary": True,
                    "role_codes": ["accountant"],
                }],
                total=1,
                page=1,
                page_size=25,
                pages=1,
            )

    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: AccessGateway()
    app.dependency_overrides[get_principal] = lambda: principal("access.manage", "system.admin")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/v1/admin/users")

    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["role_codes"] == ["accountant"]


@pytest.mark.asyncio
async def test_super_admin_can_create_auth_user_and_provision_access() -> None:
    created_user_id = UUID("00000000-0000-0000-0000-000000000020")

    class AccountCreationGateway:
        def __init__(self) -> None:
            self.auth_call: dict[str, Any] | None = None
            self.access_call: dict[str, Any] | None = None

        async def create_auth_user(self, **kwargs: Any) -> UUID:
            self.auth_call = kwargs
            return created_user_id

        async def provision_user_access(self, **kwargs: Any) -> MutationResponse:
            self.access_call = kwargs
            return MutationResponse(ok=True, operation="admin.user.provision", id=created_user_id)

        async def delete_auth_user(self, *_: Any, **__: Any) -> None:
            raise AssertionError("successful provisioning must not compensate the Auth user")

    gateway = AccountCreationGateway()
    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: gateway
    app.dependency_overrides[get_principal] = lambda: principal("access.manage", "system.admin")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/api/v1/admin/users",
            headers={"Idempotency-Key": "account-create-001", "X-Request-ID": "create-request"},
            json={
                "email": " New.User@Example.com ",
                "display_name": " New User ",
                "temporary_password": "Strong-password-1!",
                "company_access": "BOTH",
                "role_codes": ["operations", "viewer", "operations"],
                "is_super_admin": False,
            },
        )

    assert response.status_code == 201, response.text
    assert gateway.auth_call == {
        "email": "new.user@example.com",
        "password": "Strong-password-1!",
        "display_name": "New User",
        "request_id": "create-request",
    }
    assert gateway.access_call == {
        "target_user_id": created_user_id,
        "display_name": "New User",
        "company_codes": ["CK", "AR"],
        "role_codes": ["operations", "viewer"],
        "is_super_admin": False,
        "token": "test-token",
        "request_id": "create-request",
    }


@pytest.mark.asyncio
async def test_super_admin_can_change_account_status_and_remove_with_pin() -> None:
    target_id = UUID("00000000-0000-0000-0000-000000000010")

    class AccountLifecycleGateway:
        def __init__(self) -> None:
            self.status_call: dict[str, Any] | None = None
            self.remove_call: dict[str, Any] | None = None

        async def set_user_account_status(self, **kwargs: Any) -> MutationResponse:
            self.status_call = kwargs
            return MutationResponse(ok=True, operation="admin.user.status", id=target_id)

        async def remove_user_account(self, **kwargs: Any) -> MutationResponse:
            self.remove_call = kwargs
            return MutationResponse(ok=True, operation="admin.user.remove", id=target_id)

    gateway = AccountLifecycleGateway()
    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: gateway
    app.dependency_overrides[get_principal] = lambda: principal("access.manage", "system.admin")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        status_response = await client.patch(
            f"/api/v1/admin/users/{target_id}/status",
            headers={"Idempotency-Key": "account-status-001", "X-Request-ID": "status-request"},
            json={"is_active": False},
        )
        remove_response = await client.request(
            "DELETE",
            f"/api/v1/admin/users/{target_id}",
            headers={"Idempotency-Key": "account-remove-001", "X-Request-ID": "remove-request"},
            json={"confirmation_pin": "2113"},
        )

    assert status_response.status_code == 200, status_response.text
    assert remove_response.status_code == 200, remove_response.text
    assert gateway.status_call == {
        "target_user_id": target_id,
        "is_active": False,
        "token": "test-token",
        "request_id": "status-request",
        "idempotency_key": "account-status-001",
    }
    assert gateway.remove_call == {
        "target_user_id": target_id,
        "confirmation_pin": "2113",
        "token": "test-token",
        "request_id": "remove-request",
        "idempotency_key": "account-remove-001",
    }


@pytest.mark.asyncio
async def test_company_admin_cannot_change_or_remove_accounts() -> None:
    class UnexpectedGateway:
        async def set_user_account_status(self, **_: Any) -> MutationResponse:
            raise AssertionError("status gateway must not be called")

        async def remove_user_account(self, **_: Any) -> MutationResponse:
            raise AssertionError("remove gateway must not be called")

    target_id = "00000000-0000-0000-0000-000000000010"
    app = create_app(settings())
    app.dependency_overrides[get_gateway] = lambda: UnexpectedGateway()
    app.dependency_overrides[get_principal] = lambda: principal("access.manage")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        status_response = await client.patch(
            f"/api/v1/admin/users/{target_id}/status",
            headers={"Idempotency-Key": "account-status-002"},
            json={"is_active": False},
        )
        remove_response = await client.request(
            "DELETE",
            f"/api/v1/admin/users/{target_id}",
            headers={"Idempotency-Key": "account-remove-002"},
            json={"confirmation_pin": "2113"},
        )

    assert status_response.status_code == 403
    assert remove_response.status_code == 403
    assert status_response.json()["code"] == "super_admin_required"
    assert remove_response.json()["code"] == "super_admin_required"


@pytest.mark.asyncio
async def test_obsolete_access_patch_route_is_not_exposed() -> None:
    app = create_app(settings())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.patch(
            "/api/v1/admin/users/00000000-0000-0000-0000-000000000010/access"
        )
    assert response.status_code == 404


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
            company_id=COMPANY_ID,
        )

    assert page.total == 1
    assert [(key, value) for key, value in captured if key == "sale_date"] == [
        ("sale_date", "gte.2026-01-01"),
        ("sale_date", "lte.2026-12-31"),
    ]
    assert ("company_id", f"eq.{COMPANY_ID}") in captured


@pytest.mark.asyncio
async def test_private_select_one_is_scoped_to_company() -> None:
    captured: list[tuple[str, str]] = []
    record_id = "00000000-0000-0000-0000-000000000009"

    def handler(request: httpx.Request) -> httpx.Response:
        captured.extend(request.url.params.multi_items())
        return httpx.Response(200, json=[{"id": record_id, "name": "Scoped employee"}])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        row = await gateway.select_one(
            "employees",
            record_id,
            token="test-token",
            request_id="test-request",
            company_id=COMPANY_ID,
        )

    assert row["id"] == record_id
    assert ("id", f"eq.{record_id}") in captured
    assert ("company_id", f"eq.{COMPANY_ID}") in captured


@pytest.mark.asyncio
async def test_shared_inventory_read_is_not_company_filtered() -> None:
    captured: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.extend(request.url.params.multi_items())
        return httpx.Response(
            200,
            json=[
                {
                    "item_id": "00000000-0000-0000-0000-000000000020",
                    "item_name": "Shared PP chips",
                }
            ],
            headers={"content-range": "0-0/1"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        page = await gateway.select_page(
            "inventory_position",
            token="test-token",
            request_id="test-request",
            page=1,
            page_size=25,
            order="item_name.asc",
            company_id=COMPANY_ID,
        )

    assert page.items[0]["item_name"] == "Shared PP chips"
    assert all(key != "company_id" for key, _ in captured)


@pytest.mark.asyncio
async def test_gateway_injects_company_into_execute_and_dashboard_rpc() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/rpc/erp_execute"):
            return httpx.Response(200, json={"ok": True, "operation": "employee.upsert"})
        return httpx.Response(200, json={"company": "CK"})

    payload = {"name": "Nimali", "company_id": str(OTHER_COMPANY_ID)}
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        await gateway.execute(
            "employee.upsert",
            payload,
            "employee-create-001",
            token="test-token",
            request_id="test-request",
            company_id=COMPANY_ID,
        )
        await gateway.dashboard(
            2026,
            token="test-token",
            request_id="test-request",
            company_id=COMPANY_ID,
        )

    execute_body = json.loads(requests[0].content)
    dashboard_body = json.loads(requests[1].content)
    assert requests[0].url.path.endswith("/rpc/erp_execute")
    assert execute_body["p_payload"]["company_id"] == str(COMPANY_ID)
    assert payload["company_id"] == str(OTHER_COMPANY_ID)
    assert requests[1].url.path.endswith("/rpc/erp_company_dashboard")
    assert dashboard_body == {"p_company_id": str(COMPANY_ID), "p_year": 2026}


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
async def test_profile_gateway_loads_company_scoped_access_contract() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["select"] == (
            "user_id,display_name,email,is_active,is_super_admin,companies"
        )
        return httpx.Response(200, json=[multi_company_profile().model_dump(mode="json")])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = SupabaseGateway(settings(), client)
        profile = await gateway.fetch_profile(
            "test-token",
            "test-request",
            expected_user_id="00000000-0000-0000-0000-000000000001",
        )

    assert profile.is_super_admin is True
    assert [company.code for company in profile.companies] == ["CK", "AR"]


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
            company_id=COMPANY_ID,
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
            company_id=COMPANY_ID,
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
                company_id=COMPANY_ID,
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
            assert source == "company_inventory_stage_summary"
            return [
                {"stage": "bulk", "item_count": 7, "total_quantity": "100", "total_value": "900"},
                {"stage": "chip", "item_count": 4, "total_quantity": "50", "total_value": "600"},
                {"stage": "finished", "item_count": 9, "total_quantity": "45", "total_value": "1200"},
            ]

    request = SimpleNamespace(state=SimpleNamespace(request_id="summary-test"))
    principal = SimpleNamespace(token="test-token", company_id=COMPANY_ID)
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
