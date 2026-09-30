export type Id = string
export type Numeric = number | string
export type JsonRecord = Record<string, unknown>

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  pages: number
  next_cursor?: string | null
  pagination_mode?: string
  count_is_estimate?: boolean
}

export interface MutationReceipt extends JsonRecord {
  ok: boolean
  operation: string
  id: Id | null
  reference_no?: string | null
  idempotent: boolean
  reversed?: boolean | null
}

export interface Me extends JsonRecord {
  user_id: Id
  email?: string | null
  display_name?: string | null
  is_active: boolean
  active_company_id: Id
  active_company_code: string
  active_company_name: string
  is_super_admin: boolean
  role_codes: string[]
  permission_codes: string[]
  companies?: Array<{
    company_id: Id
    code: string
    name: string
    is_primary: boolean
    role_codes: string[]
    permission_codes: string[]
  }>
}

export interface AdminUserAccess extends JsonRecord {
  company_id: Id
  company_code: string
  company_name: string
  user_id: Id
  display_name?: string | null
  email?: string | null
  profile_active: boolean
  is_super_admin: boolean
  membership_active: boolean
  is_primary: boolean
  role_codes: string[]
}

export interface InventoryPosition extends JsonRecord {
  item_id: Id
  sku?: string | null
  item_name: string
  stage: 'bulk' | 'chip' | 'finished'
  unit: string
  quantity_on_hand: Numeric
  shared_quantity_on_hand: Numeric
  inventory_value: Numeric
  average_unit_cost: Numeric
  selling_price?: Numeric
  last_movement_at?: string | null
  is_active: boolean
}

export interface InventoryItem extends JsonRecord {
  id: Id
  sku: string
  name: string
  stage: 'bulk' | 'chip' | 'finished'
  unit: string
  is_active: boolean
  created_at?: string
  updated_at?: string
  item_id?: Id
  item_name?: string
  material_name?: string
  quantity_on_hand?: Numeric
  current_quantity?: Numeric
  available?: Numeric
  average_unit_cost?: Numeric
  selling_price?: Numeric
  average_cost?: Numeric
  avg_cost?: Numeric
  inventory_value?: Numeric
  asset_value?: Numeric
  value?: Numeric
}

export interface InventorySummary {
  bulk: InventoryStageSummary
  chips: InventoryStageSummary
  finished: InventoryStageSummary
  total_quantity: Numeric
  shared_total_quantity: Numeric
  total_value: Numeric
}

export interface InventoryStageSummary {
  item_count: number
  total_quantity: Numeric
  shared_total_quantity: Numeric
  total_value: Numeric
}

export interface DashboardSummary extends JsonRecord {
  year: number
  inventory: {
    bulk: JsonRecord[]
    chip: JsonRecord[]
    finished: JsonRecord[]
  } & JsonRecord
  finance: {
    revenue: Numeric
    cogs: Numeric
    expenses: Numeric
    receivables: Numeric
    payables: Numeric
    cash_bank: Numeric
  } & JsonRecord
  workforce: {
    active_employees: number
    open_daily_wages: Numeric
    open_piecework: Numeric
  } & JsonRecord
  operations: {
    purchases: Numeric
    conversions: Numeric
    production: Numeric
    sales: Numeric
    payroll: Numeric
  } & JsonRecord
  generated_at: string
}

export interface PayrollDefaultComponent extends JsonRecord {
  type: string
  description?: string | null
  amount: Numeric
  account_code?: string | null
}

export interface EmployeePayrollDefaults extends JsonRecord {
  earnings: PayrollDefaultComponent[]
  deductions: PayrollDefaultComponent[]
  employer_contributions: PayrollDefaultComponent[]
}

export interface EmergencyContact extends JsonRecord {
  name?: string | null
  relationship?: string | null
  phone?: string | null
}

