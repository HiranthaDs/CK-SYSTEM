from __future__ import annotations

from datetime import date

import pytest
from pydantic import ValidationError

from app.models import EmployeeUpsert, OvertimeUpsert, PayrollPaymentPost, PayrollPost


def employee_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "Nimali Perera",
        "joined_date": "2025-01-15",
        "pay_effective_from": "2025-01-15",
        "pay_model": "monthly",
        "monthly_rate": "85000.00",
        "daily_rate": 0,
        "ot_rate": "750.00",
        "standard_hours_per_day": 8,
        "standard_days_per_month": 22,
        "employee_epf_rate": 8,
        "employer_epf_rate": 12,
        "employer_etf_rate": 3,
        "payroll_defaults": {
            "earnings": [
                {
                    "type": "attendance_allowance",
                    "description": "Attendance allowance",
                    "amount": 5000,
                    "account_code": "WAGES_EXPENSE",
                }
            ],
            "deductions": [],
            "employer_contributions": [],
        },
        "status": "active",
    }
    payload.update(overrides)
    return payload


def test_employee_pay_profile_is_typed_and_serializable() -> None:
    model = EmployeeUpsert.model_validate(employee_payload())

    assert model.pay_effective_from == date(2025, 1, 15)
    assert model.employee_epf_rate == 8
    assert model.payroll_defaults.earnings[0].amount == 5000
    assert model.model_dump(mode="json", exclude_none=True)["monthly_rate"] == 85000


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"employee_epf_rate": 101}, "less than or equal to 100"),
        (
            {"emergency_contact": {"name": "Kamal", "relationship": "Parent", "phone": ""}},
            "name and phone are required together",
        ),
        ({"pay_effective_from": "2024-12-31"}, "cannot be earlier than joined_date"),
        ({"status": "inactive", "left_date": None}, "left_date is required"),
    ],
)
def test_employee_pay_profile_rejects_unsafe_values(
    overrides: dict[str, object], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        EmployeeUpsert.model_validate(employee_payload(**overrides))


def test_daily_employee_requires_a_daily_rate() -> None:
    with pytest.raises(ValidationError, match="daily_rate is required"):
        EmployeeUpsert.model_validate(
            employee_payload(pay_model="daily", monthly_rate=0, daily_rate=0)
        )


def test_paid_payroll_rejects_non_settlement_default() -> None:
    payload = {
        "payroll_date": "2026-09-30",
        "salary_month": "2026-09",
        "employee_id": "00000000-0000-0000-0000-000000000001",
        "status": "paid",
        "payment_method": "salary_payable",
        "earnings": [{"type": "monthly_salary", "amount": 85000}],
    }
    with pytest.raises(ValidationError, match="paid payroll requires cash"):
        PayrollPost.model_validate(payload)


def test_payroll_payment_rejects_non_settlement_method() -> None:
    with pytest.raises(ValidationError, match="payroll payment method must be cash"):
        PayrollPaymentPost.model_validate(
            {
                "payment_date": "2026-09-30",
                "amount": 85000,
                "method": "salary_payable",
            }
        )


def test_overtime_requires_valid_hours_and_rate() -> None:
    overtime = OvertimeUpsert.model_validate(
        {
            "employee_id": "00000000-0000-0000-0000-000000000001",
            "work_date": "2026-09-22",
            "hours": "2.5",
            "rate": "750.00",
        }
    )
    assert overtime.hours == 2.5
    assert overtime.rate == 750

    with pytest.raises(ValidationError, match="less than or equal to 24"):
        OvertimeUpsert.model_validate(
            {
                "employee_id": "00000000-0000-0000-0000-000000000001",
                "work_date": "2026-09-22",
                "hours": 25,
                "rate": 750,
            }
        )


def test_payroll_accepts_overtime_as_its_only_earning_source() -> None:
    payroll = PayrollPost.model_validate(
        {
            "payroll_date": "2026-09-30",
            "salary_month": "2026-09",
            "employee_id": "00000000-0000-0000-0000-000000000001",
            "status": "payable",
            "overtime_ids": ["00000000-0000-0000-0000-000000000002"],
        }
    )
    assert len(payroll.overtime_ids) == 1
