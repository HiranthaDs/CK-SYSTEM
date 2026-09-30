from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models import ProductionPost


def production_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "production_date": "2026-09-30",
        "operator_employee_id": "00000000-0000-0000-0000-000000000001",
        "chip_item_id": "00000000-0000-0000-0000-000000000002",
        "finished_item_name": "4-inch black photo frame arm",
        "input_kg": 10,
        "output_quantity": 40,
        "working_hours": 8,
        "overhead_cost": 2500,
        "selling_price": 850,
    }
    payload.update(overrides)
    return payload


def test_production_accepts_catalogue_selling_price() -> None:
    model = ProductionPost.model_validate(production_payload())

    assert model.selling_price == 850
    assert model.finished_item_name == "4-inch black photo frame arm"


def test_production_rejects_non_positive_selling_price() -> None:
    with pytest.raises(ValidationError, match="greater than 0"):
        ProductionPost.model_validate(production_payload(selling_price=0))


def test_production_can_reuse_existing_finished_product() -> None:
    model = ProductionPost.model_validate(
        production_payload(
            finished_item_id="00000000-0000-0000-0000-000000000003",
            finished_item_name=None,
        )
    )

    assert str(model.finished_item_id) == "00000000-0000-0000-0000-000000000003"