export interface Employee extends JsonRecord {
  id: Id
  employee_no?: string | null
  name: string
  nic?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
  date_of_birth?: string | null
  epf_no?: string | null
  etf_ref?: string | null
  tax_no?: string | null
  joined_date?: string | null
  left_date?: string | null
  job_role?: string | null
  department?: string | null
  employment_type?: string | null
  shift?: string | null
  pay_model?: 'monthly' | 'daily' | 'hybrid' | 'piecework' | null
  pay_effective_from?: string | null
  monthly_rate?: Numeric | null
  daily_rate?: Numeric | null
  ot_rate?: Numeric | null
  daily_on_conversion?: boolean
  standard_hours_per_day?: Numeric | null
  standard_days_per_month?: Numeric | null
  employee_epf_rate?: Numeric | null
  employer_epf_rate?: Numeric | null
  employer_etf_rate?: Numeric | null
  pay_notes?: string | null
  emergency_contact?: EmergencyContact | null
  payroll_defaults?: EmployeePayrollDefaults | null
  bank_details?: {
    bank_name?: string
    branch?: string
    account_name?: string
    account_number?: string
  } | null
  status: 'active' | 'inactive'
  created_at?: string | null
  updated_at?: string | null
}

export interface EmployeeCompensationHistory extends JsonRecord {
  id?: Id
  employee_id?: Id
  effective_from: string
  pay_model: 'monthly' | 'daily' | 'hybrid' | 'piecework'
  monthly_rate?: Numeric | null
  daily_rate?: Numeric | null
  ot_rate?: Numeric | null
  standard_hours_per_day?: Numeric | null
  standard_days_per_month?: Numeric | null
  employee_epf_rate?: Numeric | null
  employer_epf_rate?: Numeric | null
  employer_etf_rate?: Numeric | null
  payroll_defaults?: EmployeePayrollDefaults | null
  changed_at?: string | null
}

export interface PieceworkRate extends JsonRecord {
  id: Id
  conversion_type_id?: Id | null
  work_type: string
  rate_per_kg: Numeric
  effective_from: string
  effective_to?: string | null
  status: 'active' | 'inactive'
  notes?: string | null
  type?: string
}

export interface ConversionType extends JsonRecord {
  id: Id
  name: string
  default_chip_name?: string | null
  status: 'active' | 'inactive'
  notes?: string | null
  created_at?: string
  updated_at?: string
}

export interface RawMaterialPurchase extends JsonRecord {
  id: Id
  reference_no: string
  purchase_date: string
  item_id: Id
  supplier_name?: string | null
  supplier_phone?: string | null
  quantity_kg: Numeric
  total_cost: Numeric
  unit_cost?: Numeric
  payment_method?: string
  notes?: string | null
  status: string
  date?: string
  material_name?: string
  item_name?: string
  qty?: Numeric
  inventory_items?: { name: string; sku?: string | null } | null
}

export interface ConversionWorker extends JsonRecord {
  id: Id
  conversion_id?: Id
  employee_id: Id
  rate_id?: Id | null
  work_date?: string
  task: string
  quantity_kg: Numeric
  rate_per_kg: Numeric
  amount: Numeric
}

export interface Conversion extends JsonRecord {
  id: Id
  reference_no: string
  conversion_date: string
  conversion_type_id?: Id | null
  source_item_id: Id
  output_item_id: Id
  chip_type?: string | null
  input_kg: Numeric
  output_kg: Numeric
  waste_kg?: Numeric
  material_cost?: Numeric
  labor_cost?: Numeric
  overhead_cost?: Numeric
  total_converted_cost?: Numeric
  output_unit_cost?: Numeric
  status: string
  conversion_workers: ConversionWorker[]
  workers?: ConversionWorker[]
  date?: string
  source_quantity_kg?: Numeric
  output_quantity_kg?: Numeric
  waste_quantity_kg?: Numeric
  source_item_name?: string
  source_material_name?: string
  output_item_name?: string
  source_item?: { name: string; sku?: string | null } | null
  output_item?: { name: string; sku?: string | null } | null
  conversion_type?: { id?: Id; name: string; default_chip_name?: string | null } | null
}

export interface DailyPiecework extends JsonRecord {
  id: Id
  daily_work_id?: Id
  task: string
  quantity_kg: Numeric
  rate_per_kg: Numeric
  amount: Numeric
}

