from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from math import ceil
from typing import Annotated, Any, Generic, Literal, TypeVar
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    field_validator,
    model_validator,
)


def _decimal_to_number(value: Decimal) -> int | float:
    if value == value.to_integral_value():
        return int(value)
    return float(value)


PositiveMoney = Annotated[
    Decimal,
    Field(gt=0, max_digits=18, decimal_places=2),
    PlainSerializer(_decimal_to_number, return_type=int | float, when_used="json"),
]
Money = Annotated[
    Decimal,
    Field(ge=0, max_digits=18, decimal_places=2),
    PlainSerializer(_decimal_to_number, return_type=int | float, when_used="json"),
]
PositiveQuantity = Annotated[
    Decimal,
    Field(gt=0, max_digits=18, decimal_places=6),
    PlainSerializer(_decimal_to_number, return_type=int | float, when_used="json"),
]
Quantity = Annotated[
    Decimal,
    Field(ge=0, max_digits=18, decimal_places=6),
    PlainSerializer(_decimal_to_number, return_type=int | float, when_used="json"),
]
ShortText = Annotated[str, Field(min_length=1, max_length=160)]
ReferenceNo = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9._/-]+$")]


class ERPModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
        use_enum_values=True,
    )


class FlexibleRecord(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True, use_enum_values=True)


class EmployeeStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class PayModel(StrEnum):
    MONTHLY = "monthly"
    DAILY = "daily"
    HYBRID = "hybrid"
    PIECEWORK = "piecework"


class EmergencyContact(ERPModel):
    name: Annotated[str, Field(max_length=160)] = ""
    relationship: Annotated[str, Field(max_length=100)] = ""
    phone: Annotated[str, Field(max_length=40)] = ""

    @model_validator(mode="after")
    def require_a_reachable_contact(self) -> EmergencyContact:
        if any((self.name, self.relationship, self.phone)) and not (self.name and self.phone):
            raise ValueError("emergency contact name and phone are required together")
        return self


class PayrollDefaultComponent(ERPModel):
    type: ShortText
    description: Annotated[str, Field(max_length=300)] = ""
    amount: PositiveMoney
    account_code: Annotated[str, Field(max_length=40)] = ""


class PayrollDefaults(ERPModel):
    earnings: Annotated[list[PayrollDefaultComponent], Field(max_length=50)] = Field(
        default_factory=list
    )
    deductions: Annotated[list[PayrollDefaultComponent], Field(max_length=50)] = Field(
        default_factory=list
    )
    employer_contributions: Annotated[
        list[PayrollDefaultComponent], Field(max_length=50)
    ] = Field(default_factory=list)


class PurchasePaymentMethod(StrEnum):
    CASH = "cash"
    BANK_TRANSFER = "bank_transfer"
    CHEQUE = "cheque"
    CREDIT = "credit"


class PaymentMethod(StrEnum):
    CASH = "cash"
    BANK_TRANSFER = "bank_transfer"
    CHEQUE = "cheque"
    CREDIT = "credit"
    ACCOUNTS_RECEIVABLE = "accounts_receivable"
    SALARY_PAYABLE = "salary_payable"
    OTHER = "other"


class InventoryStage(StrEnum):
    BULK = "bulk"
    CHIP = "chip"
    FINISHED = "finished"


class AdjustmentDirection(StrEnum):
    POSITIVE = "positive"
    NEGATIVE = "negative"


class PayrollStatus(StrEnum):
    PAYABLE = "payable"
    PAID = "paid"


