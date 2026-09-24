-- CK SYS V3 - Supabase ERP foundation
-- PostgreSQL 15+ / Supabase hosted Postgres
--
-- Design guarantees:
--   * all business timestamps are timezone-aware (timestamptz) and therefore
--     stored as UTC instants by PostgreSQL;
--   * money uses numeric(20,2), rates numeric(20,6), and quantities
--     numeric(20,6) -- never floating point;
--   * journal lines and stock movements are append-only;
--   * a deferred constraint trigger rejects incomplete/unbalanced journals;
--   * business mutations are routed through a permission-checked
--     public.erp_execute facade and are atomic;
--   * direct Data API writes are rejected by a transaction-local RPC guard;
--   * RLS and explicit grants are both required for every exposed object.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Keep future public objects private until a migration grants the exact access
-- they require. This is explicit so behavior does not depend on the project's
-- Data API "automatically expose" dashboard setting.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Used by the ILIKE search filters exposed by the Python API. Supabase ships
-- pg_trgm, but it is still opt-in per project.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Identity, profiles, and normalized RBAC
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) <= 200),
  constraint profiles_email_length check (email is null or char_length(email) <= 320)
);

create table public.roles (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  description text,
  is_system boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roles_code_format check (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint roles_name_not_blank check (btrim(name) <> '')
);

create table public.permissions (
  id bigint generated always as identity primary key,
  code text not null unique,
  description text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint permissions_code_format check (code ~ '^[a-z][a-z0-9_.]{2,95}$'),
  constraint permissions_description_not_blank check (btrim(description) <> '')
);

create table public.user_roles (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role_id bigint not null references public.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (user_id, role_id)
);

create table public.role_permissions (
  role_id bigint not null references public.roles(id) on delete cascade,
  permission_id bigint not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (role_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- Workforce and rate masters
-- ---------------------------------------------------------------------------

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_no text not null unique,
  name text not null,
  nic text,
  phone text,
  address text,
  epf_no text,
  etf_ref text,
  joined_date date not null,
  left_date date,
  job_role text,
  employment_type text,
  shift text,
  pay_model text not null default 'monthly',
  monthly_rate numeric(20,2) not null default 0,
  daily_rate numeric(20,2) not null default 0,
  ot_rate numeric(20,2) not null default 0,
  daily_on_conversion boolean not null default false,
  bank_details jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint employees_employee_no_not_blank check (btrim(employee_no) <> ''),
  constraint employees_name_not_blank check (btrim(name) <> ''),
  constraint employees_dates_valid check (left_date is null or left_date >= joined_date),
  constraint employees_pay_model_valid check (pay_model in ('monthly', 'daily', 'hybrid', 'piecework')),
  constraint employees_rates_nonnegative check (monthly_rate >= 0 and daily_rate >= 0 and ot_rate >= 0),
  constraint employees_bank_details_object check (bank_details is null or jsonb_typeof(bank_details) = 'object'),
  constraint employees_status_valid check (status in ('active', 'inactive'))
);

create unique index employees_nic_unique_idx
  on public.employees (lower(nic)) where nic is not null and btrim(nic) <> '';
create unique index employees_epf_no_unique_idx
  on public.employees (lower(epf_no)) where epf_no is not null and btrim(epf_no) <> '';
create index employees_status_name_idx on public.employees (status, name);

create table public.piecework_rates (
  id uuid primary key default gen_random_uuid(),
  work_type text not null,
  rate_per_kg numeric(20,6) not null,
  effective_from date not null,
  effective_to date,
  status text not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint piecework_rates_work_type_not_blank check (btrim(work_type) <> ''),
  constraint piecework_rates_rate_positive check (rate_per_kg > 0),
  constraint piecework_rates_dates_valid check (effective_to is null or effective_to >= effective_from),
  constraint piecework_rates_status_valid check (status in ('active', 'inactive')),
  unique (work_type, effective_from)
);

create index piecework_rates_lookup_idx
  on public.piecework_rates (lower(work_type), status, effective_from desc);

-- ---------------------------------------------------------------------------
-- Inventory and chart of accounts masters
-- ---------------------------------------------------------------------------

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  stage text not null,
  unit text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint inventory_items_sku_not_blank check (btrim(sku) <> ''),
  constraint inventory_items_name_not_blank check (btrim(name) <> ''),
  constraint inventory_items_stage_valid check (stage in ('bulk', 'chip', 'finished')),
  constraint inventory_items_unit_not_blank check (btrim(unit) <> '')
);

create unique index inventory_items_stage_name_unique_idx
  on public.inventory_items (stage, lower(name));
create index inventory_items_stage_active_idx
  on public.inventory_items (stage, is_active, name);

create table public.accounts (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null unique,
  category text not null,
  normal_side text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint accounts_code_format check (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  constraint accounts_name_not_blank check (btrim(name) <> ''),
  constraint accounts_category_valid check (category in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  constraint accounts_normal_side_valid check (normal_side in ('debit', 'credit')),
  constraint accounts_category_side_valid check (
    (category in ('asset', 'expense') and normal_side = 'debit') or
    (category in ('liability', 'equity', 'revenue') and normal_side = 'credit')
  )
);

create unique index accounts_name_ci_unique_idx on public.accounts (lower(name));
create index accounts_category_active_idx on public.accounts (category, is_active, code);

-- ---------------------------------------------------------------------------
-- Immutable journal / ledger
-- ---------------------------------------------------------------------------

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  journal_date date not null,
  memo text not null,
  source_type text not null,
  source_id uuid,
  reversal_of_id uuid references public.journal_entries(id) on delete restrict,
  status text not null default 'posted',
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint journal_entries_reference_not_blank check (btrim(reference_no) <> ''),
  constraint journal_entries_memo_not_blank check (btrim(memo) <> ''),
  constraint journal_entries_source_not_blank check (btrim(source_type) <> ''),
  constraint journal_entries_not_self_reversal check (reversal_of_id is null or reversal_of_id <> id),
  constraint journal_entries_status_valid check (status in ('posted', 'reversed'))
);

create unique index journal_entries_one_reversal_idx
  on public.journal_entries (reversal_of_id) where reversal_of_id is not null;
create index journal_entries_date_idx on public.journal_entries (journal_date desc, created_at desc);
create index journal_entries_source_idx on public.journal_entries (source_type, source_id);

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete restrict,
  line_no smallint not null,
  account_id bigint not null references public.accounts(id) on delete restrict,
  description text not null,
  debit numeric(20,2) not null default 0,
  credit numeric(20,2) not null default 0,
  created_at timestamptz not null default now(),
  constraint journal_lines_line_no_positive check (line_no > 0),
  constraint journal_lines_description_not_blank check (btrim(description) <> ''),
  constraint journal_lines_one_side_only check (
    (debit > 0 and credit = 0) or (credit > 0 and debit = 0)
  ),
  unique (journal_entry_id, line_no)
);

create index journal_lines_account_entry_idx on public.journal_lines (account_id, journal_entry_id);

-- ---------------------------------------------------------------------------
-- Source transactions
-- ---------------------------------------------------------------------------

create table public.raw_material_purchases (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  purchase_date date not null,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  supplier_name text,
  supplier_phone text,
  quantity_kg numeric(20,6) not null,
  total_cost numeric(20,2) not null,
  unit_cost numeric(20,6) generated always as (round(total_cost / quantity_kg, 6)) stored,
  payment_method text not null,
  notes text,
  status text not null default 'posted',
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  replaces_id uuid references public.raw_material_purchases(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint raw_material_purchases_reference_not_blank check (btrim(reference_no) <> ''),
  constraint raw_material_purchases_quantity_positive check (quantity_kg > 0),
  constraint raw_material_purchases_cost_positive check (total_cost > 0),
  constraint raw_material_purchases_payment_not_blank check (btrim(payment_method) <> ''),
  constraint raw_material_purchases_status_valid check (status in ('posted', 'reversed')),
  constraint raw_material_purchases_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create index raw_material_purchases_item_date_idx
  on public.raw_material_purchases (item_id, purchase_date desc) where status = 'posted';
create index raw_material_purchases_supplier_idx
  on public.raw_material_purchases (lower(supplier_name)) where supplier_name is not null;

create table public.conversions (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  conversion_date date not null,
  source_item_id uuid not null references public.inventory_items(id) on delete restrict,
  output_item_id uuid not null references public.inventory_items(id) on delete restrict,
  chip_type text,
  input_kg numeric(20,6) not null,
  output_kg numeric(20,6) not null,
  waste_kg numeric(20,6) generated always as (greatest(input_kg - output_kg, 0::numeric)) stored,
  material_cost numeric(20,2) not null,
  labor_cost numeric(20,2) not null,
  overhead_cost numeric(20,2) not null,
  total_converted_cost numeric(20,2) not null,
  output_unit_cost numeric(20,6) generated always as (round(total_converted_cost / output_kg, 6)) stored,
  status text not null default 'posted',
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  replaces_id uuid references public.conversions(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint conversions_reference_not_blank check (btrim(reference_no) <> ''),
  constraint conversions_items_distinct check (source_item_id <> output_item_id),
  constraint conversions_quantities_positive check (input_kg > 0 and output_kg > 0),
  constraint conversions_output_tolerance check (output_kg <= input_kg * 1.02),
  constraint conversions_costs_valid check (
    material_cost > 0 and labor_cost > 0 and overhead_cost >= 0 and
    total_converted_cost = material_cost + labor_cost + overhead_cost
  ),
  constraint conversions_status_valid check (status in ('posted', 'reversed')),
  constraint conversions_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create index conversions_source_date_idx
  on public.conversions (source_item_id, conversion_date desc) where status = 'posted';
create index conversions_output_date_idx
  on public.conversions (output_item_id, conversion_date desc) where status = 'posted';

create table public.conversion_workers (
  id uuid primary key default gen_random_uuid(),
  conversion_id uuid not null references public.conversions(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  rate_id uuid references public.piecework_rates(id) on delete set null,
  work_date date not null,
  task text not null,
  quantity_kg numeric(20,6) not null,
  rate_per_kg numeric(20,6) not null,
  amount numeric(20,2) not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint conversion_workers_task_not_blank check (btrim(task) <> ''),
  constraint conversion_workers_values_positive check (quantity_kg > 0 and rate_per_kg > 0 and amount > 0),
  constraint conversion_workers_amount_matches check (amount = round(quantity_kg * rate_per_kg, 2))
);

create index conversion_workers_conversion_idx on public.conversion_workers (conversion_id);
create index conversion_workers_employee_date_idx on public.conversion_workers (employee_id, work_date desc);

create table public.daily_work (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  employee_id uuid not null references public.employees(id) on delete restrict,
  work_date date not null,
  manual_work_units numeric(12,4) not null default 0,
  automatic_work_units numeric(12,4) not null default 0,
  daily_rate numeric(20,2) not null default 0,
  work_units numeric(12,4) generated always as (greatest(manual_work_units, automatic_work_units)) stored,
  base_amount numeric(20,2) generated always as (round(greatest(manual_work_units, automatic_work_units) * daily_rate, 2)) stored,
  auto_created boolean not null default false,
  notes text,
  revision integer not null default 1,
  status text not null default 'posted',
  current_journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  replaces_id uuid references public.daily_work(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint daily_work_reference_not_blank check (btrim(reference_no) <> ''),
  constraint daily_work_units_nonnegative check (manual_work_units >= 0 and automatic_work_units >= 0),
  constraint daily_work_automatic_units_valid check (automatic_work_units in (0, 1)),
  constraint daily_work_rate_nonnegative check (daily_rate >= 0),
  constraint daily_work_revision_positive check (revision > 0),
  constraint daily_work_status_valid check (status in ('posted', 'reversed')),
  constraint daily_work_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create unique index daily_work_employee_date_posted_idx
  on public.daily_work (employee_id, work_date) where status = 'posted';
create index daily_work_employee_date_idx on public.daily_work (employee_id, work_date desc);

create table public.daily_work_piecework (
  id uuid primary key default gen_random_uuid(),
  daily_work_id uuid not null references public.daily_work(id) on delete restrict,
  task text not null,
  quantity_kg numeric(20,6) not null,
  rate_per_kg numeric(20,6) not null,
  amount numeric(20,2) not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint daily_work_piecework_task_not_blank check (btrim(task) <> ''),
  constraint daily_work_piecework_values_positive check (quantity_kg > 0 and rate_per_kg > 0 and amount > 0),
  constraint daily_work_piecework_amount_matches check (amount = round(quantity_kg * rate_per_kg, 2))
);

create index daily_work_piecework_daily_work_idx on public.daily_work_piecework (daily_work_id);

create table public.daily_work_conversion_links (
  daily_work_id uuid not null references public.daily_work(id) on delete restrict,
  conversion_worker_id uuid not null unique references public.conversion_workers(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  primary key (daily_work_id, conversion_worker_id)
);

create table public.production_runs (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  production_date date not null,
  shift text,
  machine text,
  operator_employee_id uuid not null references public.employees(id) on delete restrict,
  chip_item_id uuid not null references public.inventory_items(id) on delete restrict,
  finished_item_id uuid not null references public.inventory_items(id) on delete restrict,
  input_kg numeric(20,6) not null,
  output_quantity numeric(20,6) not null,
  working_hours numeric(12,4) not null default 0,
  material_cost numeric(20,2) not null,
  overhead_cost numeric(20,2) not null,
  total_cost numeric(20,2) not null,
  output_unit_cost numeric(20,6) generated always as (round(total_cost / output_quantity, 6)) stored,
  notes text,
  status text not null default 'posted',
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  replaces_id uuid references public.production_runs(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint production_runs_reference_not_blank check (btrim(reference_no) <> ''),
  constraint production_runs_items_distinct check (chip_item_id <> finished_item_id),
  constraint production_runs_quantities_positive check (input_kg > 0 and output_quantity > 0),
  constraint production_runs_hours_nonnegative check (working_hours >= 0),
  constraint production_runs_costs_valid check (
    material_cost > 0 and overhead_cost >= 0 and total_cost = material_cost + overhead_cost
  ),
  constraint production_runs_status_valid check (status in ('posted', 'reversed')),
  constraint production_runs_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create index production_runs_input_date_idx
  on public.production_runs (chip_item_id, production_date desc) where status = 'posted';
create index production_runs_output_date_idx
  on public.production_runs (finished_item_id, production_date desc) where status = 'posted';
create index production_runs_operator_date_idx
  on public.production_runs (operator_employee_id, production_date desc);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  invoice_no text not null unique,
  sale_date date not null,
  customer_name text not null,
  customer_phone text,
  payment_method text not null,
  total_amount numeric(20,2) not null,
  total_cogs numeric(20,2) not null,
  paid_amount numeric(20,2) not null default 0,
  balance_due numeric(20,2) generated always as (greatest(total_amount - paid_amount, 0::numeric)) stored,
  payment_status text not null default 'unpaid',
  status text not null default 'posted',
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  replaces_id uuid references public.sales(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint sales_reference_not_blank check (btrim(reference_no) <> ''),
  constraint sales_invoice_not_blank check (btrim(invoice_no) <> ''),
  constraint sales_customer_not_blank check (btrim(customer_name) <> ''),
  constraint sales_payment_method_not_blank check (btrim(payment_method) <> ''),
  constraint sales_amounts_valid check (total_amount > 0 and total_cogs >= 0 and paid_amount >= 0 and paid_amount <= total_amount),
  constraint sales_payment_status_valid check (payment_status in ('unpaid', 'partial', 'paid')),
  constraint sales_payment_status_matches check (
    (paid_amount = 0 and payment_status = 'unpaid') or
    (paid_amount > 0 and paid_amount < total_amount and payment_status = 'partial') or
    (paid_amount = total_amount and payment_status = 'paid')
  ),
  constraint sales_status_valid check (status in ('posted', 'reversed')),
  constraint sales_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create index sales_date_idx on public.sales (sale_date desc) where status = 'posted';
create index sales_customer_date_idx on public.sales (lower(customer_name), sale_date desc);
create index sales_open_idx on public.sales (sale_date desc, balance_due) where status = 'posted' and payment_status <> 'paid';

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity numeric(20,6) not null,
  unit_price numeric(20,6) not null,
  discount numeric(20,2) not null default 0,
  line_total numeric(20,2) not null,
  unit_cost numeric(20,6) not null,
  line_cogs numeric(20,2) not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint sale_items_values_valid check (quantity > 0 and unit_price >= 0 and discount >= 0 and line_total > 0 and unit_cost >= 0 and line_cogs >= 0),
  constraint sale_items_line_total_matches check (line_total = round(quantity * unit_price - discount, 2)),
  constraint sale_items_cogs_matches check (line_cogs = round(quantity * unit_cost, 2)),
  unique (sale_id, item_id)
);

create index sale_items_item_sale_idx on public.sale_items (item_id, sale_id);

create table public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  sale_id uuid not null references public.sales(id) on delete restrict,
  payment_date date not null,
  amount numeric(20,2) not null,
  method text not null,
  notes text,
  is_initial boolean not null default false,
  status text not null default 'posted',
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint sale_payments_reference_not_blank check (btrim(reference_no) <> ''),
  constraint sale_payments_amount_positive check (amount > 0),
  constraint sale_payments_method_not_blank check (btrim(method) <> ''),
  constraint sale_payments_status_valid check (status in ('posted', 'reversed')),
  constraint sale_payments_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create index sale_payments_sale_date_idx
  on public.sale_payments (sale_id, payment_date desc) where status = 'posted';

create table public.payrolls (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  payroll_date date not null,
  salary_month text not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  regular_earnings numeric(20,2) not null,
  daily_wages numeric(20,2) not null,
  piecework_earnings numeric(20,2) not null,
  gross_pay numeric(20,2) not null,
  deductions_total numeric(20,2) not null,
  employer_contributions numeric(20,2) not null,
  net_pay numeric(20,2) not null,
  paid_amount numeric(20,2) not null default 0,
  payment_method text,
  balance_due numeric(20,2) generated always as (greatest(net_pay - paid_amount, 0::numeric)) stored,
  payment_status text not null default 'unpaid',
  status text not null default 'posted',
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  replaces_id uuid references public.payrolls(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint payrolls_reference_not_blank check (btrim(reference_no) <> ''),
  constraint payrolls_salary_month_format check (salary_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint payrolls_amounts_valid check (
    regular_earnings >= 0 and daily_wages >= 0 and piecework_earnings >= 0 and
    gross_pay = regular_earnings + daily_wages + piecework_earnings and gross_pay > 0 and
    deductions_total >= 0 and deductions_total <= gross_pay and employer_contributions >= 0 and
    net_pay = gross_pay - deductions_total and paid_amount >= 0 and paid_amount <= net_pay
  ),
  constraint payrolls_payment_status_valid check (payment_status in ('unpaid', 'partial', 'paid')),
  constraint payrolls_payment_status_matches check (
    (paid_amount = 0 and payment_status = 'unpaid') or
    (paid_amount > 0 and paid_amount < net_pay and payment_status = 'partial') or
    (paid_amount = net_pay and payment_status = 'paid')
  ),
  constraint payrolls_status_valid check (status in ('posted', 'reversed')),
  constraint payrolls_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create unique index payrolls_employee_month_posted_idx
  on public.payrolls (employee_id, salary_month) where status = 'posted';
create index payrolls_date_idx on public.payrolls (payroll_date desc);

create table public.payroll_details (
  id uuid primary key default gen_random_uuid(),
  payroll_id uuid not null references public.payrolls(id) on delete restrict,
  line_no smallint not null,
  line_kind text not null,
  earning_type text not null,
  description text not null,
  quantity numeric(20,6),
  rate numeric(20,6),
  amount numeric(20,2) not null,
  account_id bigint not null references public.accounts(id) on delete restrict,
  source_daily_work_id uuid references public.daily_work(id) on delete restrict,
  source_conversion_worker_id uuid references public.conversion_workers(id) on delete restrict,
  source_manual_piecework_id uuid references public.daily_work_piecework(id) on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint payroll_details_line_no_positive check (line_no > 0),
  constraint payroll_details_kind_valid check (line_kind in ('earning', 'daily_wage', 'conversion_piecework', 'manual_piecework', 'deduction', 'employer_contribution')),
  constraint payroll_details_description_not_blank check (btrim(description) <> ''),
  constraint payroll_details_amount_positive check (amount > 0),
  constraint payroll_details_quantity_rate_valid check ((quantity is null or quantity >= 0) and (rate is null or rate >= 0)),
  constraint payroll_details_one_source check (
    num_nonnulls(source_daily_work_id, source_conversion_worker_id, source_manual_piecework_id) <= 1
  ),
  unique (payroll_id, line_no)
);

create unique index payroll_details_daily_claim_unique_idx
  on public.payroll_details (source_daily_work_id)
  where source_daily_work_id is not null and is_active;
create unique index payroll_details_conversion_claim_unique_idx
  on public.payroll_details (source_conversion_worker_id)
  where source_conversion_worker_id is not null and is_active;
create unique index payroll_details_manual_claim_unique_idx
  on public.payroll_details (source_manual_piecework_id)
  where source_manual_piecework_id is not null and is_active;
create index payroll_details_payroll_idx on public.payroll_details (payroll_id, line_no);

create table public.payroll_payments (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  payroll_id uuid not null references public.payrolls(id) on delete restrict,
  payment_date date not null,
  amount numeric(20,2) not null,
  method text not null,
  notes text,
  is_initial boolean not null default false,
  status text not null default 'posted',
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint payroll_payments_reference_not_blank check (btrim(reference_no) <> ''),
  constraint payroll_payments_amount_positive check (amount > 0),
  constraint payroll_payments_method_not_blank check (btrim(method) <> ''),
  constraint payroll_payments_status_valid check (status in ('posted', 'reversed')),
  constraint payroll_payments_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create index payroll_payments_payroll_date_idx
  on public.payroll_payments (payroll_id, payment_date desc) where status = 'posted';

create table public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  adjustment_date date not null,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  direction text not null,
  quantity numeric(20,6) not null,
  value numeric(20,2) not null,
  notes text not null,
  status text not null default 'posted',
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  reversal_journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  replaces_id uuid references public.stock_adjustments(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint stock_adjustments_reference_not_blank check (btrim(reference_no) <> ''),
  constraint stock_adjustments_direction_valid check (direction in ('positive', 'negative')),
  constraint stock_adjustments_values_positive check (quantity > 0 and value > 0),
  constraint stock_adjustments_notes_not_blank check (btrim(notes) <> ''),
  constraint stock_adjustments_status_valid check (status in ('posted', 'reversed')),
  constraint stock_adjustments_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_journal_entry_id is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null and reversal_journal_entry_id is not null)
  )
);

create index stock_adjustments_item_date_idx
  on public.stock_adjustments (item_id, adjustment_date desc) where status = 'posted';

-- ---------------------------------------------------------------------------
-- Atomic inventory state and immutable movement history
-- ---------------------------------------------------------------------------

create table public.inventory_balances (
  item_id uuid primary key references public.inventory_items(id) on delete restrict,
  quantity_on_hand numeric(20,6) not null default 0,
  inventory_value numeric(20,2) not null default 0,
  last_movement_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint inventory_balances_quantity_nonnegative check (quantity_on_hand >= 0),
  constraint inventory_balances_value_nonnegative check (inventory_value >= 0),
  constraint inventory_balances_zero_consistency check (
    (quantity_on_hand = 0 and inventory_value = 0) or quantity_on_hand > 0
  )
);

create table public.stock_movements (
  id bigint generated always as identity primary key,
  movement_date date not null,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity_delta numeric(20,6) not null,
  value_delta numeric(20,2) not null,
  source_type text not null,
  source_id uuid not null,
  journal_entry_id uuid not null references public.journal_entries(id) on delete restrict,
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint stock_movements_quantity_nonzero check (quantity_delta <> 0),
  constraint stock_movements_sign_consistent check (
    (quantity_delta > 0 and value_delta >= 0) or
    (quantity_delta < 0 and value_delta <= 0)
  ),
  constraint stock_movements_source_not_blank check (btrim(source_type) <> ''),
  constraint stock_movements_reason_not_blank check (btrim(reason) <> '')
);

create index stock_movements_item_date_idx
  on public.stock_movements (item_id, movement_date desc, id desc);
create index stock_movements_source_idx
  on public.stock_movements (source_type, source_id);
create index stock_movements_journal_idx on public.stock_movements (journal_entry_id);

-- ---------------------------------------------------------------------------
-- Audit and idempotency
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  operation text not null,
  entity_table text not null,
  entity_id text,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  idempotency_key text,
  request_id text,
  constraint audit_log_operation_not_blank check (btrim(operation) <> ''),
  constraint audit_log_entity_not_blank check (btrim(entity_table) <> ''),
  constraint audit_log_action_valid check (action in ('insert', 'update', 'delete', 'reverse', 'execute'))
);

create index audit_log_actor_time_idx on public.audit_log (actor_user_id, occurred_at desc);
create index audit_log_entity_time_idx on public.audit_log (entity_table, entity_id, occurred_at desc);
create index audit_log_operation_time_idx on public.audit_log (operation, occurred_at desc);

create table public.idempotency_keys (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  operation text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  primary key (actor_user_id, idempotency_key),
  constraint idempotency_keys_key_length check (char_length(idempotency_key) between 8 and 200),
  constraint idempotency_keys_operation_not_blank check (btrim(operation) <> ''),
  constraint idempotency_keys_hash_format check (request_hash ~ '^[0-9a-f]{32}$'),
  constraint idempotency_keys_completion_state check (
    (response is null and completed_at is null) or
    (response is not null and completed_at is not null)
  )
);

create index idempotency_keys_expiry_idx on public.idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Large-data access paths
-- ---------------------------------------------------------------------------

-- Every pageable collection has a deterministic tie-breaker. These indexes
-- also support PostgREST keyset filters such as
--   business_date=lt.<cursor-date>&id=lt.<cursor-id>&order=business_date.desc,id.desc
-- without progressively scanning OFFSET rows.
create index employees_name_id_idx on public.employees (name, id);
create index employees_joined_date_id_idx on public.employees (joined_date desc, id desc);
create index employees_created_at_id_idx on public.employees (created_at desc, id desc);
create index piecework_rates_effective_id_idx on public.piecework_rates (effective_from desc, id desc);
create index inventory_items_name_id_idx on public.inventory_items (name, id);
create index journal_entries_page_idx on public.journal_entries (journal_date desc, id desc);
create index raw_material_purchases_page_idx on public.raw_material_purchases (purchase_date desc, id desc);
create index raw_material_purchases_created_page_idx on public.raw_material_purchases (created_at desc, id desc);
create index conversions_page_idx on public.conversions (conversion_date desc, id desc);
create index conversions_created_page_idx on public.conversions (created_at desc, id desc);
create index daily_work_page_idx on public.daily_work (work_date desc, id desc);
create index daily_work_created_page_idx on public.daily_work (created_at desc, id desc);
create index production_runs_page_idx on public.production_runs (production_date desc, id desc);
create index production_runs_created_page_idx on public.production_runs (created_at desc, id desc);
create index sales_page_idx on public.sales (sale_date desc, id desc);
create index sales_created_page_idx on public.sales (created_at desc, id desc);
create index sale_payments_page_idx on public.sale_payments (payment_date desc, id desc);
create index payrolls_page_idx on public.payrolls (payroll_date desc, id desc);
create index payrolls_created_page_idx on public.payrolls (created_at desc, id desc);
create index payroll_payments_page_idx on public.payroll_payments (payment_date desc, id desc);
create index stock_adjustments_page_idx on public.stock_adjustments (adjustment_date desc, id desc);
create index stock_adjustments_created_page_idx on public.stock_adjustments (created_at desc, id desc);
create index stock_movements_page_idx on public.stock_movements (movement_date desc, id desc);
create index audit_log_page_idx on public.audit_log (occurred_at desc, id desc);

-- The API deliberately offers contains searches. B-tree indexes cannot serve
-- leading-wildcard ILIKE, so use trigram GIN indexes for those endpoints.
create index employees_name_trgm_idx on public.employees
  using gin (name extensions.gin_trgm_ops);
create index piecework_rates_work_type_trgm_idx on public.piecework_rates
  using gin (work_type extensions.gin_trgm_ops);
create index inventory_items_name_trgm_idx on public.inventory_items
  using gin (name extensions.gin_trgm_ops);
create index raw_material_purchases_reference_trgm_idx on public.raw_material_purchases
  using gin (reference_no extensions.gin_trgm_ops);
create index conversions_reference_trgm_idx on public.conversions
  using gin (reference_no extensions.gin_trgm_ops);
create index production_runs_reference_trgm_idx on public.production_runs
  using gin (reference_no extensions.gin_trgm_ops);
create index sales_reference_trgm_idx on public.sales
  using gin (reference_no extensions.gin_trgm_ops);
create index payrolls_reference_trgm_idx on public.payrolls
  using gin (reference_no extensions.gin_trgm_ops);
create index stock_adjustments_reference_trgm_idx on public.stock_adjustments
  using gin (reference_no extensions.gin_trgm_ops);

-- PostgreSQL does not create indexes for referencing columns. Add any missing
-- single-column FK access path (including audit actor columns) deterministically.
do $fk_indexes$
declare
  v_fk record;
  v_index_name text;
begin
  for v_fk in
    select
      n.nspname as schema_name,
      c.relname as table_name,
      a.attname as column_name,
      pc.conname
    from pg_catalog.pg_constraint pc
    join pg_catalog.pg_class c on c.oid = pc.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a
      on a.attrelid = pc.conrelid and a.attnum = pc.conkey[1]
    where pc.contype = 'f'
      and n.nspname = 'public'
      and pg_catalog.array_length(pc.conkey, 1) = 1
      and not exists (
        select 1
        from pg_catalog.pg_index i
        where i.indrelid = pc.conrelid
          and i.indisvalid
          and i.indpred is null
          and i.indkey[0] = pc.conkey[1]
      )
  loop
    v_index_name := pg_catalog.left(
      v_fk.table_name || '_' || v_fk.column_name || '_fk_' ||
      pg_catalog.substr(pg_catalog.md5(v_fk.conname), 1, 8) || '_idx',
      63
    );
    execute pg_catalog.format(
      'create index if not exists %I on %I.%I (%I)',
      v_index_name, v_fk.schema_name, v_fk.table_name, v_fk.column_name
    );
  end loop;
end;
$fk_indexes$;

-- ---------------------------------------------------------------------------
-- Seeded RBAC and chart of accounts
-- ---------------------------------------------------------------------------

insert into public.roles (code, name, description) values
  ('admin', 'Administrator', 'Full ERP administration and operations'),
  ('accountant', 'Accountant', 'Finance, settlements, payroll, and reports'),
  ('operations', 'Operations', 'Procurement, conversion, production, inventory, and sales'),
  ('payroll', 'Payroll', 'Employee, attendance, payroll, and payroll reporting'),
  ('viewer', 'Viewer', 'Read-only ERP access')
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    updated_at = now();

insert into public.permissions (code, description) values
  ('system.admin', 'Full system administration'),
  ('dashboard.read', 'Read the consolidated dashboard'),
  ('employees.read', 'Read employee and work data'),
  ('employees.write', 'Create and amend employee and work data'),
  ('inventory.read', 'Read inventory and procurement data'),
  ('inventory.write', 'Post inventory and procurement transactions'),
  ('production.read', 'Read production data'),
  ('production.write', 'Post production transactions'),
  ('sales.read', 'Read sales and receipts'),
  ('sales.write', 'Post sales and receipts'),
  ('payroll.read', 'Read payroll and open earnings'),
  ('payroll.write', 'Post payroll and payroll settlements'),
  ('finance.read', 'Read journals, ledger, and account balances'),
  ('finance.write', 'Post and reverse manual journals'),
  ('reports.read', 'Read operational and financial reports'),
  ('audit.read', 'Read the immutable audit trail')
on conflict (code) do update
set description = excluded.description,
    updated_at = now();

with role_grants(role_code, permission_code) as (
  values
    ('accountant','dashboard.read'), ('accountant','employees.read'),
    ('accountant','inventory.read'), ('accountant','production.read'),
    ('accountant','sales.read'), ('accountant','sales.write'),
    ('accountant','payroll.read'), ('accountant','payroll.write'),
    ('accountant','finance.read'), ('accountant','finance.write'),
    ('accountant','reports.read'), ('accountant','audit.read'),
    ('operations','dashboard.read'), ('operations','employees.read'),
    ('operations','inventory.read'), ('operations','inventory.write'),
    ('operations','production.read'), ('operations','production.write'),
    ('operations','sales.read'), ('operations','sales.write'),
    ('operations','reports.read'),
    ('payroll','dashboard.read'), ('payroll','employees.read'),
    ('payroll','employees.write'), ('payroll','payroll.read'),
    ('payroll','payroll.write'), ('payroll','finance.read'),
    ('payroll','reports.read'),
    ('viewer','dashboard.read'), ('viewer','employees.read'),
    ('viewer','inventory.read'), ('viewer','production.read'),
    ('viewer','sales.read'), ('viewer','payroll.read'),
    ('viewer','finance.read'), ('viewer','reports.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from role_grants g
join public.roles r on r.code = g.role_code
join public.permissions p on p.code = g.permission_code
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'admin'
on conflict (role_id, permission_id) do nothing;

insert into public.accounts (code, name, category, normal_side) values
  ('CASH', 'Cash on Hand', 'asset', 'debit'),
  ('BANK', 'Bank', 'asset', 'debit'),
  ('ACCOUNTS_RECEIVABLE', 'Accounts Receivable', 'asset', 'debit'),
  ('RAW_MATERIAL_INVENTORY', 'Raw Material Inventory', 'asset', 'debit'),
  ('CHIP_INVENTORY', 'Converted Chip Inventory', 'asset', 'debit'),
  ('FINISHED_GOODS_INVENTORY', 'Finished Goods Inventory', 'asset', 'debit'),
  ('ACCOUNTS_PAYABLE', 'Accounts Payable', 'liability', 'credit'),
  ('WAGES_PAYABLE', 'Wages Payable', 'liability', 'credit'),
  ('PAYROLL_DEDUCTIONS_PAYABLE', 'Payroll Deductions Payable', 'liability', 'credit'),
  ('EMPLOYER_CONTRIBUTION_PAYABLE', 'Employer Contribution Payable', 'liability', 'credit'),
  ('OVERHEAD_PAYABLE', 'Production Overhead Payable', 'liability', 'credit'),
  ('OWNER_EQUITY', 'Owner Equity', 'equity', 'credit'),
  ('INVENTORY_GAIN', 'Inventory Gain', 'revenue', 'credit'),
  ('SALES_REVENUE', 'Sales Revenue', 'revenue', 'credit'),
  ('COGS', 'Cost of Goods Sold', 'expense', 'debit'),
  ('WAGES_EXPENSE', 'Wages Expense', 'expense', 'debit'),
  ('EMPLOYER_CONTRIBUTION_EXPENSE', 'Employer Contribution Expense', 'expense', 'debit'),
  ('INVENTORY_LOSS', 'Inventory Loss', 'expense', 'debit')
on conflict (code) do update
set name = excluded.name,
    category = excluded.category,
    normal_side = excluded.normal_side,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- Auth bootstrap and normalized authorization helpers
-- ---------------------------------------------------------------------------

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- New identities are deliberately pending. Creating an Auth user must never
  -- grant ERP access; an administrator must activate it and assign a role.
  insert into public.profiles (user_id, display_name, email, is_active)
  values (
    new.id,
    coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(pg_catalog.split_part(new.email, '@', 1), ''),
      ''
    ),
    new.email,
    false
  )
  on conflict (user_id) do update
  set email = excluded.email,
      updated_at = pg_catalog.now();

  return new;
end;
$function$;

revoke all on function private.handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_ck_sys on auth.users;
create trigger on_auth_user_created_ck_sys
after insert on auth.users
for each row execute function private.handle_new_auth_user();

-- Backfill users that existed before this migration. The earliest live Auth
-- identity is selected deterministically only when nobody is already admin.
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('ck_sys_v3:first_administrator', 0)
);

insert into public.profiles (user_id, display_name, email, is_active)
select
  u.id,
  coalesce(
    nullif(pg_catalog.btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(pg_catalog.split_part(u.email, '@', 1), ''),
    ''
  ),
  u.email,
  false
from auth.users u
where u.deleted_at is null
on conflict (user_id) do update
set email = excluded.email,
    updated_at = pg_catalog.now();

insert into public.user_roles (user_id, role_id, created_by)
select p.user_id, r.id, p.user_id
from public.profiles p
cross join public.roles r
where r.code = 'admin'
  and not exists (
    select 1
    from public.user_roles ur
    join public.roles ar on ar.id = ur.role_id
    where ar.code = 'admin'
  )
order by (
  select u.created_at from auth.users u where u.id = p.user_id
) asc nulls last, p.user_id
limit 1
on conflict (user_id, role_id) do nothing;

update public.profiles p
set is_active = true,
    updated_at = pg_catalog.now()
where exists (
  select 1
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id
  where ur.user_id = p.user_id and r.code = 'admin'
);

create or replace function private.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
     and exists (
       select 1
       from public.profiles pr
       join public.user_roles ur on ur.user_id = pr.user_id
       join public.role_permissions rp on rp.role_id = ur.role_id
       join public.permissions pe on pe.id = rp.permission_id
       where pr.user_id = (select auth.uid())
         and pr.is_active
         and pe.code = p_permission
     );
$function$;

create or replace function private.can_mutate(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
           pg_catalog.current_setting('app.erp_rpc_guard', true), ''
         ) = 'enabled'
     and private.has_permission(p_permission);
$function$;

create or replace function private.can_mutate_any(p_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
           pg_catalog.current_setting('app.erp_rpc_guard', true), ''
         ) = 'enabled'
     and exists (
       select 1 from pg_catalog.unnest(p_permissions) p(code)
       where private.has_permission(p.code)
     );
$function$;

create or replace function private.assert_permission(p_permission text)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if not private.has_permission(p_permission) then
    raise exception using
      errcode = '42501',
      message = 'ERP permission denied: ' || p_permission;
  end if;
end;
$function$;

create or replace function private.current_request_id()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_headers jsonb;
begin
  begin
    v_headers := nullif(
      pg_catalog.current_setting('request.headers', true), ''
    )::jsonb;
  exception when others then
    v_headers := null;
  end;
  return pg_catalog.left(v_headers ->> 'x-request-id', 200);
end;
$function$;

create or replace function private.new_reference(p_prefix text)
returns text
language sql
volatile
security invoker
set search_path = ''
as $function$
  select pg_catalog.upper(pg_catalog.left(pg_catalog.btrim(p_prefix), 12))
      || '-' || pg_catalog.to_char(pg_catalog.clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || '-' || pg_catalog.substr(
           pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12
         );
$function$;

create or replace function private.resolve_inventory_item(
  p_id_text text,
  p_name text,
  p_stage text,
  p_actor uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_id uuid;
  v_name text := nullif(pg_catalog.btrim(p_name), '');
  v_stage text := pg_catalog.lower(pg_catalog.btrim(p_stage));
begin
  if v_stage not in ('bulk', 'chip', 'finished') then
    raise exception using errcode = '22023', message = 'Invalid inventory stage';
  end if;

  if nullif(pg_catalog.btrim(p_id_text), '') is not null then
    begin
      v_id := p_id_text::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Invalid inventory item id';
    end;

    perform 1
    from public.inventory_items i
    where i.id = v_id and i.stage = v_stage and i.is_active;
    if not found then
      raise exception using errcode = 'P0001', message = 'Active ' || v_stage || ' inventory item not found';
    end if;
    return v_id;
  end if;

  if v_name is null or pg_catalog.char_length(v_name) > 160 then
    raise exception using errcode = '22023', message = 'A valid inventory item name is required';
  end if;

  -- Prevent duplicate expression-key inserts under concurrent requests.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-item:' || v_stage || ':' || pg_catalog.lower(v_name), 0)
  );

  select i.id into v_id
  from public.inventory_items i
  where i.stage = v_stage and pg_catalog.lower(i.name) = pg_catalog.lower(v_name)
  limit 1;

  if v_id is null then
    v_id := pg_catalog.gen_random_uuid();
    insert into public.inventory_items (
      id, sku, name, stage, unit, created_by, updated_by
    ) values (
      v_id,
      pg_catalog.upper(pg_catalog.substr(v_stage, 1, 3)) || '-' ||
        pg_catalog.substr(pg_catalog.replace(v_id::text, '-', ''), 1, 16),
      v_name,
      v_stage,
      case when v_stage = 'finished' then 'unit' else 'kg' end,
      p_actor,
      p_actor
    );
  end if;

  insert into public.inventory_balances (item_id)
  values (v_id)
  on conflict (item_id) do nothing;

  return v_id;
end;
$function$;

create or replace function private.resolve_account_id(
  p_code text,
  p_name text default null
)
returns bigint
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_id bigint;
begin
  if nullif(pg_catalog.btrim(p_code), '') is not null then
    select a.id into v_id
    from public.accounts a
    where a.code = pg_catalog.upper(pg_catalog.btrim(p_code)) and a.is_active;
  elsif nullif(pg_catalog.btrim(p_name), '') is not null then
    select a.id into v_id
    from public.accounts a
    where pg_catalog.lower(a.name) = pg_catalog.lower(pg_catalog.btrim(p_name)) and a.is_active;
  end if;

  if v_id is null then
    raise exception using errcode = 'P0001', message = 'Active ledger account not found';
  end if;
  return v_id;
end;
$function$;

create or replace function private.inventory_account_code(p_item_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_stage text;
begin
  select i.stage into v_stage from public.inventory_items i where i.id = p_item_id;
  return case v_stage
    when 'bulk' then 'RAW_MATERIAL_INVENTORY'
    when 'chip' then 'CHIP_INVENTORY'
    when 'finished' then 'FINISHED_GOODS_INVENTORY'
    else null
  end;
end;
$function$;

create or replace function private.settlement_account_code(p_method text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  return case pg_catalog.lower(pg_catalog.btrim(p_method))
    when 'cash' then 'CASH'
    when 'bank_transfer' then 'BANK'
    when 'cheque' then 'BANK'
    when 'other' then 'BANK'
    else null
  end;
end;
$function$;

create or replace function private.lock_inventory(p_item_ids uuid[])
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  if p_item_ids is null or pg_catalog.cardinality(p_item_ids) = 0 then
    return;
  end if;

  insert into public.inventory_balances (item_id)
  select distinct u.item_id
  from pg_catalog.unnest(p_item_ids) as u(item_id)
  where u.item_id is not null
  order by u.item_id
  on conflict (item_id) do nothing;

  -- All stock-changing functions call this once, in UUID order, before their
  -- first calculation. Consistent ordering prevents cross-item deadlocks.
  perform b.item_id
  from public.inventory_balances b
  where b.item_id = any(p_item_ids)
  order by b.item_id
  for update;
end;
$function$;

create or replace function private.apply_stock(
  p_item_id uuid,
  p_quantity_delta numeric,
  p_value_delta numeric,
  p_movement_date date,
  p_source_type text,
  p_source_id uuid,
  p_journal_entry_id uuid,
  p_reason text,
  p_actor uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_quantity numeric(20,6);
  v_value numeric(20,2);
begin
  if p_quantity_delta = 0 then
    raise exception using errcode = '22023', message = 'Stock movement quantity cannot be zero';
  end if;
  if (p_quantity_delta > 0 and p_value_delta < 0)
     or (p_quantity_delta < 0 and p_value_delta > 0) then
    raise exception using errcode = '22023', message = 'Stock movement quantity and value signs conflict';
  end if;

  select
    pg_catalog.round(b.quantity_on_hand + p_quantity_delta, 6),
    pg_catalog.round(b.inventory_value + p_value_delta, 2)
  into v_quantity, v_value
  from public.inventory_balances b
  where b.item_id = p_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'Inventory balance not initialized';
  end if;
  if v_quantity < 0 then
    raise exception using errcode = 'P0001', message = 'Insufficient inventory quantity';
  end if;
  if v_value < 0 then
    raise exception using errcode = 'P0001', message = 'Insufficient inventory value';
  end if;
  if v_quantity = 0 and v_value <> 0 then
    raise exception using errcode = 'P0001', message = 'A zero stock balance must have zero value';
  end if;

  update public.inventory_balances
  set quantity_on_hand = v_quantity,
      inventory_value = v_value,
      last_movement_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where item_id = p_item_id;

  insert into public.stock_movements (
    movement_date, item_id, quantity_delta, value_delta, source_type,
    source_id, journal_entry_id, reason, created_by
  ) values (
    p_movement_date, p_item_id, pg_catalog.round(p_quantity_delta, 6),
    pg_catalog.round(p_value_delta, 2), p_source_type, p_source_id,
    p_journal_entry_id, pg_catalog.left(pg_catalog.btrim(p_reason), 1000), p_actor
  );
end;
$function$;

create or replace function private.post_journal(
  p_journal_date date,
  p_memo text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_actor uuid,
  p_reference_no text default null,
  p_reversal_of_id uuid default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_id uuid := pg_catalog.gen_random_uuid();
  v_reference text := coalesce(
    nullif(pg_catalog.btrim(p_reference_no), ''), private.new_reference('JRN')
  );
  v_count integer;
  v_debit numeric(20,2);
  v_credit numeric(20,2);
begin
  if p_journal_date is null then
    raise exception using errcode = '22023', message = 'Journal date is required';
  end if;
  if nullif(pg_catalog.btrim(p_memo), '') is null then
    raise exception using errcode = '22023', message = 'Journal memo is required';
  end if;
  if pg_catalog.jsonb_typeof(p_lines) <> 'array' then
    raise exception using errcode = '22023', message = 'Journal lines must be an array';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.round(pg_catalog.sum(coalesce(nullif(e.line ->> 'debit', '')::numeric, 0)), 2),
    pg_catalog.round(pg_catalog.sum(coalesce(nullif(e.line ->> 'credit', '')::numeric, 0)), 2)
  into v_count, v_debit, v_credit
  from pg_catalog.jsonb_array_elements(p_lines) as e(line);

  if v_count < 2 or v_count > 500 then
    raise exception using errcode = '22023', message = 'A journal requires between 2 and 500 lines';
  end if;
  if v_debit <= 0 or v_debit <> v_credit then
    raise exception using errcode = '23514', message = 'Journal debits and credits must be positive and equal';
  end if;

  insert into public.journal_entries (
    id, reference_no, journal_date, memo, source_type, source_id,
    reversal_of_id, status, created_by
  ) values (
    v_id, pg_catalog.left(v_reference, 80), p_journal_date,
    pg_catalog.left(pg_catalog.btrim(p_memo), 500),
    pg_catalog.left(pg_catalog.btrim(p_source_type), 80), p_source_id,
    p_reversal_of_id, 'posted', p_actor
  );

  insert into public.journal_lines (
    journal_entry_id, line_no, account_id, description, debit, credit
  )
  select
    v_id,
    e.ordinality::smallint,
    private.resolve_account_id(e.line ->> 'account_code', e.line ->> 'account'),
    pg_catalog.left(
      coalesce(nullif(pg_catalog.btrim(e.line ->> 'description'), ''), pg_catalog.btrim(p_memo)),
      500
    ),
    pg_catalog.round(coalesce(nullif(e.line ->> 'debit', '')::numeric, 0), 2),
    pg_catalog.round(coalesce(nullif(e.line ->> 'credit', '')::numeric, 0), 2)
  from pg_catalog.jsonb_array_elements(p_lines) with ordinality as e(line, ordinality);

  return v_id;
end;
$function$;

create or replace function private.reverse_journal(
  p_original_id uuid,
  p_reversal_date date,
  p_actor uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_original public.journal_entries%rowtype;
  v_lines jsonb;
  v_reversal_id uuid;
begin
  select * into v_original
  from public.journal_entries j
  where j.id = p_original_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'Journal not found';
  end if;
  if v_original.status <> 'posted' then
    raise exception using errcode = 'P0001', message = 'Journal is already reversed';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'account_code', a.code,
      'description', 'Reversal: ' || jl.description,
      'debit', jl.credit,
      'credit', jl.debit
    ) order by jl.line_no
  ) into v_lines
  from public.journal_lines jl
  join public.accounts a on a.id = jl.account_id
  where jl.journal_entry_id = p_original_id;

  v_reversal_id := private.post_journal(
    coalesce(p_reversal_date, current_date),
    'Reversal: ' || coalesce(nullif(pg_catalog.btrim(p_reason), ''), v_original.memo),
    v_original.source_type || '.reversal',
    v_original.source_id,
    v_lines,
    p_actor,
    private.new_reference('REV'),
    p_original_id
  );

  update public.journal_entries set status = 'reversed' where id = p_original_id;
  return v_reversal_id;
end;
$function$;

create or replace function private.assert_journal_balanced()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_count bigint;
  v_debit numeric(20,2);
  v_credit numeric(20,2);
begin
  select pg_catalog.count(*), coalesce(pg_catalog.sum(l.debit), 0),
         coalesce(pg_catalog.sum(l.credit), 0)
  into v_count, v_debit, v_credit
  from public.journal_lines l
  where l.journal_entry_id = new.id;

  if v_count < 2 or v_debit <= 0 or v_debit <> v_credit then
    raise exception using
      errcode = '23514',
      message = 'Journal entry is incomplete or unbalanced';
  end if;
  return null;
end;
$function$;

create constraint trigger journal_entries_balanced_ck
after insert on public.journal_entries
deferrable initially deferred
for each row execute function private.assert_journal_balanced();

create or replace function private.require_rpc_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
    raise exception using
      errcode = '42501',
      message = 'Direct ERP table mutation is disabled; use erp_execute';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

create or replace function private.reject_row_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '55000',
    message = tg_table_name || ' is append-only';
end;
$function$;

do $guard_triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'employees', 'piecework_rates', 'inventory_items', 'accounts',
    'journal_entries', 'journal_lines', 'raw_material_purchases',
    'conversions', 'conversion_workers', 'daily_work',
    'daily_work_piecework', 'daily_work_conversion_links', 'production_runs',
    'sales', 'sale_items', 'sale_payments', 'payrolls', 'payroll_details',
    'payroll_payments', 'stock_adjustments', 'inventory_balances',
    'stock_movements', 'audit_log', 'idempotency_keys'
  ]
  loop
    execute pg_catalog.format(
      'create trigger %I before insert or update or delete on public.%I '
      || 'for each row execute function private.require_rpc_guard()',
      v_table || '_rpc_guard', v_table
    );
  end loop;

  foreach v_table in array array[
    'journal_lines', 'conversion_workers', 'daily_work_piecework',
    'daily_work_conversion_links', 'sale_items', 'stock_movements', 'audit_log'
  ]
  loop
    execute pg_catalog.format(
      'create trigger %I before update or delete on public.%I '
      || 'for each row execute function private.reject_row_rewrite()',
      v_table || '_append_only', v_table
    );
  end loop;
end;
$guard_triggers$;

-- ---------------------------------------------------------------------------
-- Read models. Every exposed view invokes the caller's RLS policies.
-- ---------------------------------------------------------------------------

create view public.current_user_access
with (security_invoker = true)
as
select
  p.user_id,
  p.display_name,
  p.email,
  p.is_active,
  coalesce(
    pg_catalog.array_agg(distinct r.code order by r.code)
      filter (where r.code is not null),
    array[]::text[]
  ) as role_codes,
  coalesce(
    pg_catalog.array_agg(distinct pe.code order by pe.code)
      filter (where pe.code is not null),
    array[]::text[]
  ) as permission_codes
from public.profiles p
left join public.user_roles ur on ur.user_id = p.user_id
left join public.roles r on r.id = ur.role_id
left join public.role_permissions rp on rp.role_id = r.id
left join public.permissions pe on pe.id = rp.permission_id
group by p.user_id, p.display_name, p.email, p.is_active;

create view public.inventory_position
with (security_invoker = true)
as
select
  i.id as item_id,
  i.sku,
  i.name as item_name,
  i.stage,
  i.unit,
  coalesce(b.quantity_on_hand, 0::numeric)::numeric(20,6) as quantity_on_hand,
  coalesce(b.inventory_value, 0::numeric)::numeric(20,2) as inventory_value,
  case when coalesce(b.quantity_on_hand, 0) = 0 then 0::numeric
       else pg_catalog.round(b.inventory_value / b.quantity_on_hand, 6)
  end::numeric(20,6) as average_unit_cost,
  b.last_movement_at,
  i.is_active
from public.inventory_items i
left join public.inventory_balances b on b.item_id = i.id;

create view public.account_balances
with (security_invoker = true)
as
select
  a.id as account_id,
  a.code as account_code,
  a.name as account_name,
  a.category,
  a.normal_side,
  coalesce(pg_catalog.sum(jl.debit), 0::numeric)::numeric(20,2) as debit_total,
  coalesce(pg_catalog.sum(jl.credit), 0::numeric)::numeric(20,2) as credit_total,
  case when a.normal_side = 'debit'
       then coalesce(pg_catalog.sum(jl.debit - jl.credit), 0::numeric)
       else coalesce(pg_catalog.sum(jl.credit - jl.debit), 0::numeric)
  end::numeric(20,2) as balance
from public.accounts a
left join public.journal_lines jl on jl.account_id = a.id
group by a.id, a.code, a.name, a.category, a.normal_side;

create view public.employee_open_earnings
with (security_invoker = true)
as
select
  e.id as employee_id,
  e.employee_no,
  e.name as employee_name,
  dw.work_date,
  'daily_work'::text as source_type,
  dw.id as source_id,
  'Daily work'::text as description,
  dw.work_units::numeric(20,6) as quantity,
  dw.daily_rate::numeric(20,6) as rate,
  dw.base_amount::numeric(20,2) as amount
from public.daily_work dw
join public.employees e on e.id = dw.employee_id
where dw.status = 'posted' and dw.base_amount > 0
  and not exists (
    select 1 from public.payroll_details pd
    where pd.source_daily_work_id = dw.id and pd.is_active
  )
union all
select
  e.id, e.employee_no, e.name, c.conversion_date,
  'conversion_piecework', cw.id, cw.task,
  cw.quantity_kg, cw.rate_per_kg, cw.amount
from public.conversion_workers cw
join public.employees e on e.id = cw.employee_id
join public.conversions c on c.id = cw.conversion_id
where c.status = 'posted'
  and not exists (
    select 1 from public.payroll_details pd
    where pd.source_conversion_worker_id = cw.id and pd.is_active
  )
union all
select
  e.id, e.employee_no, e.name, dw.work_date,
  'manual_piecework', dwp.id, dwp.task,
  dwp.quantity_kg, dwp.rate_per_kg, dwp.amount
from public.daily_work_piecework dwp
join public.daily_work dw on dw.id = dwp.daily_work_id
join public.employees e on e.id = dw.employee_id
where dw.status = 'posted'
  and not exists (
    select 1 from public.payroll_details pd
    where pd.source_manual_piecework_id = dwp.id and pd.is_active
  );

create view public.sales_outstanding
with (security_invoker = true)
as
select s.*
from public.sales s
where s.status = 'posted' and s.balance_due > 0;

create view public.payroll_outstanding
with (security_invoker = true)
as
select p.*
from public.payrolls p
where p.status = 'posted' and p.balance_due > 0;

-- ---------------------------------------------------------------------------
-- Atomic operation dispatcher (called only by public.erp_execute)
-- ---------------------------------------------------------------------------

create or replace function private.perform_operation(
  p_operation text,
  p_payload jsonb,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_payload jsonb := p_payload;
  v_json jsonb;
  v_lines jsonb;
  v_calculated jsonb := '[]'::jsonb;
  v_id uuid;
  v_target_id uuid;
  v_item_id uuid;
  v_item_id_2 uuid;
  v_journal_id uuid;
  v_reversal_journal_id uuid;
  v_worker_id uuid;
  v_reference text;
  v_invoice text;
  v_reason text;
  v_method text;
  v_status text;
  v_date date;
  v_count integer;
  v_line_no integer;
  v_quantity numeric(20,6);
  v_quantity_2 numeric(20,6);
  v_rate numeric(20,6);
  v_amount numeric(20,2);
  v_amount_2 numeric(20,2);
  v_amount_3 numeric(20,2);
  v_total numeric(20,2);
  v_cogs numeric(20,2);
  v_available_quantity numeric(20,6);
  v_available_value numeric(20,2);
  v_item_ids uuid[] := array[]::uuid[];
  v_purchase public.raw_material_purchases%rowtype;
  v_conversion public.conversions%rowtype;
  v_daily public.daily_work%rowtype;
  v_production public.production_runs%rowtype;
  v_sale public.sales%rowtype;
  v_sale_payment public.sale_payments%rowtype;
  v_payroll public.payrolls%rowtype;
  v_payroll_payment public.payroll_payments%rowtype;
  v_adjustment public.stock_adjustments%rowtype;
  v_journal public.journal_entries%rowtype;
begin
  if p_actor is null or p_actor <> (select auth.uid()) then
    raise exception using errcode = '42501', message = 'A valid authenticated actor is required';
  end if;
  if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
    raise exception using errcode = '42501', message = 'ERP operation guard is not active';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Operation payload must be a JSON object';
  end if;

  -- Employee masters ---------------------------------------------------------
  if p_operation = 'employee.upsert' then
    perform private.assert_permission('employees.write');
    if nullif(pg_catalog.btrim(v_payload ->> 'name'), '') is null then
      raise exception using errcode = '22023', message = 'Employee name is required';
    end if;

    v_id := case when nullif(v_payload ->> 'id', '') is null
                 then pg_catalog.gen_random_uuid() else (v_payload ->> 'id')::uuid end;
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'employee_no'), ''),
      'EMP-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(v_id::text, '-', ''), 1, 10))
    );

    insert into public.employees (
      id, employee_no, name, nic, phone, address, epf_no, etf_ref,
      joined_date, left_date, job_role, employment_type, shift, pay_model,
      monthly_rate, daily_rate, ot_rate, daily_on_conversion, bank_details,
      status, created_by, updated_by
    ) values (
      v_id, pg_catalog.left(v_reference, 40), pg_catalog.left(pg_catalog.btrim(v_payload ->> 'name'), 160),
      nullif(pg_catalog.btrim(v_payload ->> 'nic'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'phone'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'address'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'epf_no'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'etf_ref'), ''),
      (v_payload ->> 'joined_date')::date,
      nullif(v_payload ->> 'left_date', '')::date,
      nullif(pg_catalog.btrim(v_payload ->> 'job_role'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'employment_type'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'shift'), ''),
      coalesce(nullif(v_payload ->> 'pay_model', ''), 'monthly'),
      coalesce(nullif(v_payload ->> 'monthly_rate', '')::numeric, 0),
      coalesce(nullif(v_payload ->> 'daily_rate', '')::numeric, 0),
      coalesce(nullif(v_payload ->> 'ot_rate', '')::numeric, 0),
      coalesce((v_payload ->> 'daily_on_conversion')::boolean, false),
      v_payload -> 'bank_details',
      coalesce(nullif(v_payload ->> 'status', ''), 'active'),
      p_actor, p_actor
    )
    on conflict (id) do update
    set employee_no = excluded.employee_no,
        name = excluded.name,
        nic = excluded.nic,
        phone = excluded.phone,
        address = excluded.address,
        epf_no = excluded.epf_no,
        etf_ref = excluded.etf_ref,
        joined_date = excluded.joined_date,
        left_date = excluded.left_date,
        job_role = excluded.job_role,
        employment_type = excluded.employment_type,
        shift = excluded.shift,
        pay_model = excluded.pay_model,
        monthly_rate = excluded.monthly_rate,
        daily_rate = excluded.daily_rate,
        ot_rate = excluded.ot_rate,
        daily_on_conversion = excluded.daily_on_conversion,
        bank_details = excluded.bank_details,
        status = excluded.status,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor;

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'employee.delete' then
    perform private.assert_permission('employees.write');
    v_id := (v_payload ->> 'id')::uuid;
    update public.employees
    set status = 'inactive', left_date = coalesce(left_date, current_date),
        updated_at = pg_catalog.clock_timestamp(), updated_by = p_actor
    where id = v_id
    returning employee_no into v_reference;
    if not found then
      raise exception using errcode = 'P0001', message = 'Employee not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'piecework_rate.upsert' then
    perform private.assert_permission('employees.write');
    v_id := case when nullif(v_payload ->> 'id', '') is null
                 then pg_catalog.gen_random_uuid() else (v_payload ->> 'id')::uuid end;
    insert into public.piecework_rates (
      id, work_type, rate_per_kg, effective_from, effective_to, status,
      notes, created_by, updated_by
    ) values (
      v_id, pg_catalog.left(pg_catalog.btrim(v_payload ->> 'work_type'), 160),
      pg_catalog.round((v_payload ->> 'rate_per_kg')::numeric, 6),
      (v_payload ->> 'effective_from')::date,
      nullif(v_payload ->> 'effective_to', '')::date,
      coalesce(nullif(v_payload ->> 'status', ''), 'active'),
      nullif(pg_catalog.btrim(v_payload ->> 'notes'), ''), p_actor, p_actor
    )
    on conflict (id) do update
    set work_type = excluded.work_type,
        rate_per_kg = excluded.rate_per_kg,
        effective_from = excluded.effective_from,
        effective_to = excluded.effective_to,
        status = excluded.status,
        notes = excluded.notes,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_payload ->> 'work_type', 'idempotent', false
    );

  elsif p_operation = 'piecework_rate.delete' then
    perform private.assert_permission('employees.write');
    v_id := (v_payload ->> 'id')::uuid;
    update public.piecework_rates
    set status = 'inactive', effective_to = coalesce(effective_to, current_date),
        updated_at = pg_catalog.clock_timestamp(), updated_by = p_actor
    where id = v_id
    returning work_type into v_reference;
    if not found then
      raise exception using errcode = 'P0001', message = 'Piecework rate not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  -- Daily work ---------------------------------------------------------------
  elsif p_operation = 'daily_work.upsert' then
    perform private.assert_permission('employees.write');

    if nullif(v_payload ->> 'id', '') is not null then
      v_target_id := (v_payload ->> 'id')::uuid;
      select * into v_daily from public.daily_work where id = v_target_id for update;
      if not found then
        raise exception using errcode = 'P0001', message = 'Daily work record not found';
      end if;
      perform private.perform_operation(
        'daily_work.reverse',
        pg_catalog.jsonb_build_object('id', v_target_id, 'reason', 'Replaced by corrected daily work'),
        p_actor
      );
      v_payload := (v_payload - 'id') || pg_catalog.jsonb_build_object('_replaces_id', v_target_id);
    end if;

    v_id := pg_catalog.gen_random_uuid();
    v_reference := private.new_reference('DW');
    v_date := (v_payload ->> 'work_date')::date;
    v_quantity := pg_catalog.round((v_payload ->> 'work_units')::numeric, 4);
    v_rate := pg_catalog.round((v_payload ->> 'daily_rate')::numeric, 2);
    if v_quantity <= 0 or v_rate <= 0 then
      raise exception using errcode = '22023', message = 'Daily work units and rate must be positive';
    end if;
    v_target_id := (v_payload ->> 'employee_id')::uuid;
    perform 1 from public.employees e where e.id = v_target_id and e.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active employee not found';
    end if;

    v_amount := pg_catalog.round(v_quantity * v_rate, 2);
    v_amount_2 := 0;
    v_json := coalesce(v_payload -> 'manual_piecework', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_json) <> 'array' or pg_catalog.jsonb_array_length(v_json) > 100 then
      raise exception using errcode = '22023', message = 'manual_piecework must contain at most 100 rows';
    end if;
    select coalesce(pg_catalog.sum(
      pg_catalog.round((x.value ->> 'quantity_kg')::numeric * (x.value ->> 'rate_per_kg')::numeric, 2)
    ), 0) into v_amount_2
    from pg_catalog.jsonb_array_elements(v_json) x(value);
    v_total := v_amount + v_amount_2;

    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code','WAGES_EXPENSE','description','Daily work accrual','debit',v_total,'credit',0),
      pg_catalog.jsonb_build_object('account_code','WAGES_PAYABLE','description','Daily work payable','debit',0,'credit',v_total)
    );
    v_journal_id := private.post_journal(
      v_date, 'Daily work ' || v_reference, 'daily_work', v_id,
      v_lines, p_actor, null, null
    );

    insert into public.daily_work (
      id, reference_no, employee_id, work_date, manual_work_units,
      automatic_work_units, daily_rate, auto_created, notes,
      current_journal_entry_id, replaces_id, created_by, updated_by
    ) values (
      v_id, v_reference, v_target_id, v_date, v_quantity, 0, v_rate, false,
      nullif(pg_catalog.btrim(v_payload ->> 'notes'), ''), v_journal_id,
      nullif(v_payload ->> '_replaces_id', '')::uuid, p_actor, p_actor
    );

    insert into public.daily_work_piecework (
      id, daily_work_id, task, quantity_kg, rate_per_kg, amount, created_by
    )
    select
      coalesce(nullif(x.value ->> 'id', '')::uuid, pg_catalog.gen_random_uuid()),
      v_id,
      pg_catalog.left(pg_catalog.btrim(x.value ->> 'task'), 160),
      pg_catalog.round((x.value ->> 'quantity_kg')::numeric, 6),
      pg_catalog.round((x.value ->> 'rate_per_kg')::numeric, 6),
      pg_catalog.round((x.value ->> 'quantity_kg')::numeric * (x.value ->> 'rate_per_kg')::numeric, 2),
      p_actor
    from pg_catalog.jsonb_array_elements(v_json) x(value);

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'daily_work.reverse' then
    perform private.assert_permission('employees.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_daily from public.daily_work where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Daily work record not found';
    end if;
    if v_daily.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Daily work is already reversed';
    end if;
    if exists (
      select 1 from public.payroll_details pd
      where pd.is_active and (
        pd.source_daily_work_id = v_id or pd.source_manual_piecework_id in (
          select dwp.id from public.daily_work_piecework dwp where dwp.daily_work_id = v_id
        )
      )
    ) then
      raise exception using errcode = 'P0001', message = 'Claimed daily work cannot be reversed';
    end if;
    v_reason := coalesce(nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Daily work reversed');
    v_reversal_journal_id := private.reverse_journal(
      v_daily.current_journal_entry_id, current_date, p_actor, v_reason
    );
    update public.daily_work
    set status = 'reversed', reversal_journal_entry_id = v_reversal_journal_id,
        reversed_at = pg_catalog.clock_timestamp(), reversed_by = p_actor,
        reversal_reason = v_reason, updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_daily.reference_no, 'idempotent', false, 'reversed', true
    );

  -- Raw material purchase ----------------------------------------------------
  elsif p_operation = 'rm_purchase.replace' then
    perform private.assert_permission('inventory.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_purchase from public.raw_material_purchases where id = v_target_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'Purchase not found'; end if;
    perform private.perform_operation(
      'rm_purchase.reverse',
      pg_catalog.jsonb_build_object('id', v_target_id, 'reason', 'Replaced by corrected purchase'),
      p_actor
    );
    v_payload := coalesce(v_payload -> 'replacement', '{}'::jsonb)
      || pg_catalog.jsonb_build_object('_replaces_id', v_target_id);
    if nullif(v_payload ->> 'reference_no', '') is null
       or v_payload ->> 'reference_no' = v_purchase.reference_no then
      v_payload := pg_catalog.jsonb_set(v_payload, '{reference_no}', pg_catalog.to_jsonb(private.new_reference('RMP')));
    end if;
    return private.perform_operation('rm_purchase.post', v_payload, p_actor)
      || pg_catalog.jsonb_build_object('operation', p_operation);

  elsif p_operation = 'rm_purchase.post' then
    perform private.assert_permission('inventory.write');
    v_id := pg_catalog.gen_random_uuid();
    v_reference := coalesce(nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''), private.new_reference('RMP'));
    v_date := (v_payload ->> 'purchase_date')::date;
    v_quantity := pg_catalog.round((v_payload ->> 'quantity_kg')::numeric, 6);
    v_amount := pg_catalog.round((v_payload ->> 'total_cost')::numeric, 2);
    v_method := pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'payment_method'));
    if v_quantity <= 0 or v_amount <= 0 then
      raise exception using errcode = '22023', message = 'Purchase quantity and total cost must be positive';
    end if;
    v_item_id := private.resolve_inventory_item(
      v_payload ->> 'item_id', v_payload ->> 'material_name', 'bulk', p_actor
    );
    perform private.lock_inventory(array[v_item_id]);
    v_status := case when v_method = 'credit' then 'ACCOUNTS_PAYABLE'
                     else private.settlement_account_code(v_method) end;
    if v_status is null then
      raise exception using errcode = '22023', message = 'Unsupported purchase payment method';
    end if;
    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code','RAW_MATERIAL_INVENTORY','description','Raw material purchase','debit',v_amount,'credit',0),
      pg_catalog.jsonb_build_object('account_code',v_status,'description','Purchase settlement','debit',0,'credit',v_amount)
    );
    v_journal_id := private.post_journal(v_date, 'Purchase ' || v_reference, 'rm_purchase', v_id, v_lines, p_actor);
    insert into public.raw_material_purchases (
      id, reference_no, purchase_date, item_id, supplier_name, supplier_phone,
      quantity_kg, total_cost, payment_method, notes, journal_entry_id,
      replaces_id, created_by, updated_by
    ) values (
      v_id, pg_catalog.left(v_reference,80), v_date, v_item_id,
      nullif(pg_catalog.btrim(v_payload ->> 'supplier_name'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'supplier_phone'), ''),
      v_quantity, v_amount, v_method,
      nullif(pg_catalog.btrim(v_payload ->> 'notes'), ''), v_journal_id,
      nullif(v_payload ->> '_replaces_id','')::uuid, p_actor, p_actor
    );
    perform private.apply_stock(v_item_id, v_quantity, v_amount, v_date,
      'rm_purchase', v_id, v_journal_id, 'Raw material purchase', p_actor);
    return pg_catalog.jsonb_build_object('ok',true,'operation',p_operation,'id',v_id,
      'reference_no',v_reference,'idempotent',false);

  elsif p_operation = 'rm_purchase.reverse' then
    perform private.assert_permission('inventory.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_purchase from public.raw_material_purchases where id = v_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'Purchase not found'; end if;
    if v_purchase.status <> 'posted' then raise exception using errcode = 'P0001', message = 'Purchase is already reversed'; end if;
    perform private.lock_inventory(array[v_purchase.item_id]);
    v_reason := coalesce(nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Purchase reversed');
    v_reversal_journal_id := private.reverse_journal(v_purchase.journal_entry_id, current_date, p_actor, v_reason);
    perform private.apply_stock(v_purchase.item_id, -v_purchase.quantity_kg, -v_purchase.total_cost,
      current_date, 'rm_purchase.reversal', v_id, v_reversal_journal_id, v_reason, p_actor);
    update public.raw_material_purchases
    set status='reversed', reversal_journal_entry_id=v_reversal_journal_id,
        reversed_at=pg_catalog.clock_timestamp(), reversed_by=p_actor,
        reversal_reason=v_reason, updated_at=pg_catalog.clock_timestamp(), updated_by=p_actor
    where id=v_id;
    return pg_catalog.jsonb_build_object('ok',true,'operation',p_operation,'id',v_id,
      'reference_no',v_purchase.reference_no,'idempotent',false,'reversed',true);

  -- Bulk-to-chip conversion --------------------------------------------------
  elsif p_operation = 'conversion.replace' then
    perform private.assert_permission('inventory.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_conversion from public.conversions where id=v_target_id for update;
    if not found then raise exception using errcode='P0001', message='Conversion not found'; end if;
    perform private.perform_operation('conversion.reverse',
      pg_catalog.jsonb_build_object('id',v_target_id,'reason','Replaced by corrected conversion'),p_actor);
    v_payload := coalesce(v_payload->'replacement','{}'::jsonb)
      || pg_catalog.jsonb_build_object('_replaces_id',v_target_id);
    if nullif(v_payload->>'reference_no','') is null or v_payload->>'reference_no'=v_conversion.reference_no then
      v_payload := pg_catalog.jsonb_set(v_payload,'{reference_no}',pg_catalog.to_jsonb(private.new_reference('CNV')));
    end if;
    return private.perform_operation('conversion.post',v_payload,p_actor)
      || pg_catalog.jsonb_build_object('operation',p_operation);

  elsif p_operation = 'conversion.post' then
    perform private.assert_permission('inventory.write');
    v_id := pg_catalog.gen_random_uuid();
    v_reference := coalesce(nullif(pg_catalog.btrim(v_payload->>'reference_no'),''),private.new_reference('CNV'));
    v_date := (v_payload->>'conversion_date')::date;
    v_quantity := pg_catalog.round((v_payload->>'input_kg')::numeric,6);
    v_quantity_2 := pg_catalog.round((v_payload->>'output_kg')::numeric,6);
    v_amount_3 := pg_catalog.round(coalesce(nullif(v_payload->>'overhead_cost','')::numeric,0),2);
    if v_quantity<=0 or v_quantity_2<=0 or v_quantity_2>v_quantity*1.02 or v_amount_3<0 then
      raise exception using errcode='22023', message='Invalid conversion quantities or overhead';
    end if;
    v_item_id := private.resolve_inventory_item(v_payload->>'source_item_id',v_payload->>'source_material_name','bulk',p_actor);
    v_item_id_2 := private.resolve_inventory_item(v_payload->>'output_item_id',v_payload->>'chip_name','chip',p_actor);
    if v_item_id=v_item_id_2 then raise exception using errcode='22023', message='Conversion input and output must differ'; end if;
    v_json := coalesce(v_payload->'workers','[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_json)<>'array' or pg_catalog.jsonb_array_length(v_json) not between 1 and 100 then
      raise exception using errcode='22023', message='Conversion requires 1 to 100 workers';
    end if;
    v_amount_2 := 0;
    for v_json in select x.value from pg_catalog.jsonb_array_elements(v_json) x(value)
    loop
      perform 1 from public.employees e where e.id=(v_json->>'employee_id')::uuid and e.status='active';
      if not found then raise exception using errcode='P0001', message='Conversion worker is not active'; end if;
      if nullif(v_json->>'rate_id','') is not null then
        perform 1 from public.piecework_rates pr where pr.id=(v_json->>'rate_id')::uuid and pr.status='active'
          and v_date between pr.effective_from and coalesce(pr.effective_to,v_date);
        if not found then raise exception using errcode='P0001', message='Piecework rate is not active on conversion date'; end if;
      end if;
      v_amount_2 := v_amount_2 + pg_catalog.round((v_json->>'quantity_kg')::numeric*(v_json->>'rate_per_kg')::numeric,2);
    end loop;
    -- Restore the original array after validation loop reused v_json.
    v_json := coalesce(v_payload->'workers','[]'::jsonb);
    if v_amount_2<=0 then raise exception using errcode='22023', message='Conversion labor must be positive'; end if;
    perform private.lock_inventory(array[v_item_id,v_item_id_2]);
    select b.quantity_on_hand,b.inventory_value into v_available_quantity,v_available_value
    from public.inventory_balances b where b.item_id=v_item_id;
    if v_available_quantity<v_quantity then raise exception using errcode='P0001', message='Insufficient bulk inventory'; end if;
    v_amount := case when v_available_quantity=v_quantity then v_available_value
                     else pg_catalog.round(v_available_value/v_available_quantity*v_quantity,2) end;
    if v_amount<=0 then raise exception using errcode='P0001', message='Bulk inventory has no usable cost'; end if;
    v_total := v_amount+v_amount_2+v_amount_3;
    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code','CHIP_INVENTORY','description','Converted chip received','debit',v_total,'credit',0),
      pg_catalog.jsonb_build_object('account_code','RAW_MATERIAL_INVENTORY','description','Bulk material consumed','debit',0,'credit',v_amount),
      pg_catalog.jsonb_build_object('account_code','WAGES_PAYABLE','description','Conversion piecework payable','debit',0,'credit',v_amount_2)
    );
    if v_amount_3>0 then
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('account_code','OVERHEAD_PAYABLE','description','Conversion overhead','debit',0,'credit',v_amount_3)
      );
    end if;
    v_journal_id := private.post_journal(v_date,'Conversion '||v_reference,'conversion',v_id,v_lines,p_actor);
    insert into public.conversions(id,reference_no,conversion_date,source_item_id,output_item_id,
      chip_type,input_kg,output_kg,material_cost,labor_cost,overhead_cost,total_converted_cost,
      journal_entry_id,replaces_id,created_by,updated_by)
    values(v_id,pg_catalog.left(v_reference,80),v_date,v_item_id,v_item_id_2,
      nullif(pg_catalog.btrim(v_payload->>'chip_type'),''),v_quantity,v_quantity_2,v_amount,v_amount_2,
      v_amount_3,v_total,v_journal_id,nullif(v_payload->>'_replaces_id','')::uuid,p_actor,p_actor);
    insert into public.conversion_workers(id,conversion_id,employee_id,rate_id,work_date,task,
      quantity_kg,rate_per_kg,amount,created_by)
    select pg_catalog.gen_random_uuid(),v_id,(x.value->>'employee_id')::uuid,
      nullif(x.value->>'rate_id','')::uuid,v_date,pg_catalog.left(pg_catalog.btrim(x.value->>'task'),160),
      pg_catalog.round((x.value->>'quantity_kg')::numeric,6),pg_catalog.round((x.value->>'rate_per_kg')::numeric,6),
      pg_catalog.round((x.value->>'quantity_kg')::numeric*(x.value->>'rate_per_kg')::numeric,2),p_actor
    from pg_catalog.jsonb_array_elements(v_json) x(value);
    perform private.apply_stock(v_item_id,-v_quantity,-v_amount,v_date,'conversion',v_id,v_journal_id,'Bulk material consumed',p_actor);
    perform private.apply_stock(v_item_id_2,v_quantity_2,v_total,v_date,'conversion',v_id,v_journal_id,'Converted chip received',p_actor);
    return pg_catalog.jsonb_build_object('ok',true,'operation',p_operation,'id',v_id,'reference_no',v_reference,'idempotent',false);

  elsif p_operation = 'conversion.reverse' then
    perform private.assert_permission('inventory.write');
    v_id := (v_payload->>'id')::uuid;
    select * into v_conversion from public.conversions where id=v_id for update;
    if not found then raise exception using errcode='P0001', message='Conversion not found'; end if;
    if v_conversion.status<>'posted' then raise exception using errcode='P0001', message='Conversion is already reversed'; end if;
    if exists(select 1 from public.payroll_details pd join public.conversion_workers cw
      on cw.id=pd.source_conversion_worker_id where cw.conversion_id=v_id and pd.is_active) then
      raise exception using errcode='P0001', message='Conversion with claimed piecework cannot be reversed';
    end if;
    perform private.lock_inventory(array[v_conversion.source_item_id,v_conversion.output_item_id]);
    v_reason := coalesce(nullif(pg_catalog.btrim(v_payload->>'reason'),''),'Conversion reversed');
    v_reversal_journal_id := private.reverse_journal(v_conversion.journal_entry_id,current_date,p_actor,v_reason);
    perform private.apply_stock(v_conversion.output_item_id,-v_conversion.output_kg,-v_conversion.total_converted_cost,
      current_date,'conversion.reversal',v_id,v_reversal_journal_id,v_reason,p_actor);
    perform private.apply_stock(v_conversion.source_item_id,v_conversion.input_kg,v_conversion.material_cost,
      current_date,'conversion.reversal',v_id,v_reversal_journal_id,v_reason,p_actor);
    update public.conversions set status='reversed',reversal_journal_entry_id=v_reversal_journal_id,
      reversed_at=pg_catalog.clock_timestamp(),reversed_by=p_actor,reversal_reason=v_reason,
      updated_at=pg_catalog.clock_timestamp(),updated_by=p_actor where id=v_id;
    return pg_catalog.jsonb_build_object('ok',true,'operation',p_operation,'id',v_id,'reference_no',v_conversion.reference_no,
      'idempotent',false,'reversed',true);

  -- Production ---------------------------------------------------------------
  elsif p_operation = 'production.replace' then
    perform private.assert_permission('production.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_production from public.production_runs where id=v_target_id for update;
    if not found then raise exception using errcode='P0001', message='Production run not found'; end if;
    perform private.perform_operation('production.reverse',
      pg_catalog.jsonb_build_object('id',v_target_id,'reason','Replaced by corrected production run'),p_actor);
    v_payload := coalesce(v_payload->'replacement','{}'::jsonb)||pg_catalog.jsonb_build_object('_replaces_id',v_target_id);
    if nullif(v_payload->>'reference_no','') is null or v_payload->>'reference_no'=v_production.reference_no then
      v_payload:=pg_catalog.jsonb_set(v_payload,'{reference_no}',pg_catalog.to_jsonb(private.new_reference('PRD')));
    end if;
    return private.perform_operation('production.post',v_payload,p_actor)||pg_catalog.jsonb_build_object('operation',p_operation);

  elsif p_operation = 'production.post' then
    perform private.assert_permission('production.write');
    v_id:=pg_catalog.gen_random_uuid();
    v_reference:=coalesce(nullif(pg_catalog.btrim(v_payload->>'reference_no'),''),private.new_reference('PRD'));
    v_date:=(v_payload->>'production_date')::date;
    v_quantity:=pg_catalog.round((v_payload->>'input_kg')::numeric,6);
    v_quantity_2:=pg_catalog.round((v_payload->>'output_quantity')::numeric,6);
    v_amount_2:=pg_catalog.round(coalesce(nullif(v_payload->>'overhead_cost','')::numeric,0),2);
    if v_quantity<=0 or v_quantity_2<=0 or v_amount_2<0 then raise exception using errcode='22023', message='Invalid production quantities or overhead'; end if;
    v_item_id:=private.resolve_inventory_item(v_payload->>'chip_item_id',v_payload->>'chip_name','chip',p_actor);
    v_item_id_2:=private.resolve_inventory_item(v_payload->>'finished_item_id',v_payload->>'finished_item_name','finished',p_actor);
    if v_item_id=v_item_id_2 then raise exception using errcode='22023', message='Production input and output must differ'; end if;
    v_target_id:=(v_payload->>'operator_employee_id')::uuid;
    perform 1 from public.employees e where e.id=v_target_id and e.status='active';
    if not found then raise exception using errcode='P0001', message='Active production operator not found'; end if;
    perform private.lock_inventory(array[v_item_id,v_item_id_2]);
    select b.quantity_on_hand,b.inventory_value into v_available_quantity,v_available_value
    from public.inventory_balances b where b.item_id=v_item_id;
    if v_available_quantity<v_quantity then raise exception using errcode='P0001', message='Insufficient chip inventory'; end if;
    v_amount:=case when v_available_quantity=v_quantity then v_available_value
                   else pg_catalog.round(v_available_value/v_available_quantity*v_quantity,2) end;
    if v_amount<=0 then raise exception using errcode='P0001', message='Chip inventory has no usable cost'; end if;
    v_total:=v_amount+v_amount_2;
    v_lines:=pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code','FINISHED_GOODS_INVENTORY','description','Finished goods received','debit',v_total,'credit',0),
      pg_catalog.jsonb_build_object('account_code','CHIP_INVENTORY','description','Chip material consumed','debit',0,'credit',v_amount)
    );
    if v_amount_2>0 then v_lines:=v_lines||pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code','OVERHEAD_PAYABLE','description','Production overhead','debit',0,'credit',v_amount_2)); end if;
    v_journal_id:=private.post_journal(v_date,'Production '||v_reference,'production',v_id,v_lines,p_actor);
    insert into public.production_runs(id,reference_no,production_date,shift,machine,operator_employee_id,
      chip_item_id,finished_item_id,input_kg,output_quantity,working_hours,material_cost,overhead_cost,total_cost,
      notes,journal_entry_id,replaces_id,created_by,updated_by)
    values(v_id,pg_catalog.left(v_reference,80),v_date,nullif(pg_catalog.btrim(v_payload->>'shift'),''),
      nullif(pg_catalog.btrim(v_payload->>'machine'),''),v_target_id,v_item_id,v_item_id_2,v_quantity,v_quantity_2,
      pg_catalog.round(coalesce(nullif(v_payload->>'working_hours','')::numeric,0),4),v_amount,v_amount_2,v_total,
      nullif(pg_catalog.btrim(v_payload->>'notes'),''),v_journal_id,nullif(v_payload->>'_replaces_id','')::uuid,p_actor,p_actor);
    perform private.apply_stock(v_item_id,-v_quantity,-v_amount,v_date,'production',v_id,v_journal_id,'Chip material consumed',p_actor);
    perform private.apply_stock(v_item_id_2,v_quantity_2,v_total,v_date,'production',v_id,v_journal_id,'Finished goods received',p_actor);
    return pg_catalog.jsonb_build_object('ok',true,'operation',p_operation,'id',v_id,'reference_no',v_reference,'idempotent',false);

  elsif p_operation = 'production.reverse' then
    perform private.assert_permission('production.write');
    v_id:=(v_payload->>'id')::uuid;
    select * into v_production from public.production_runs where id=v_id for update;
    if not found then raise exception using errcode='P0001', message='Production run not found'; end if;
    if v_production.status<>'posted' then raise exception using errcode='P0001', message='Production run is already reversed'; end if;
    perform private.lock_inventory(array[v_production.chip_item_id,v_production.finished_item_id]);
    v_reason:=coalesce(nullif(pg_catalog.btrim(v_payload->>'reason'),''),'Production run reversed');
    v_reversal_journal_id:=private.reverse_journal(v_production.journal_entry_id,current_date,p_actor,v_reason);
    perform private.apply_stock(v_production.finished_item_id,-v_production.output_quantity,-v_production.total_cost,
      current_date,'production.reversal',v_id,v_reversal_journal_id,v_reason,p_actor);
    perform private.apply_stock(v_production.chip_item_id,v_production.input_kg,v_production.material_cost,
      current_date,'production.reversal',v_id,v_reversal_journal_id,v_reason,p_actor);
    update public.production_runs set status='reversed',reversal_journal_entry_id=v_reversal_journal_id,
      reversed_at=pg_catalog.clock_timestamp(),reversed_by=p_actor,reversal_reason=v_reason,
      updated_at=pg_catalog.clock_timestamp(),updated_by=p_actor where id=v_id;
    return pg_catalog.jsonb_build_object('ok',true,'operation',p_operation,'id',v_id,'reference_no',v_production.reference_no,
      'idempotent',false,'reversed',true);

  else
    raise exception using errcode = '22023', message = 'Unsupported ERP operation: ' || coalesce(p_operation, '<null>');
  end if;
end;
$function$;

commit;