export interface DailyWork extends JsonRecord {
  id: Id
  reference_no?: string
  employee_id: Id
  work_date: string
  manual_work_units?: Numeric
  automatic_work_units?: Numeric
  work_units: Numeric
  daily_rate: Numeric
  base_amount?: Numeric
  auto_created?: boolean
  notes?: string | null
  status?: string | null
  daily_work_piecework: DailyPiecework[]
}

export interface OvertimeRecord extends JsonRecord {
  id: Id
  reference_no: string
  employee_id: Id
  employee_no?: string | null
  employee_name?: string | null
  work_date: string
  hours: Numeric
  rate: Numeric
  amount: Numeric
  notes?: string | null
  revision?: number
  status: string
  replaces_id?: Id | null
  claimed_payroll_id?: Id | null
  claimed_payroll_reference?: string | null
  employee?: Pick<Employee, 'name' | 'employee_no'> | null
  created_at?: string | null
  updated_at?: string | null
}

export interface ProductionRun extends JsonRecord {
  id: Id
  reference_no: string
  production_date: string
  shift?: string | null
  machine?: string | null
  operator_employee_id: Id
  chip_item_id: Id
  finished_item_id: Id
  input_kg: Numeric
  output_quantity: Numeric
  working_hours?: Numeric
  material_cost?: Numeric
  overhead_cost?: Numeric
  total_cost?: Numeric
  output_unit_cost?: Numeric
  notes?: string | null
  status: string
  date?: string
  quantity?: Numeric
  qty?: Numeric
  operator_name?: string
  employee_name?: string
  finished_item_name?: string
  item_name?: string
  output_item_name?: string
  chip_name?: string
  raw_material_name?: string
  input_item_name?: string
  raw_material_quantity_kg?: Numeric
  unit_cost?: Numeric
  chip_item?: { name: string; sku?: string | null } | null
  finished_item?: { name: string; sku?: string | null; selling_price?: Numeric } | null
  operator?: { name: string; employee_no?: string | null } | null
}

export interface ProductionDailySummary extends JsonRecord {
  production_date: string
  run_count: number
  input_kg: Numeric
  output_quantity: Numeric
  total_cost: Numeric
}

export interface ProductionSummary extends JsonRecord {
  as_of: string
  month: string
  today_runs: number
  today_input_kg: Numeric
  today_output_quantity: Numeric
  month_runs: number
  month_input_kg: Numeric
  month_output_quantity: Numeric
  bulk_item_count: number
  chip_item_count: number
  bulk_value: Numeric
  chip_value: Numeric
  recent_daily: ProductionDailySummary[]
}

export interface SaleLine extends JsonRecord {
  id: Id
  sale_id?: Id
  item_id: Id
  quantity: Numeric
  unit_price: Numeric
  discount: Numeric
  line_total?: Numeric
  unit_cost?: Numeric
  line_cogs?: Numeric
  item_name?: string | null
  item?: {
    id?: Id
    name: string
    sku?: string | null
    unit?: string | null
  } | null
}

export interface Payment extends JsonRecord {
  id: Id
  reference_no: string
  payment_date: string
  amount: Numeric
  method: string
  notes?: string | null
  status?: string | null
  is_initial?: boolean
}

export interface Sale extends JsonRecord {
  id: Id
  reference_no: string
  invoice_no: string
  sale_date: string
  customer_name: string
  customer_phone?: string | null
  payment_method?: string | null
  total_amount?: Numeric | null
  total_cogs?: Numeric | null
  paid_amount?: Numeric | null
  balance_due?: Numeric | null
  payment_status?: string
  status: string
  sale_items: SaleLine[]
  sale_payments: Payment[]
}

export interface PayrollLine extends JsonRecord {
  id: Id
  payroll_id?: Id
  line_no?: number
  line_kind?: string
  earning_type?: string
  type?: string
  description: string
  quantity?: Numeric | null
  rate?: Numeric | null
  amount: Numeric
  account_code?: string | null
  source_daily_work_id?: Id | null
  source_conversion_worker_id?: Id | null
  source_manual_piecework_id?: Id | null
}