class EmployeeUpsert(ERPModel):
    id: UUID | None = None
    employee_no: Annotated[str, Field(min_length=1, max_length=40)] | None = None
    name: ShortText
    nic: Annotated[str, Field(max_length=40)] | None = None
    phone: Annotated[str, Field(max_length=40)] | None = None
    email: Annotated[
        str,
        Field(max_length=254, pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$"),
    ] | None = None
    date_of_birth: date | None = None
    address: Annotated[str, Field(max_length=500)] | None = None
    epf_no: Annotated[str, Field(max_length=60)] | None = None
    etf_ref: Annotated[str, Field(max_length=60)] | None = None
    joined_date: date
    left_date: date | None = None
    job_role: Annotated[str, Field(max_length=100)] | None = None
    department: Annotated[str, Field(max_length=100)] | None = None
    employment_type: Annotated[str, Field(max_length=60)] | None = None
    shift: Annotated[str, Field(max_length=60)] | None = None
    tax_no: Annotated[str, Field(max_length=80)] | None = None
    emergency_contact: EmergencyContact | None = None
    pay_model: PayModel
    monthly_rate: Money | None = None
    daily_rate: Money | None = None
    ot_rate: Money | None = None
    pay_effective_from: date | None = None
    standard_hours_per_day: Annotated[Decimal, Field(ge=0, le=24)] = Decimal("0")
    standard_days_per_month: Annotated[Decimal, Field(ge=0, le=31)] = Decimal("0")
    employee_epf_rate: Annotated[Decimal, Field(ge=0, le=100)] = Decimal("0")
    employer_epf_rate: Annotated[Decimal, Field(ge=0, le=100)] = Decimal("0")
    employer_etf_rate: Annotated[Decimal, Field(ge=0, le=100)] = Decimal("0")
    payroll_defaults: PayrollDefaults = Field(default_factory=PayrollDefaults)
    pay_notes: Annotated[str, Field(max_length=2000)] | None = None
    daily_on_conversion: bool = False
    bank_details: dict[str, Any] | None = None
    status: EmployeeStatus = EmployeeStatus.ACTIVE

    @model_validator(mode="after")
    def validate_dates_and_pay(self) -> EmployeeUpsert:
        if self.date_of_birth and self.date_of_birth >= self.joined_date:
            raise ValueError("date_of_birth must be earlier than joined_date")
        if self.left_date and self.left_date < self.joined_date:
            raise ValueError("left_date cannot be earlier than joined_date")
        if self.pay_effective_from and self.pay_effective_from < self.joined_date:
            raise ValueError("pay_effective_from cannot be earlier than joined_date")
        if self.status == EmployeeStatus.INACTIVE and not self.left_date:
            raise ValueError("left_date is required for an inactive employee")
        if self.pay_model in {PayModel.MONTHLY, PayModel.HYBRID} and not self.monthly_rate:
            raise ValueError("monthly_rate is required for monthly or hybrid pay")
        if self.pay_model in {PayModel.DAILY, PayModel.HYBRID} and not self.daily_rate:
            raise ValueError("daily_rate is required for daily or hybrid pay")
        return self


class ConversionTypeUpsert(ERPModel):
    id: UUID | None = None
    name: ShortText
    default_chip_name: ShortText | None = None
    status: EmployeeStatus = EmployeeStatus.ACTIVE
    notes: Annotated[str, Field(max_length=1000)] | None = None


class PieceworkRateUpsert(ERPModel):
    id: UUID | None = None
    conversion_type_id: UUID | None = None
    work_type: ShortText | None = None
    rate_per_kg: PositiveMoney
    effective_from: date
    effective_to: date | None = None
    status: EmployeeStatus = EmployeeStatus.ACTIVE
    notes: Annotated[str, Field(max_length=1000)] | None = None

    @model_validator(mode="after")
    def validate_effective_dates(self) -> PieceworkRateUpsert:
        if not self.conversion_type_id and not self.work_type:
            raise ValueError("conversion_type_id or work_type is required")
        if self.effective_to and self.effective_to < self.effective_from:
            raise ValueError("effective_to cannot be earlier than effective_from")
        return self


class RawMaterialPurchasePost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    purchase_date: date
    item_id: UUID | None = None
    material_name: ShortText | None = None
    supplier_name: Annotated[str, Field(max_length=160)] | None = None
    supplier_phone: Annotated[str, Field(max_length=40)] | None = None
    quantity_kg: PositiveQuantity
    total_cost: PositiveMoney
    payment_method: PurchasePaymentMethod
    notes: Annotated[str, Field(max_length=2000)] | None = None

    @model_validator(mode="after")
    def validate_item(self) -> RawMaterialPurchasePost:
        if not self.item_id and not self.material_name:
            raise ValueError("item_id or material_name is required")
        return self


class ConversionWorkerInput(ERPModel):
    employee_id: UUID
    rate_id: UUID | None = None
    task: ShortText | None = None
    quantity_kg: PositiveQuantity
    rate_per_kg: PositiveMoney | None = None
    amount: PositiveMoney | None = None

    @model_validator(mode="after")
    def validate_rate_source(self) -> ConversionWorkerInput:
        if not self.rate_id and (not self.task or self.rate_per_kg is None):
            raise ValueError("manual worker allocation requires task and rate_per_kg")
        return self


class ConversionPost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    conversion_date: date
    conversion_type_id: UUID | None = None
    source_item_id: UUID | None = None
    source_material_name: ShortText | None = None
    output_item_id: UUID | None = None
    chip_name: ShortText | None = None
    chip_type: Annotated[str, Field(max_length=100)] | None = None
    input_kg: PositiveQuantity
    output_kg: PositiveQuantity
    overhead_cost: Money = Decimal("0")
    workers: Annotated[list[ConversionWorkerInput], Field(min_length=1, max_length=100)]

    @model_validator(mode="after")
    def validate_conversion(self) -> ConversionPost:
        if not self.source_item_id and not self.source_material_name:
            raise ValueError("source_item_id or source_material_name is required")
        if not self.output_item_id and not self.chip_name:
            raise ValueError("output_item_id or chip_name is required")
        if self.output_kg > self.input_kg * Decimal("1.02"):
            raise ValueError("output_kg cannot exceed input_kg by more than 2%")
        return self


class ManualPieceworkInput(ERPModel):
    id: UUID | None = None
    task: ShortText
    quantity_kg: PositiveQuantity
    rate_per_kg: PositiveMoney
    amount: PositiveMoney | None = None


class DailyWorkUpsert(ERPModel):
    id: UUID | None = None
    employee_id: UUID
    work_date: date
    work_units: PositiveQuantity
    daily_rate: PositiveMoney
    notes: Annotated[str, Field(max_length=2000)] | None = None
    manual_piecework: Annotated[list[ManualPieceworkInput], Field(max_length=100)] = Field(
        default_factory=list
    )


class OvertimeUpsert(ERPModel):
    id: UUID | None = None
    employee_id: UUID
    work_date: date
    hours: Annotated[Decimal, Field(gt=0, le=24, max_digits=8, decimal_places=2)]
    rate: PositiveMoney
    notes: Annotated[str, Field(max_length=1000)] | None = None


class InventoryItemUpsert(ERPModel):
    id: UUID | None = None
    sku: Annotated[str, Field(min_length=1, max_length=80)]
    name: ShortText
    stage: InventoryStage
    unit: Annotated[str, Field(min_length=1, max_length=40)]
    is_active: bool = True


class ProductionPost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    production_date: date
    shift: Annotated[str, Field(max_length=60)] | None = None
    machine: Annotated[str, Field(max_length=100)] | None = None
    operator_employee_id: UUID
    chip_item_id: UUID | None = None
    chip_name: ShortText | None = None
    finished_item_id: UUID | None = None
    finished_item_name: ShortText | None = None
    input_kg: PositiveQuantity
    output_quantity: PositiveQuantity
    working_hours: Quantity | None = None
    overhead_cost: Money = Decimal("0")
    notes: Annotated[str, Field(max_length=2000)] | None = None

    @model_validator(mode="after")
    def validate_items(self) -> ProductionPost:
        if not self.chip_item_id and not self.chip_name:
            raise ValueError("chip_item_id or chip_name is required")
        if not self.finished_item_id and not self.finished_item_name:
            raise ValueError("finished_item_id or finished_item_name is required")
        return self


class SaleItemInput(ERPModel):
    item_id: UUID | None = None
    item_name: ShortText | None = None
    quantity: PositiveQuantity
    unit_price: PositiveMoney
    discount: Money = Decimal("0")

    @model_validator(mode="after")
    def validate_line(self) -> SaleItemInput:
        if not self.item_id and not self.item_name:
            raise ValueError("item_id or item_name is required")
        if self.discount >= self.quantity * self.unit_price:
            raise ValueError("discount must be less than the line gross amount")
        return self


class SalePost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    invoice_no: ReferenceNo
    sale_date: date
    customer_name: ShortText
    customer_phone: Annotated[str, Field(max_length=40)] | None = None
    payment_method: PaymentMethod
    amount_paid: Money = Decimal("0")
    items: Annotated[list[SaleItemInput], Field(min_length=1, max_length=500)]


class SalePaymentPost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    sale_id: UUID | None = None
    payment_date: date
    amount: PositiveMoney
    method: PaymentMethod
    notes: Annotated[str, Field(max_length=1000)] | None = None


class PayrollEarningInput(ERPModel):
    type: ShortText
    description: Annotated[str, Field(max_length=300)] | None = None
    quantity: Quantity | None = None
    rate: Money | None = None
    amount: PositiveMoney
    account_code: Annotated[str, Field(max_length=40)] | None = None


class PayrollDeductionInput(ERPModel):
    type: ShortText
    description: Annotated[str, Field(max_length=300)] | None = None
    amount: PositiveMoney
    account_code: Annotated[str, Field(max_length=40)] | None = None


class EmployerContributionInput(PayrollDeductionInput):
    pass


class PayrollPost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    payroll_date: date
    salary_month: Annotated[str, Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")]
    employee_id: UUID
    status: PayrollStatus
    payment_method: PaymentMethod | None = None
    earnings: Annotated[list[PayrollEarningInput], Field(max_length=200)] = Field(
        default_factory=list
    )
    deductions: Annotated[list[PayrollDeductionInput], Field(max_length=200)] = Field(
        default_factory=list
    )
    employer_contributions: Annotated[
        list[EmployerContributionInput], Field(max_length=100)
    ] = Field(default_factory=list)
    daily_work_ids: Annotated[list[UUID], Field(max_length=500)] = Field(default_factory=list)
    conversion_worker_ids: Annotated[list[UUID], Field(max_length=500)] = Field(
        default_factory=list
    )
    manual_piecework_ids: Annotated[list[UUID], Field(max_length=500)] = Field(
        default_factory=list
    )
    overtime_ids: Annotated[list[UUID], Field(max_length=500)] = Field(default_factory=list)

    @field_validator(
        "daily_work_ids", "conversion_worker_ids", "manual_piecework_ids", "overtime_ids"
    )
    @classmethod
    def require_unique_claim_ids(cls, value: list[UUID]) -> list[UUID]:
        if len(value) != len(set(value)):
            raise ValueError("claim IDs must be unique")
        return value

    @model_validator(mode="after")
    def validate_payment(self) -> PayrollPost:
        if self.status == PayrollStatus.PAID and not self.payment_method:
            raise ValueError("payment_method is required when payroll status is paid")
        if self.status == PayrollStatus.PAID and self.payment_method not in {
            PaymentMethod.CASH,
            PaymentMethod.BANK_TRANSFER,
            PaymentMethod.CHEQUE,
            PaymentMethod.OTHER,
        }:
            raise ValueError(
                "paid payroll requires cash, bank_transfer, cheque, or other"
            )
        if not self.earnings and not (
            self.daily_work_ids
            or self.conversion_worker_ids
            or self.manual_piecework_ids
            or self.overtime_ids
        ):
            raise ValueError("payroll needs an earning or an open-work claim")
        return self


class PayrollPaymentPost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    payroll_id: UUID | None = None
    payment_date: date
    amount: PositiveMoney
    method: PaymentMethod
    notes: Annotated[str, Field(max_length=1000)] | None = None

    @field_validator("method")
    @classmethod
    def require_settlement_method(cls, value: PaymentMethod) -> PaymentMethod:
        if value not in {
            PaymentMethod.CASH,
            PaymentMethod.BANK_TRANSFER,
            PaymentMethod.CHEQUE,
            PaymentMethod.OTHER,
        }:
            raise ValueError(
                "payroll payment method must be cash, bank_transfer, cheque, or other"
            )
        return value


class AdjustmentPost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    adjustment_date: date
    item_id: UUID | None = None
    item_name: ShortText | None = None
    direction: AdjustmentDirection
    quantity: PositiveQuantity
    value: PositiveMoney
    notes: Annotated[str, Field(max_length=2000)] | None = None

    @model_validator(mode="after")
    def validate_item(self) -> AdjustmentPost:
        if not self.item_id and not self.item_name:
            raise ValueError("item_id or item_name is required")
        return self


class JournalLineInput(ERPModel):
    account_code: Annotated[str, Field(max_length=40)] | None = None
    account: Annotated[str, Field(max_length=160)] | None = None
    description: Annotated[str, Field(max_length=500)] | None = None
    debit: Money = Decimal("0")
    credit: Money = Decimal("0")

    @model_validator(mode="after")
    def validate_line(self) -> JournalLineInput:
        if not self.account_code and not self.account:
            raise ValueError("account_code or account is required")
        if (self.debit > 0) == (self.credit > 0):
            raise ValueError("exactly one of debit or credit must be greater than zero")
        return self


class JournalPost(ERPModel):
    id: UUID | None = None
    reference_no: ReferenceNo | None = None
    journal_date: date
    memo: Annotated[str, Field(min_length=1, max_length=500)]
    lines: Annotated[list[JournalLineInput], Field(min_length=2, max_length=500)]

    @model_validator(mode="after")
    def validate_balance(self) -> JournalPost:
        debits = sum((line.debit for line in self.lines), Decimal("0"))
        credits = sum((line.credit for line in self.lines), Decimal("0"))
        if debits != credits:
            raise ValueError(f"journal is not balanced: debit={debits}, credit={credits}")
        return self


class ReverseRequest(ERPModel):
    reason: Annotated[str, Field(min_length=3, max_length=1000)] | None = None


class PurgeBusinessDataRequest(ERPModel):
    confirmation: Literal["DELETE ALL BUSINESS DATA"]
    acknowledge_irreversible: Literal[True]


class LegacyActionRequest(ERPModel):
    action: Annotated[str, Field(min_length=1, max_length=80)]
    direction: Annotated[str, Field(max_length=10)] | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class ProfileAccess(FlexibleRecord):
    user_id: UUID
    display_name: str | None = None
    email: str | None = None
    is_active: bool = True
    role_codes: list[str] = Field(default_factory=list)
    permission_codes: list[str] = Field(default_factory=list)


class MutationResponse(FlexibleRecord):
    ok: bool
    operation: str
    id: UUID | str | None = None
    reference_no: str | None = None
    idempotent: bool = False
    reversed: bool | None = None


class EmployeeRecord(FlexibleRecord):
    id: UUID
    employee_no: str | None = None
    name: str
    status: str
    email: str | None = None
    date_of_birth: date | None = None
    department: str | None = None
    tax_no: str | None = None
    emergency_contact: dict[str, Any] | None = None
    pay_model: str | None = None
    monthly_rate: Decimal | None = None
    daily_rate: Decimal | None = None
    ot_rate: Decimal | None = None
    pay_effective_from: date | None = None
    standard_hours_per_day: Decimal | None = None
    standard_days_per_month: Decimal | None = None
    employee_epf_rate: Decimal | None = None
    employer_epf_rate: Decimal | None = None
    employer_etf_rate: Decimal | None = None
    payroll_defaults: dict[str, Any] | None = None
    pay_notes: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ConversionTypeRecord(FlexibleRecord):
    id: UUID
    name: str
    default_chip_name: str | None = None
    status: str


class PieceworkRateRecord(FlexibleRecord):
    id: UUID
    conversion_type_id: UUID | None = None
    work_type: str
    rate_per_kg: Decimal
    effective_from: date
    effective_to: date | None = None
    status: str
    conversion_type: dict[str, Any] | None = None


class InventoryPositionRecord(FlexibleRecord):
    item_id: UUID
    sku: str | None = None
    item_name: str
    stage: InventoryStage
    unit: str
    quantity_on_hand: Decimal
    inventory_value: Decimal
    average_unit_cost: Decimal
    last_movement_at: datetime | None = None
    is_active: bool = True


class RawMaterialPurchaseRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    purchase_date: date
    item_id: UUID
    quantity_kg: Decimal
    total_cost: Decimal
    status: str
    material_name: str | None = None

    @model_validator(mode="before")
    @classmethod
    def flatten_item_name(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        item = data.get("inventory_items")
        if not data.get("material_name") and isinstance(item, dict):
            data["material_name"] = item.get("name")
        return data


class ConversionRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    conversion_date: date
    conversion_type_id: UUID | None = None
    source_item_id: UUID
    output_item_id: UUID
    input_kg: Decimal
    output_kg: Decimal
    status: str
    conversion_workers: list[dict[str, Any]] = Field(default_factory=list)
    source_item_name: str | None = None
    output_item_name: str | None = None

    @model_validator(mode="before")
    @classmethod
    def flatten_item_names(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        source = data.get("source_item")
        output = data.get("output_item")
        if not data.get("source_item_name") and isinstance(source, dict):
            data["source_item_name"] = source.get("name")
        if not data.get("output_item_name") and isinstance(output, dict):
            data["output_item_name"] = output.get("name")
        return data


class DailyWorkRecord(FlexibleRecord):
    id: UUID
    employee_id: UUID
    work_date: date
    work_units: Decimal
    daily_rate: Decimal
    status: str | None = None
    daily_work_piecework: list[dict[str, Any]] = Field(default_factory=list)


class OvertimeRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    employee_id: UUID
    work_date: date
    hours: Decimal
    rate: Decimal
    amount: Decimal
    status: str
    employee_no: str | None = None
    employee_name: str | None = None
    notes: str | None = None
    claimed_payroll_id: UUID | None = None
    claimed_payroll_reference: str | None = None


class ProductionRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    production_date: date
    chip_item_id: UUID
    finished_item_id: UUID
    input_kg: Decimal
    output_quantity: Decimal
    status: str
    chip_name: str | None = None
    finished_item_name: str | None = None
    operator_name: str | None = None

    @model_validator(mode="before")
    @classmethod
    def flatten_related_names(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        chip = data.get("chip_item")
        finished = data.get("finished_item")
        operator = data.get("operator")
        if not data.get("chip_name") and isinstance(chip, dict):
            data["chip_name"] = chip.get("name")
        if not data.get("finished_item_name") and isinstance(finished, dict):
            data["finished_item_name"] = finished.get("name")
        if not data.get("operator_name") and isinstance(operator, dict):
            data["operator_name"] = operator.get("name")
        return data


class ProductionDailySummaryRecord(FlexibleRecord):
    production_date: date
    run_count: int
    input_kg: Decimal
    output_quantity: Decimal
    total_cost: Decimal


class ProductionSummary(BaseModel):
    as_of: date
    month: str
    today_runs: int
    today_input_kg: Decimal
    today_output_quantity: Decimal
    month_runs: int
    month_input_kg: Decimal
    month_output_quantity: Decimal
    bulk_item_count: int
    chip_item_count: int
    bulk_value: Decimal
    chip_value: Decimal
    recent_daily: list[ProductionDailySummaryRecord]


class SaleRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    invoice_no: str
    sale_date: date
    customer_name: str
    total_amount: Decimal | None = None
    paid_amount: Decimal | None = None
    balance_due: Decimal | None = None
    status: str
    sale_items: list[dict[str, Any]] = Field(default_factory=list)
    sale_payments: list[dict[str, Any]] = Field(default_factory=list)


class PaymentRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    payment_date: date
    amount: Decimal
    method: str
    status: str | None = None


class PayrollRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    payroll_date: date
    salary_month: str
    employee_id: UUID
    gross_pay: Decimal | None = None
    deductions_total: Decimal | None = None
    net_pay: Decimal | None = None
    balance_due: Decimal | None = None
    status: str
    payroll_details: list[dict[str, Any]] = Field(default_factory=list)
    payroll_payments: list[dict[str, Any]] = Field(default_factory=list)


class AdjustmentRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    adjustment_date: date
    item_id: UUID
    direction: str
    quantity: Decimal
    value: Decimal
    status: str


class JournalRecord(FlexibleRecord):
    id: UUID
    reference_no: str
    journal_date: date
    memo: str
    source_type: str | None = None
    # Kept optional while older clients migrate to the canonical source_type name.
    source_module: str | None = None
    status: str
    journal_lines: list[dict[str, Any]] = Field(default_factory=list)


class LedgerLineRecord(FlexibleRecord):
    id: UUID
    journal_entry_id: UUID
    account_id: UUID | int | None = None
    debit: Decimal
    credit: Decimal
    description: str | None = None


class AccountBalanceRecord(FlexibleRecord):
    account_code: str
    account_name: str
    category: str
    debit_total: Decimal
    credit_total: Decimal
    balance: Decimal


class OpenEarningRecord(FlexibleRecord):
    employee_id: UUID
    employee_no: str | None = None
    employee_name: str
    work_date: date
    source_type: str
    source_id: UUID
    description: str
    quantity: Decimal
    rate: Decimal
    amount: Decimal


class GenericRecord(FlexibleRecord):
    id: UUID | str | int | None = None


T = TypeVar("T")


class PageResponse(BaseModel, Generic[T]):
    model_config = ConfigDict(extra="forbid")

    items: list[T]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
    pages: int = Field(ge=0)
    pagination_mode: str = Field(default="offset", pattern=r"^(offset|cursor)$")
    next_cursor: str | None = None
    has_more: bool = False
    total_is_estimate: bool = False

    @classmethod
    def build(
        cls,
        items: list[T],
        total: int,
        page: int,
        page_size: int,
        *,
        pagination_mode: str = "offset",
        next_cursor: str | None = None,
        has_more: bool = False,
        total_is_estimate: bool = False,
    ) -> PageResponse[T]:
        return cls(
            items=items,
            total=total,
            page=page,
            page_size=page_size,
            pages=ceil(total / page_size) if total else 0,
            pagination_mode=pagination_mode,
            next_cursor=next_cursor,
            has_more=has_more,
            total_is_estimate=total_is_estimate,
        )


class InventoryStageSummary(BaseModel):
    item_count: int = Field(ge=0)
    total_quantity: Decimal
    total_value: Decimal


class InventorySummary(BaseModel):
    bulk: InventoryStageSummary
    chips: InventoryStageSummary
    finished: InventoryStageSummary
    total_quantity: Decimal
    total_value: Decimal


class DashboardInventory(FlexibleRecord):
    bulk: list[dict[str, Any]] = Field(default_factory=list)
    chip: list[dict[str, Any]] = Field(default_factory=list)
    finished: list[dict[str, Any]] = Field(default_factory=list)


class DashboardFinance(FlexibleRecord):
    revenue: Decimal = Decimal("0")
    cogs: Decimal = Decimal("0")
    expenses: Decimal = Decimal("0")
    receivables: Decimal = Decimal("0")
    payables: Decimal = Decimal("0")
    cash_bank: Decimal = Decimal("0")


class DashboardWorkforce(FlexibleRecord):
    active_employees: int = 0
    open_daily_wages: Decimal = Decimal("0")
    open_piecework: Decimal = Decimal("0")


class DashboardOperations(FlexibleRecord):
    purchases: int | Decimal = 0
    conversions: int | Decimal = 0
    production: int | Decimal = 0
    sales: int | Decimal = 0
    payroll: int | Decimal = 0


class DashboardResponse(FlexibleRecord):
    year: int
    inventory: DashboardInventory
    finance: DashboardFinance
    workforce: DashboardWorkforce
    operations: DashboardOperations
    generated_at: datetime


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    environment: str


class ReadinessResponse(HealthResponse):
    checks: dict[str, str]