export interface Payroll extends JsonRecord {
  id: Id
  reference_no: string
  payroll_date: string
  salary_month: string
  employee_id: Id
  regular_earnings?: Numeric
  daily_wages?: Numeric
  piecework_earnings?: Numeric
  gross_pay?: Numeric | null
  deductions_total?: Numeric | null
  employer_contributions?: Numeric
  net_pay?: Numeric | null
  paid_amount?: Numeric
  balance_due?: Numeric | null
  payment_status?: string
  status: string
  employee?: Partial<Pick<
    Employee,
    | 'id'
    | 'employee_no'
    | 'name'
    | 'nic'
    | 'phone'
    | 'address'
    | 'epf_no'
    | 'etf_ref'
    | 'joined_date'
    | 'job_role'
    | 'employment_type'
    | 'shift'
    | 'pay_model'
    | 'monthly_rate'
    | 'daily_rate'
    | 'ot_rate'
    | 'bank_details'
    | 'status'
  >> & { name: string } | null
  employee_name?: string | null
  employee_no?: string | null
  payroll_details: PayrollLine[]
  payroll_payments: Payment[]
}

export interface OpenEarning extends JsonRecord {
  employee_id: Id
  employee_no?: string | null
  employee_name: string
  work_date: string
  source_type: string
  source_id: Id
  description: string
  quantity: Numeric
  rate: Numeric
  amount: Numeric
}

export interface InventoryAdjustment extends JsonRecord {
  id: Id
  reference_no: string
  adjustment_date: string
  item_id: Id
  direction: 'positive' | 'negative'
  quantity: Numeric
  value: Numeric
  notes?: string | null
  status: string
}

export interface JournalLine extends JsonRecord {
  id?: Id
  journal_entry_id?: Id
  line_no?: number
  account_id?: number | string
  account_code?: string
  account?: string
  description?: string | null
  debit: Numeric
  credit: Numeric
  accounts?: {
    id?: number | string
    code?: string
    name?: string
    category?: string
  } | null
}

export interface Journal extends JsonRecord {
  id: Id
  reference_no: string
  journal_date: string
  memo: string
  source_type?: string | null
  source_module?: string | null
  source_id?: Id | null
  reversal_of_id?: Id | null
  status?: string
  journal_lines: JournalLine[]
  entry_date?: string
  date?: string
}

export interface LedgerRow extends JournalLine {
  journal_id?: Id
  reference_no?: string
  entry_date?: string
  date?: string
  source_module?: string
  source_type?: string
  account_name?: string
  category?: string
  balance?: Numeric
  journal_entries?: {
    id?: Id
    reference_no?: string
    journal_date?: string
    source_type?: string
    memo?: string
    reversal_of_id?: Id | null
  } | null
}

export interface AccountBalance extends JsonRecord {
  account_id?: number | string
  account_code: string
  account_name: string
  category: string
  debit_total: Numeric
  credit_total: Numeric
  balance: Numeric
  debit?: Numeric
  credit?: Numeric
}

export interface EmployeePayload {
  employee_no?: string | null
  name: string
  nic?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
  date_of_birth?: string | null
  epf_no?: string | null
  etf_ref?: string | null
  tax_no?: string | null
  joined_date: string
  left_date?: string | null
  job_role?: string | null
  department?: string | null
  employment_type?: string | null
  shift?: string | null
  pay_model: 'monthly' | 'daily' | 'hybrid' | 'piecework'
  pay_effective_from: string
  monthly_rate: number
  daily_rate: number
  ot_rate: number
  daily_on_conversion: boolean
  standard_hours_per_day: number
  standard_days_per_month: number
  employee_epf_rate: number
  employer_epf_rate: number
  employer_etf_rate: number
  pay_notes?: string | null
  emergency_contact?: EmergencyContact | null
  payroll_defaults: EmployeePayrollDefaults
  bank_details?: JsonRecord | null
  status: 'active' | 'inactive'
}

export interface ReportPayload extends JsonRecord {
  generated_at?: string
  filters?: JsonRecord
  totals?: JsonRecord
  items?: JsonRecord[]
}
