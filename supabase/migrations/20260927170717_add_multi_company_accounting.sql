-- CK SYS V3 - two legal companies, company-scoped RBAC, and isolated books.
--
-- Physical inventory remains one shared warehouse pool.  Every operational
-- document and every journal is attributed to exactly one legal company.
-- Company-owned quantity/value is tracked separately so a company can never
-- consume another company's asset without an explicit ownership transfer.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

-- -------------------------------------------------------------------------
-- Legal entities and company-scoped role assignments
-- -------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  code text not null unique,
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint companies_code_format check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  constraint companies_name_not_blank check (pg_catalog.btrim(name) <> '')
);

insert into public.companies (id, code, name) values
  ('00000000-0000-4000-8000-000000000001', 'CK', 'CK Plastics'),
  ('00000000-0000-4000-8000-000000000002', 'AR', 'AR Plastics')
on conflict (id) do update
set code = excluded.code,
    name = excluded.name,
    is_active = true,
    updated_at = pg_catalog.clock_timestamp();

alter table public.profiles
  add column is_super_admin boolean not null default false;

-- The pre-migration administrator becomes the group super administrator.
update public.profiles p
set is_super_admin = true,
    updated_at = pg_catalog.clock_timestamp()
where exists (
  select 1
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id
  where ur.user_id = p.user_id and r.code = 'admin'
);

create table public.company_memberships (
  company_id uuid not null references public.companies(id) on delete restrict,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  is_active boolean not null default true,
  is_primary boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  primary key (company_id, user_id)
);

create unique index company_memberships_one_primary_idx
  on public.company_memberships (user_id)
  where is_primary and is_active;
create index company_memberships_user_active_idx
  on public.company_memberships (user_id, is_active, company_id);

create table public.company_user_roles (
  company_id uuid not null,
  user_id uuid not null,
  role_id bigint not null references public.roles(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (company_id, user_id, role_id),
  constraint company_user_roles_membership_fkey
    foreign key (company_id, user_id)
    references public.company_memberships(company_id, user_id)
    on delete cascade
);

create index company_user_roles_user_idx
  on public.company_user_roles (user_id, company_id, role_id);
create index company_user_roles_role_idx
  on public.company_user_roles (role_id, company_id);

insert into public.permissions (code, description) values
  ('access.manage', 'Activate company users and assign company roles')
on conflict (code) do update
set description = excluded.description,
    updated_at = pg_catalog.clock_timestamp();

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'admin'
on conflict (role_id, permission_id) do nothing;

-- Existing non-admin access belongs to AR Plastics, the company represented by
-- the legacy application.  Existing administrators receive both companies.
insert into public.company_memberships (
  company_id, user_id, is_active, is_primary, created_by, updated_by
)
select
  '00000000-0000-4000-8000-000000000002'::uuid,
  p.user_id,
  p.is_active,
  true,
  p.user_id,
  p.user_id
from public.profiles p
where p.is_active
on conflict (company_id, user_id) do nothing;

insert into public.company_memberships (
  company_id, user_id, is_active, is_primary, created_by, updated_by
)
select
  '00000000-0000-4000-8000-000000000001'::uuid,
  p.user_id,
  true,
  false,
  p.user_id,
  p.user_id
from public.profiles p
where p.is_super_admin
on conflict (company_id, user_id) do nothing;

insert into public.company_user_roles (company_id, user_id, role_id, created_by)
select
  '00000000-0000-4000-8000-000000000002'::uuid,
  ur.user_id,
  ur.role_id,
  ur.created_by
from public.user_roles ur
join public.company_memberships cm
  on cm.company_id = '00000000-0000-4000-8000-000000000002'::uuid
 and cm.user_id = ur.user_id
on conflict (company_id, user_id, role_id) do nothing;

insert into public.company_user_roles (company_id, user_id, role_id, created_by)
select
  '00000000-0000-4000-8000-000000000001'::uuid,
  p.user_id,
  r.id,
  p.user_id
from public.profiles p
cross join public.roles r
where p.is_super_admin and r.code = 'admin'
on conflict (company_id, user_id, role_id) do nothing;

-- -------------------------------------------------------------------------
-- Company attribution for private operational and financial records
-- -------------------------------------------------------------------------

do $add_company_columns$
declare
  v_table text;
begin
  foreach v_table in array array[
    'employees', 'employee_compensation_history',
    'journal_entries', 'journal_lines',
    'raw_material_purchases', 'conversions', 'conversion_workers',
    'daily_work', 'daily_work_piecework', 'daily_work_conversion_links',
    'overtime_entries', 'production_runs',
    'sales', 'sale_items', 'sale_payments',
    'payrolls', 'payroll_details', 'payroll_payments',
    'payroll_overtime_claims', 'stock_adjustments', 'stock_movements',
    'audit_log', 'idempotency_keys'
  ]
  loop
    execute pg_catalog.format(
      'alter table public.%I add column company_id uuid not null default %L::uuid',
      v_table, '00000000-0000-4000-8000-000000000002'
    );
    -- A constant ADD COLUMN default backfills existing tuples inside PostgreSQL
    -- without issuing row UPDATEs.  That preserves append-only tables such as
    -- journal_lines, stock_movements, audit_log, and compensation history.
    execute pg_catalog.format(
      'alter table public.%I alter column company_id drop default', v_table
    );
    execute pg_catalog.format(
      'alter table public.%I add constraint %I foreign key (company_id) '
      || 'references public.companies(id) on delete restrict',
      v_table, v_table || '_company_id_fkey'
    );
    execute pg_catalog.format(
      'create index %I on public.%I (company_id)',
      v_table || '_company_id_idx', v_table
    );
  end loop;
end;
$add_company_columns$;

-- Common company-first access paths used by PostgREST and RLS.
create index journal_entries_company_date_idx
  on public.journal_entries (company_id, journal_date desc, id desc);
create index journal_lines_company_account_idx
  on public.journal_lines (company_id, account_id, journal_entry_id);
create index employees_company_status_name_idx
  on public.employees (company_id, status, name, id);
create index raw_material_purchases_company_date_idx
  on public.raw_material_purchases (company_id, purchase_date desc, id desc);
create index conversions_company_date_idx
  on public.conversions (company_id, conversion_date desc, id desc);
create index production_runs_company_date_idx
  on public.production_runs (company_id, production_date desc, id desc);
create index sales_company_date_idx
  on public.sales (company_id, sale_date desc, id desc);
create index payrolls_company_date_idx
  on public.payrolls (company_id, payroll_date desc, id desc);
create index stock_movements_company_item_date_idx
  on public.stock_movements (company_id, item_id, movement_date desc, id desc);
create index audit_log_company_time_idx
  on public.audit_log (company_id, occurred_at desc, id desc);

-- Company-owned stock reconciles each legal ledger while the existing
-- inventory_balances table remains the physical, shared warehouse balance.
create table public.company_inventory_balances (
  company_id uuid not null references public.companies(id) on delete restrict,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity_on_hand numeric(20,6) not null default 0,
  inventory_value numeric(20,2) not null default 0,
  last_movement_date date,
  last_movement_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (company_id, item_id),
  constraint company_inventory_quantity_nonnegative check (
    quantity_on_hand >= 0 and quantity_on_hand::text not in ('NaN','Infinity','-Infinity')
  ),
  constraint company_inventory_value_nonnegative check (
    inventory_value >= 0 and inventory_value::text not in ('NaN','Infinity','-Infinity')
  ),
  constraint company_inventory_zero_consistency check (
    (quantity_on_hand = 0 and inventory_value = 0) or quantity_on_hand > 0
  )
);

create index company_inventory_item_idx
  on public.company_inventory_balances (item_id, company_id);

insert into public.company_inventory_balances (
  company_id, item_id, quantity_on_hand, inventory_value,
  last_movement_date, last_movement_at
)
select
  '00000000-0000-4000-8000-000000000002'::uuid,
  b.item_id,
  b.quantity_on_hand,
  b.inventory_value,
  b.last_movement_at::date,
  b.last_movement_at
from public.inventory_balances b
on conflict (company_id, item_id) do update
set quantity_on_hand = excluded.quantity_on_hand,
    inventory_value = excluded.inventory_value,
    last_movement_date = excluded.last_movement_date,
    last_movement_at = excluded.last_movement_at,
    updated_at = pg_catalog.clock_timestamp();

-- Fiscal periods are open unless a row explicitly closes the month.
create table public.fiscal_periods (
  company_id uuid not null references public.companies(id) on delete restrict,
  fiscal_year integer not null,
  fiscal_month smallint not null,
  status text not null default 'open',
  closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (company_id, fiscal_year, fiscal_month),
  constraint fiscal_periods_year_valid check (fiscal_year between 2000 and 2200),
  constraint fiscal_periods_month_valid check (fiscal_month between 1 and 12),
  constraint fiscal_periods_status_valid check (status in ('open', 'closed')),
  constraint fiscal_periods_close_state check (
    (status = 'open' and closed_at is null and closed_by is null)
    or (status = 'closed' and closed_at is not null and closed_by is not null)
  )
);

-- -------------------------------------------------------------------------
-- Company-aware authorization helpers
-- -------------------------------------------------------------------------

create or replace function private.current_company_id()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_value text;
begin
  v_value := nullif(pg_catalog.current_setting('app.current_company_id', true), '');
  if v_value is null then
    return null;
  end if;
  return v_value::uuid;
exception when invalid_text_representation then
  return null;
end;
$function$;

create or replace function private.can_access_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
     and exists (
       select 1
       from public.profiles p
       where p.user_id = (select auth.uid())
         and p.is_active
         and (
           p.is_super_admin
           or exists (
             select 1
             from public.company_memberships cm
             join public.companies c on c.id = cm.company_id
             where cm.user_id = p.user_id
               and cm.company_id = p_company_id
               and cm.is_active
               and c.is_active
           )
         )
     );
$function$;

create or replace function private.has_company_permission(
  p_company_id uuid,
  p_permission text
)
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
       where pr.user_id = (select auth.uid())
         and pr.is_active
         and (
           pr.is_super_admin
           or exists (
             select 1
             from public.company_memberships cm
             join public.company_user_roles cur
               on cur.company_id = cm.company_id and cur.user_id = cm.user_id
             join public.role_permissions rp on rp.role_id = cur.role_id
             join public.permissions pe on pe.id = rp.permission_id
             join public.companies c on c.id = cm.company_id
             where cm.user_id = pr.user_id
               and cm.company_id = p_company_id
               and cm.is_active
               and c.is_active
               and pe.code = p_permission
           )
         )
     );
$function$;

create or replace function private.has_company_any_permission(
  p_company_id uuid,
  p_permissions text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from pg_catalog.unnest(p_permissions) p(code)
    where private.has_company_permission(p_company_id, p.code)
  );
$function$;

create or replace function private.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when private.current_company_id() is not null
      then private.has_company_permission(private.current_company_id(), p_permission)
    else exists (
      select 1
      from public.company_memberships cm
      where cm.user_id = (select auth.uid())
        and cm.is_active
        and private.has_company_permission(cm.company_id, p_permission)
    ) or exists (
      select 1 from public.profiles p
      where p.user_id = (select auth.uid()) and p.is_active and p.is_super_admin
    )
  end;
$function$;

create or replace function private.has_any_permission(p_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from pg_catalog.unnest(p_permissions) p(code)
    where private.has_permission(p.code)
  );
$function$;

create or replace function private.is_active_erp_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
     and exists (
       select 1
       from public.profiles p
       where p.user_id = (select auth.uid())
         and p.is_active
         and (
           p.is_super_admin
           or exists (
             select 1 from public.company_memberships cm
             where cm.user_id = p.user_id and cm.is_active
           )
         )
     );
$function$;

create or replace function private.assert_open_period(
  p_company_id uuid,
  p_posting_date date
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if p_company_id is null or p_posting_date is null then
    raise exception using errcode = '22023', message = 'Company and posting date are required';
  end if;
  if exists (
    select 1
    from public.fiscal_periods fp
    where fp.company_id = p_company_id
      and fp.fiscal_year = extract(year from p_posting_date)::integer
      and fp.fiscal_month = extract(month from p_posting_date)::integer
      and fp.status = 'closed'
  ) then
    raise exception using errcode = 'P0001', message = 'The selected fiscal period is closed';
  end if;
end;
$function$;

-- Trigger every company-private row from the trusted transaction context.
create or replace function private.enforce_company_context()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_company_id uuid := private.current_company_id();
begin
  if v_company_id is null then
    raise exception using errcode = '42501', message = 'A verified company context is required';
  end if;
  if tg_op = 'INSERT' then
    if new.company_id is null then
      new.company_id := v_company_id;
    end if;
    if new.company_id <> v_company_id then
      raise exception using errcode = '42501', message = 'Cross-company insert is not permitted';
    end if;
    return new;
  end if;
  if old.company_id <> v_company_id or new.company_id <> old.company_id then
    raise exception using errcode = '42501', message = 'Cross-company update is not permitted';
  end if;
  return new;
end;
$function$;

do $company_context_triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'employees', 'employee_compensation_history',
    'journal_entries', 'journal_lines',
    'raw_material_purchases', 'conversions', 'conversion_workers',
    'daily_work', 'daily_work_piecework', 'daily_work_conversion_links',
    'overtime_entries', 'production_runs',
    'sales', 'sale_items', 'sale_payments',
    'payrolls', 'payroll_details', 'payroll_payments',
    'payroll_overtime_claims', 'stock_adjustments', 'stock_movements',
    'audit_log', 'idempotency_keys'
  ]
  loop
    execute pg_catalog.format(
      'create trigger %I before insert or update on public.%I '
      || 'for each row execute function private.enforce_company_context()',
      v_table || '_company_context', v_table
    );
  end loop;
end;
$company_context_triggers$;

-- Reject cross-company foreign-key links even though the legacy UUID foreign
-- keys remain in place.  The trigger is reusable and compares company_id on
-- both sides before the row can be written.
create or replace function private.assert_company_parent()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_parent_id text := pg_catalog.to_jsonb(new) ->> tg_argv[0];
  v_parent_company uuid;
begin
  if nullif(v_parent_id, '') is null then
    return new;
  end if;
  execute pg_catalog.format(
    'select company_id from public.%I where %I::text = $1',
    tg_argv[1], tg_argv[2]
  ) into v_parent_company using v_parent_id;
  if v_parent_company is null then
    raise exception using errcode = '23503', message = 'Referenced parent record was not found';
  end if;
  if v_parent_company <> new.company_id then
    raise exception using errcode = '23514', message = 'Cross-company record links are not permitted';
  end if;
  return new;
end;
$function$;

-- Child -> parent ownership checks.
create trigger employee_comp_history_company_parent
before insert or update on public.employee_compensation_history
for each row execute function private.assert_company_parent('employee_id','employees','id');
create trigger conversion_workers_conversion_company_parent
before insert or update on public.conversion_workers
for each row execute function private.assert_company_parent('conversion_id','conversions','id');
create trigger conversion_workers_employee_company_parent
before insert or update on public.conversion_workers
for each row execute function private.assert_company_parent('employee_id','employees','id');
create trigger daily_work_employee_company_parent
before insert or update on public.daily_work
for each row execute function private.assert_company_parent('employee_id','employees','id');
create trigger daily_work_piecework_company_parent
before insert or update on public.daily_work_piecework
for each row execute function private.assert_company_parent('daily_work_id','daily_work','id');
create trigger daily_work_links_work_company_parent
before insert or update on public.daily_work_conversion_links
for each row execute function private.assert_company_parent('daily_work_id','daily_work','id');
create trigger daily_work_links_conversion_company_parent
before insert or update on public.daily_work_conversion_links
for each row execute function private.assert_company_parent('conversion_worker_id','conversion_workers','id');
create trigger overtime_employee_company_parent
before insert or update on public.overtime_entries
for each row execute function private.assert_company_parent('employee_id','employees','id');
create trigger production_employee_company_parent
before insert or update on public.production_runs
for each row execute function private.assert_company_parent('operator_employee_id','employees','id');
create trigger sale_items_company_parent
before insert or update on public.sale_items
for each row execute function private.assert_company_parent('sale_id','sales','id');
create trigger sale_payments_company_parent
before insert or update on public.sale_payments
for each row execute function private.assert_company_parent('sale_id','sales','id');
create trigger payroll_employee_company_parent
before insert or update on public.payrolls
for each row execute function private.assert_company_parent('employee_id','employees','id');
create trigger payroll_details_company_parent
before insert or update on public.payroll_details
for each row execute function private.assert_company_parent('payroll_id','payrolls','id');
create trigger payroll_payments_company_parent
before insert or update on public.payroll_payments
for each row execute function private.assert_company_parent('payroll_id','payrolls','id');
create trigger payroll_claims_payroll_company_parent
before insert or update on public.payroll_overtime_claims
for each row execute function private.assert_company_parent('payroll_id','payrolls','id');
create trigger payroll_claims_overtime_company_parent
before insert or update on public.payroll_overtime_claims
for each row execute function private.assert_company_parent('overtime_id','overtime_entries','id');
create trigger journal_lines_company_parent
before insert or update on public.journal_lines
for each row execute function private.assert_company_parent('journal_entry_id','journal_entries','id');
create trigger stock_movements_company_parent
before insert or update on public.stock_movements
for each row execute function private.assert_company_parent('journal_entry_id','journal_entries','id');

-- -------------------------------------------------------------------------
-- Exact numeric and control-account protections
-- -------------------------------------------------------------------------

alter table public.accounts
  add column is_control boolean not null default false,
  add column allow_manual_posting boolean not null default true;

insert into public.accounts (code, name, category, normal_side, is_control, allow_manual_posting)
values
  ('INPUT_TAX_RECOVERABLE', 'Input Tax Recoverable', 'asset', 'debit', true, false),
  ('OUTPUT_TAX_PAYABLE', 'Output Tax Payable', 'liability', 'credit', true, false),
  ('INTERCOMPANY_DUE_FROM', 'Intercompany Due From', 'asset', 'debit', true, false),
  ('INTERCOMPANY_DUE_TO', 'Intercompany Due To', 'liability', 'credit', true, false),
  ('RETAINED_EARNINGS', 'Retained Earnings', 'equity', 'credit', true, false)
on conflict (code) do update
set name = excluded.name,
    category = excluded.category,
    normal_side = excluded.normal_side,
    is_control = excluded.is_control,
    allow_manual_posting = excluded.allow_manual_posting,
    updated_at = pg_catalog.clock_timestamp();

update public.accounts
set is_control = true,
    allow_manual_posting = false,
    updated_at = pg_catalog.clock_timestamp()
where code in (
  'ACCOUNTS_RECEIVABLE', 'RAW_MATERIAL_INVENTORY', 'CHIP_INVENTORY',
  'FINISHED_GOODS_INVENTORY', 'ACCOUNTS_PAYABLE', 'WAGES_PAYABLE',
  'PAYROLL_DEDUCTIONS_PAYABLE', 'EMPLOYER_CONTRIBUTION_PAYABLE',
  'OVERHEAD_PAYABLE'
);

create or replace function private.reject_non_finite_columns()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_column text;
  v_value text;
begin
  foreach v_column in array tg_argv
  loop
    v_value := pg_catalog.to_jsonb(new) ->> v_column;
    if v_value in ('NaN', 'Infinity', '-Infinity') then
      raise exception using
        errcode = '22003',
        message = 'Non-finite numeric value is not permitted for ' || v_column;
    end if;
  end loop;
  return new;
end;
$function$;

create trigger journal_lines_finite_numbers
before insert or update on public.journal_lines
for each row execute function private.reject_non_finite_columns('debit','credit');
create trigger inventory_balances_finite_numbers
before insert or update on public.inventory_balances
for each row execute function private.reject_non_finite_columns('quantity_on_hand','inventory_value');
create trigger company_inventory_balances_finite_numbers
before insert or update on public.company_inventory_balances
for each row execute function private.reject_non_finite_columns('quantity_on_hand','inventory_value');
create trigger stock_movements_finite_numbers
before insert or update on public.stock_movements
for each row execute function private.reject_non_finite_columns('quantity_delta','value_delta');
create trigger purchases_finite_numbers
before insert or update on public.raw_material_purchases
for each row execute function private.reject_non_finite_columns('quantity_kg','total_cost','unit_cost');
create trigger conversions_finite_numbers
before insert or update on public.conversions
for each row execute function private.reject_non_finite_columns(
  'input_kg','output_kg','waste_kg','material_cost','labor_cost','overhead_cost',
  'total_converted_cost','output_unit_cost'
);
create trigger production_finite_numbers
before insert or update on public.production_runs
for each row execute function private.reject_non_finite_columns(
  'input_kg','output_quantity','working_hours','material_cost','overhead_cost',
  'total_cost','output_unit_cost'
);
create trigger sales_finite_numbers
before insert or update on public.sales
for each row execute function private.reject_non_finite_columns(
  'total_amount','total_cogs','paid_amount','balance_due'
);
create trigger sale_items_finite_numbers
before insert or update on public.sale_items
for each row execute function private.reject_non_finite_columns(
  'quantity','unit_price','discount','line_total','unit_cost','line_cogs'
);
create trigger payrolls_finite_numbers
before insert or update on public.payrolls
for each row execute function private.reject_non_finite_columns(
  'regular_earnings','daily_wages','piecework_earnings','gross_pay',
  'deductions_total','employer_contributions','net_pay','paid_amount','balance_due'
);

-- -------------------------------------------------------------------------
-- Company-owned stock and company-scoped journal posting
-- -------------------------------------------------------------------------

create or replace function private.lock_company_inventory(
  p_company_id uuid,
  p_item_ids uuid[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  if p_company_id is null then
    raise exception using errcode = '22023', message = 'Company is required for inventory locking';
  end if;
  if p_item_ids is null or pg_catalog.cardinality(p_item_ids) = 0 then
    return;
  end if;

  insert into public.company_inventory_balances (company_id, item_id)
  select p_company_id, u.item_id
  from (
    select distinct item_id
    from pg_catalog.unnest(p_item_ids) item_id
    where item_id is not null
  ) u
  order by u.item_id
  on conflict (company_id, item_id) do nothing;

  perform b.item_id
  from public.company_inventory_balances b
  where b.company_id = p_company_id and b.item_id = any(p_item_ids)
  order by b.item_id
  for update;
end;
$function$;

create or replace function private.company_inventory_cost(
  p_company_id uuid,
  p_item_id uuid,
  p_quantity numeric
)
returns numeric
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_balance public.company_inventory_balances%rowtype;
begin
  if p_quantity is null or p_quantity <= 0
     or p_quantity::text in ('NaN','Infinity','-Infinity') then
    raise exception using errcode = '22023', message = 'Inventory issue quantity must be finite and positive';
  end if;
  perform private.lock_company_inventory(p_company_id, array[p_item_id]);
  select * into v_balance
  from public.company_inventory_balances b
  where b.company_id = p_company_id and b.item_id = p_item_id
  for update;
  if v_balance.quantity_on_hand < p_quantity then
    raise exception using
      errcode = 'P0001',
      message = 'This company does not own enough of the shared stock; transfer ownership before consuming it';
  end if;
  if v_balance.quantity_on_hand = p_quantity then
    return v_balance.inventory_value;
  end if;
  return pg_catalog.round(
    v_balance.inventory_value / v_balance.quantity_on_hand * p_quantity,
    2
  );
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
  v_company_id uuid;
  v_quantity numeric(20,6);
  v_value numeric(20,2);
  v_company_quantity numeric(20,6);
  v_company_value numeric(20,2);
  v_last_movement_date date;
begin
  if p_quantity_delta = 0
     or p_quantity_delta::text in ('NaN','Infinity','-Infinity')
     or p_value_delta::text in ('NaN','Infinity','-Infinity') then
    raise exception using errcode = '22023', message = 'Stock movement values must be finite and quantity cannot be zero';
  end if;
  if (p_quantity_delta > 0 and p_value_delta < 0)
     or (p_quantity_delta < 0 and p_value_delta > 0) then
    raise exception using errcode = '22023', message = 'Stock movement quantity and value signs conflict';
  end if;

  select j.company_id into v_company_id
  from public.journal_entries j
  where j.id = p_journal_entry_id;
  if v_company_id is null then
    raise exception using errcode = '23503', message = 'Stock movement journal was not found';
  end if;
  if v_company_id <> private.current_company_id() then
    raise exception using errcode = '42501', message = 'Stock movement company does not match the verified context';
  end if;
  perform private.assert_open_period(v_company_id, p_movement_date);
  perform private.lock_company_inventory(v_company_id, array[p_item_id]);

  select b.last_movement_date into v_last_movement_date
  from public.company_inventory_balances b
  where b.company_id = v_company_id and b.item_id = p_item_id
  for update;
  if v_last_movement_date is not null and p_movement_date < v_last_movement_date then
    raise exception using
      errcode = 'P0001',
      message = 'Backdated stock movement would invalidate moving-average costing';
  end if;

  select
    pg_catalog.round(b.quantity_on_hand + p_quantity_delta, 6),
    pg_catalog.round(b.inventory_value + p_value_delta, 2)
  into v_quantity, v_value
  from public.inventory_balances b
  where b.item_id = p_item_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'Physical inventory balance is not initialized';
  end if;

  select
    pg_catalog.round(b.quantity_on_hand + p_quantity_delta, 6),
    pg_catalog.round(b.inventory_value + p_value_delta, 2)
  into v_company_quantity, v_company_value
  from public.company_inventory_balances b
  where b.company_id = v_company_id and b.item_id = p_item_id
  for update;

  if v_quantity < 0 or v_value < 0 then
    raise exception using errcode = 'P0001', message = 'Insufficient shared physical inventory';
  end if;
  if v_company_quantity < 0 or v_company_value < 0 then
    raise exception using
      errcode = 'P0001',
      message = 'This company does not own enough stock; post an ownership transfer first';
  end if;
  if (v_quantity = 0 and v_value <> 0)
     or (v_company_quantity = 0 and v_company_value <> 0) then
    raise exception using errcode = 'P0001', message = 'A zero stock balance must have zero value';
  end if;

  update public.inventory_balances
  set quantity_on_hand = v_quantity,
      inventory_value = v_value,
      last_movement_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where item_id = p_item_id;

  update public.company_inventory_balances
  set quantity_on_hand = v_company_quantity,
      inventory_value = v_company_value,
      last_movement_date = p_movement_date,
      last_movement_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where company_id = v_company_id and item_id = p_item_id;

  insert into public.stock_movements (
    company_id, movement_date, item_id, quantity_delta, value_delta,
    source_type, source_id, journal_entry_id, reason, created_by
  ) values (
    v_company_id, p_movement_date, p_item_id,
    pg_catalog.round(p_quantity_delta, 6), pg_catalog.round(p_value_delta, 2),
    p_source_type, p_source_id, p_journal_entry_id,
    pg_catalog.left(pg_catalog.btrim(p_reason), 1000), p_actor
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
  v_company_id uuid := private.current_company_id();
  v_reference text := coalesce(
    nullif(pg_catalog.btrim(p_reference_no), ''), private.new_reference('JRN')
  );
  v_count integer;
  v_debit numeric(20,2);
  v_credit numeric(20,2);
begin
  if p_reversal_of_id is not null then
    select j.company_id into v_company_id
    from public.journal_entries j
    where j.id = p_reversal_of_id;
  end if;
  if v_company_id is null or v_company_id <> private.current_company_id() then
    raise exception using errcode = '42501', message = 'Journal company does not match the verified context';
  end if;
  perform private.assert_open_period(v_company_id, p_journal_date);
  if p_journal_date is null then
    raise exception using errcode = '22023', message = 'Journal date is required';
  end if;
  if nullif(pg_catalog.btrim(p_memo), '') is null then
    raise exception using errcode = '22023', message = 'Journal memo is required';
  end if;
  if pg_catalog.jsonb_typeof(p_lines) <> 'array' then
    raise exception using errcode = '22023', message = 'Journal lines must be an array';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_lines) e(line)
    cross join lateral (values (
      coalesce(nullif(e.line ->> 'debit', '')::numeric, 0),
      coalesce(nullif(e.line ->> 'credit', '')::numeric, 0)
    )) n(debit, credit)
    where n.debit::text in ('NaN','Infinity','-Infinity')
       or n.credit::text in ('NaN','Infinity','-Infinity')
       or not ((n.debit > 0 and n.credit = 0) or (n.credit > 0 and n.debit = 0))
  ) then
    raise exception using errcode = '23514', message = 'Each journal line requires one finite positive debit or credit';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.round(pg_catalog.sum(coalesce(nullif(e.line ->> 'debit', '')::numeric, 0)), 2),
    pg_catalog.round(pg_catalog.sum(coalesce(nullif(e.line ->> 'credit', '')::numeric, 0)), 2)
  into v_count, v_debit, v_credit
  from pg_catalog.jsonb_array_elements(p_lines) e(line);
  if v_count < 2 or v_count > 500 then
    raise exception using errcode = '22023', message = 'A journal requires between 2 and 500 lines';
  end if;
  if v_debit <= 0 or v_debit <> v_credit
     or v_debit::text in ('NaN','Infinity','-Infinity') then
    raise exception using errcode = '23514', message = 'Journal debits and credits must be finite, positive, and equal';
  end if;

  if p_source_type in ('manual', 'manual_journal') and exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_lines) e(line)
    join public.accounts a
      on a.id = private.resolve_account_id(e.line ->> 'account_code', e.line ->> 'account')
    where a.is_control or not a.allow_manual_posting
  ) then
    raise exception using
      errcode = '42501',
      message = 'Manual journals cannot post directly to inventory, receivable, payable, tax, payroll, or intercompany control accounts';
  end if;

  insert into public.journal_entries (
    id, company_id, reference_no, journal_date, memo, source_type, source_id,
    reversal_of_id, status, created_by
  ) values (
    v_id, v_company_id, pg_catalog.left(v_reference, 80), p_journal_date,
    pg_catalog.left(pg_catalog.btrim(p_memo), 500),
    pg_catalog.left(pg_catalog.btrim(p_source_type), 80), p_source_id,
    p_reversal_of_id, 'posted', p_actor
  );

  insert into public.journal_lines (
    company_id, journal_entry_id, line_no, account_id, description, debit, credit
  )
  select
    v_company_id,
    v_id,
    e.ordinality::smallint,
    private.resolve_account_id(e.line ->> 'account_code', e.line ->> 'account'),
    pg_catalog.left(
      coalesce(nullif(pg_catalog.btrim(e.line ->> 'description'), ''), pg_catalog.btrim(p_memo)),
      500
    ),
    pg_catalog.round(coalesce(nullif(e.line ->> 'debit', '')::numeric, 0), 2),
    pg_catalog.round(coalesce(nullif(e.line ->> 'credit', '')::numeric, 0), 2)
  from pg_catalog.jsonb_array_elements(p_lines) with ordinality e(line, ordinality);

  return v_id;
end;
$function$;

-- -------------------------------------------------------------------------
-- Company-aware read models
-- -------------------------------------------------------------------------

create or replace view public.current_user_access
with (security_invoker = true)
as
select
  p.user_id,
  p.display_name,
  p.email,
  p.is_active,
  coalesce((
    select pg_catalog.array_agg(distinct r.code order by r.code)
    from public.company_memberships cm
    join public.company_user_roles cur
      on cur.company_id = cm.company_id and cur.user_id = cm.user_id
    join public.roles r on r.id = cur.role_id
    where cm.user_id = p.user_id and cm.is_active
  ), array[]::text[]) as role_codes,
  coalesce((
    select pg_catalog.array_agg(distinct pe.code order by pe.code)
    from public.company_memberships cm
    join public.company_user_roles cur
      on cur.company_id = cm.company_id and cur.user_id = cm.user_id
    join public.role_permissions rp on rp.role_id = cur.role_id
    join public.permissions pe on pe.id = rp.permission_id
    where cm.user_id = p.user_id and cm.is_active
  ), array[]::text[]) as permission_codes,
  -- Keep the legacy view columns in their original positions. PostgreSQL only
  -- allows CREATE OR REPLACE VIEW to append new columns, not insert them in
  -- the middle of the existing result shape.
  p.is_super_admin,
  coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'company_id', c.id,
        'code', c.code,
        'name', c.name,
        'is_primary', cm.is_primary,
        'role_codes', coalesce((
          select pg_catalog.jsonb_agg(distinct r.code order by r.code)
          from public.company_user_roles cur
          join public.roles r on r.id = cur.role_id
          where cur.company_id = cm.company_id and cur.user_id = cm.user_id
        ), '[]'::jsonb),
        'permission_codes', coalesce((
          select pg_catalog.jsonb_agg(distinct pe.code order by pe.code)
          from public.company_user_roles cur
          join public.role_permissions rp on rp.role_id = cur.role_id
          join public.permissions pe on pe.id = rp.permission_id
          where cur.company_id = cm.company_id and cur.user_id = cm.user_id
        ), '[]'::jsonb)
      ) order by cm.is_primary desc, c.name
    )
    from public.company_memberships cm
    join public.companies c on c.id = cm.company_id and c.is_active
    where cm.user_id = p.user_id and cm.is_active
  ), '[]'::jsonb) as companies
from public.profiles p;

create or replace view public.admin_user_access
with (security_invoker = true)
as
select
  cm.company_id,
  p.user_id,
  p.display_name,
  p.email,
  p.is_active as profile_active,
  p.is_super_admin,
  cm.is_active as membership_active,
  cm.is_primary,
  coalesce(
    pg_catalog.array_agg(distinct r.code order by r.code)
      filter (where r.code is not null),
    array[]::text[]
  ) as role_codes
from public.profiles p
join public.company_memberships cm on cm.user_id = p.user_id
left join public.company_user_roles cur
  on cur.company_id = cm.company_id and cur.user_id = cm.user_id
left join public.roles r on r.id = cur.role_id
group by cm.company_id, p.user_id, p.display_name, p.email,
         p.is_active, p.is_super_admin, cm.is_active, cm.is_primary
union all
select
  c.id,
  p.user_id,
  p.display_name,
  p.email,
  p.is_active,
  p.is_super_admin,
  false,
  false,
  array[]::text[]
from public.profiles p
cross join public.companies c
where p.is_super_admin = false
  and not exists (
    select 1 from public.company_memberships cm where cm.user_id = p.user_id
  );

create or replace view public.ledger_view
with (security_invoker = true)
as
select
  jl.id,
  jl.journal_entry_id,
  jl.line_no,
  jl.account_id,
  a.code as account_code,
  a.name as account_name,
  a.category,
  a.normal_side,
  jl.description,
  jl.debit,
  jl.credit,
  jl.created_at,
  je.reference_no,
  je.journal_date as entry_date,
  je.source_type,
  je.source_type as source_module,
  je.source_id,
  je.memo,
  je.status,
  pg_catalog.concat_ws(
    ' ', je.reference_no, je.memo, je.source_type, a.code, a.name, jl.description
  ) as search_text,
  pg_catalog.sum(
    case when a.normal_side = 'debit'
      then jl.debit - jl.credit
      else jl.credit - jl.debit
    end
  ) over (
    partition by jl.company_id, jl.account_id
    order by je.journal_date, je.created_at, jl.line_no, jl.id
    rows between unbounded preceding and current row
  )::numeric(20,2) as balance,
  jl.company_id
from public.journal_lines jl
join public.journal_entries je
  on je.id = jl.journal_entry_id and je.company_id = jl.company_id
join public.accounts a on a.id = jl.account_id;

create or replace view public.account_balances
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
  end::numeric(20,2) as balance,
  c.id as company_id
from public.companies c
cross join public.accounts a
left join public.journal_lines jl
  on jl.account_id = a.id and jl.company_id = c.id
where c.is_active
group by c.id, a.id, a.code, a.name, a.category, a.normal_side;

create or replace view public.account_balances_by_year
with (security_invoker = true)
as
select
  years.fiscal_year,
  a.id as account_id,
  a.code as account_code,
  a.name as account_name,
  a.category,
  a.normal_side,
  coalesce(pg_catalog.sum(jl.debit) filter (
    where je.journal_date < pg_catalog.make_date(years.fiscal_year + 1, 1, 1)
  ), 0)::numeric(20,2) as debit_total,
  coalesce(pg_catalog.sum(jl.credit) filter (
    where je.journal_date < pg_catalog.make_date(years.fiscal_year + 1, 1, 1)
  ), 0)::numeric(20,2) as credit_total,
  case when a.normal_side = 'debit' then coalesce(pg_catalog.sum(
    jl.debit - jl.credit
  ) filter (
    where je.journal_date < pg_catalog.make_date(years.fiscal_year + 1, 1, 1)
  ), 0) else coalesce(pg_catalog.sum(
    jl.credit - jl.debit
  ) filter (
    where je.journal_date < pg_catalog.make_date(years.fiscal_year + 1, 1, 1)
  ), 0) end::numeric(20,2) as balance,
  years.company_id
from (
  select c.id as company_id, y.fiscal_year
  from public.companies c
  cross join lateral (
    select pg_catalog.generate_series(2000, 2200)::integer as fiscal_year
  ) y
  where c.is_active
) years
cross join public.accounts a
left join public.journal_entries je on je.company_id = years.company_id
left join public.journal_lines jl
  on jl.journal_entry_id = je.id and jl.account_id = a.id
group by years.company_id, years.fiscal_year,
         a.id, a.code, a.name, a.category, a.normal_side;

create or replace view public.employee_open_earnings
with (security_invoker = true)
as
select
  e.id as employee_id, e.employee_no, e.name as employee_name,
  dw.work_date, 'daily_work'::text as source_type, dw.id as source_id,
  'Daily work'::text as description, dw.work_units::numeric(20,6) as quantity,
  dw.daily_rate::numeric(20,6) as rate, dw.base_amount::numeric(20,2) as amount,
  dw.company_id
from public.daily_work dw
join public.employees e on e.id = dw.employee_id and e.company_id = dw.company_id
where dw.status = 'posted' and dw.base_amount > 0
  and not exists (
    select 1 from public.payroll_details pd
    where pd.company_id = dw.company_id
      and pd.source_daily_work_id = dw.id and pd.is_active
  )
union all
select
  e.id, e.employee_no, e.name, c.conversion_date,
  'conversion_piecework', cw.id, cw.task,
  cw.quantity_kg, cw.rate_per_kg, cw.amount, c.company_id
from public.conversion_workers cw
join public.employees e on e.id = cw.employee_id and e.company_id = cw.company_id
join public.conversions c on c.id = cw.conversion_id and c.company_id = cw.company_id
where c.status = 'posted'
  and not exists (
    select 1 from public.payroll_details pd
    where pd.company_id = cw.company_id
      and pd.source_conversion_worker_id = cw.id and pd.is_active
  )
union all
select
  e.id, e.employee_no, e.name, dw.work_date,
  'manual_piecework', dwp.id, dwp.task,
  dwp.quantity_kg, dwp.rate_per_kg, dwp.amount, dw.company_id
from public.daily_work_piecework dwp
join public.daily_work dw on dw.id = dwp.daily_work_id and dw.company_id = dwp.company_id
join public.employees e on e.id = dw.employee_id and e.company_id = dw.company_id
where dw.status = 'posted'
  and not exists (
    select 1 from public.payroll_details pd
    where pd.company_id = dwp.company_id
      and pd.source_manual_piecework_id = dwp.id and pd.is_active
  );

create or replace view public.sales_outstanding
with (security_invoker = true)
as select s.* from public.sales s where s.status = 'posted' and s.balance_due > 0;

create or replace view public.payroll_outstanding
with (security_invoker = true)
as select p.* from public.payrolls p where p.status = 'posted' and p.balance_due > 0;

create or replace view public.production_daily_summary
with (security_invoker = true)
as
select
  p.production_date,
  pg_catalog.count(*)::bigint as run_count,
  coalesce(pg_catalog.sum(p.input_kg), 0::numeric)::numeric(20,6) as input_kg,
  coalesce(pg_catalog.sum(p.output_quantity), 0::numeric)::numeric(20,6) as output_quantity,
  coalesce(pg_catalog.sum(p.total_cost), 0::numeric)::numeric(20,2) as total_cost,
  p.company_id
from public.production_runs p
where p.status = 'posted'
group by p.company_id, p.production_date;

create or replace view public.overtime_work_view
with (security_invoker = true)
as
select
  ot.id, ot.reference_no, ot.employee_id,
  e.employee_no, e.name as employee_name, ot.work_date, ot.hours, ot.rate,
  ot.amount, ot.notes, ot.revision, ot.status, ot.replaces_id,
  ot.created_at, ot.updated_at,
  c.payroll_id as claimed_payroll_id,
  c.payroll_reference_no as claimed_payroll_reference,
  ot.company_id
from public.overtime_entries ot
join public.employees e on e.id = ot.employee_id and e.company_id = ot.company_id
left join lateral (
  select poc.payroll_id, poc.payroll_reference_no
  from public.payroll_overtime_claims poc
  where poc.company_id = ot.company_id
    and poc.overtime_id = ot.id and poc.is_active
  order by poc.claimed_at desc, poc.id desc
  limit 1
) c on true;

create view public.shared_inventory_availability
with (security_invoker = true)
as
select
  i.id as item_id,
  i.sku,
  i.name as item_name,
  i.stage,
  i.unit,
  coalesce(b.quantity_on_hand, 0::numeric)::numeric(20,6) as quantity_on_hand,
  b.last_movement_at,
  i.is_active
from public.inventory_items i
left join public.inventory_balances b on b.item_id = i.id;

-- -------------------------------------------------------------------------
-- Row-level isolation and least-privilege Data API exposure
-- -------------------------------------------------------------------------

alter table public.companies enable row level security;
alter table public.company_memberships enable row level security;
alter table public.company_user_roles enable row level security;
alter table public.company_inventory_balances enable row level security;
alter table public.fiscal_periods enable row level security;

revoke all on table
  public.companies, public.company_memberships, public.company_user_roles,
  public.company_inventory_balances, public.fiscal_periods
from public, anon, authenticated;

grant select on table
  public.companies, public.company_memberships, public.company_user_roles,
  public.company_inventory_balances, public.fiscal_periods
to authenticated;

drop policy if exists companies_read on public.companies;
create policy companies_read on public.companies
for select to authenticated
using ((select private.is_active_erp_user()));

drop policy if exists company_memberships_read on public.company_memberships;
create policy company_memberships_read on public.company_memberships
for select to authenticated
using (
  user_id = (select auth.uid())
  or private.has_company_permission(company_id, 'system.admin')
);

drop policy if exists company_user_roles_read on public.company_user_roles;
create policy company_user_roles_read on public.company_user_roles
for select to authenticated
using (
  user_id = (select auth.uid())
  or private.has_company_permission(company_id, 'system.admin')
);

drop policy if exists company_inventory_read on public.company_inventory_balances;
create policy company_inventory_read on public.company_inventory_balances
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['inventory.read','production.read','sales.read','finance.read','reports.read']::text[]
));

drop policy if exists fiscal_periods_read on public.fiscal_periods;
create policy fiscal_periods_read on public.fiscal_periods
for select to authenticated
using (private.has_company_any_permission(
  company_id, array['finance.read','finance.write','reports.read']::text[]
));

drop policy if exists profiles_read_self on public.profiles;
drop policy if exists profiles_company_admin_read on public.profiles;
create policy profiles_company_admin_read on public.profiles
for select to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.company_memberships target_membership
    where target_membership.user_id = profiles.user_id
      and private.has_company_permission(target_membership.company_id, 'system.admin')
  )
  or exists (
    select 1 from public.profiles caller
    where caller.user_id = (select auth.uid())
      and caller.is_active and caller.is_super_admin
  )
);

drop policy if exists user_roles_read_self on public.user_roles;
create policy user_roles_read_self on public.user_roles
for select to authenticated
using ((select auth.uid()) = user_id and (select private.is_active_erp_user()));

do $company_read_policies$
declare
  v_table text;
begin
  foreach v_table in array array[
    'employees', 'employee_compensation_history', 'daily_work',
    'daily_work_piecework', 'daily_work_conversion_links', 'overtime_entries'
  ]
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using (private.has_company_any_permission(company_id, '
      || 'array[''employees.read'',''payroll.read'',''production.read'',''reports.read'']::text[]))',
      v_table
    );
  end loop;

  foreach v_table in array array[
    'raw_material_purchases', 'conversions', 'conversion_workers',
    'production_runs', 'stock_adjustments', 'stock_movements'
  ]
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using (private.has_company_any_permission(company_id, '
      || 'array[''inventory.read'',''production.read'',''sales.read'',''reports.read'',''dashboard.read'']::text[]))',
      v_table
    );
  end loop;

  foreach v_table in array array['sales', 'sale_items', 'sale_payments']
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using (private.has_company_any_permission(company_id, '
      || 'array[''sales.read'',''reports.read'',''dashboard.read'',''finance.read'']::text[]))',
      v_table
    );
  end loop;

  foreach v_table in array array[
    'payrolls', 'payroll_details', 'payroll_payments', 'payroll_overtime_claims'
  ]
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using (private.has_company_any_permission(company_id, '
      || 'array[''payroll.read'',''reports.read'',''dashboard.read'',''finance.read'']::text[]))',
      v_table
    );
  end loop;

  foreach v_table in array array['journal_entries', 'journal_lines']
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using (private.has_company_any_permission(company_id, '
      || 'array[''finance.read'',''reports.read'',''dashboard.read'']::text[]))',
      v_table
    );
  end loop;
end;
$company_read_policies$;

drop policy if exists audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log
for select to authenticated
using (private.has_company_permission(company_id, 'audit.read'));

-- Shared item masters and physical quantities are deliberately visible to a
-- permitted user from either company.  Company cost ownership is protected by
-- the policy above.
drop policy if exists erp_read on public.inventory_items;
create policy erp_read on public.inventory_items
for select to authenticated
using ((select private.has_any_permission(
  array['inventory.read','production.read','sales.read','reports.read','dashboard.read']::text[]
)));
drop policy if exists erp_read on public.inventory_balances;
create policy erp_read on public.inventory_balances
for select to authenticated
using ((select private.has_any_permission(
  array['inventory.read','production.read','sales.read','reports.read','dashboard.read']::text[]
)));

revoke all on table
  public.current_user_access, public.admin_user_access,
  public.shared_inventory_availability,
  public.ledger_view, public.account_balances, public.account_balances_by_year,
  public.employee_open_earnings, public.sales_outstanding,
  public.payroll_outstanding, public.production_daily_summary,
  public.overtime_work_view
from anon, authenticated;
grant select on table
  public.current_user_access, public.admin_user_access,
  public.shared_inventory_availability,
  public.ledger_view, public.account_balances, public.account_balances_by_year,
  public.employee_open_earnings, public.sales_outstanding,
  public.payroll_outstanding, public.production_daily_summary,
  public.overtime_work_view
to authenticated;

-- -------------------------------------------------------------------------
-- Company user administration and the verified company RPC boundary
-- -------------------------------------------------------------------------

alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_company_scope;

create function private.perform_operation_v2(
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
  v_company_id uuid := private.current_company_id();
  v_target_user_id uuid;
  v_role_codes text[];
  v_is_active boolean;
  v_is_primary boolean;
  v_admin_role_id bigint;
begin
  if p_operation = 'system.purge_business_data' then
    if not exists (
      select 1 from public.profiles p
      where p.user_id = p_actor and p.is_active and p.is_super_admin
    ) then
      raise exception using errcode = '42501', message = 'Only the group super administrator can purge both companies';
    end if;
    if coalesce(p_payload ->> 'confirmation', '') <> 'DELETE ALL BUSINESS DATA'
       or not (p_payload @> '{"acknowledge_irreversible": true}'::jsonb) then
      raise exception using errcode = '22023', message = 'Exact purge confirmation and irreversible acknowledgement are required';
    end if;

    truncate table
      public.payroll_overtime_claims,
      public.overtime_entries,
      public.payroll_details,
      public.payroll_payments,
      public.payrolls,
      public.sale_items,
      public.sale_payments,
      public.sales,
      public.daily_work_conversion_links,
      public.daily_work_piecework,
      public.daily_work,
      public.conversion_workers,
      public.conversions,
      public.production_runs,
      public.raw_material_purchases,
      public.stock_adjustments,
      public.stock_movements,
      public.company_inventory_balances,
      public.inventory_balances,
      public.journal_lines,
      public.journal_entries,
      public.employee_compensation_history,
      public.employees,
      public.piecework_rates,
      public.conversion_types,
      public.inventory_items,
      public.audit_log
    restart identity;

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', null,
      'purged_at', pg_catalog.clock_timestamp(),
      'preserved', pg_catalog.jsonb_build_array(
        'authentication accounts', 'company memberships and roles',
        'legal company definitions', 'chart of accounts',
        'fiscal period controls', 'database schema and configuration'
      )
    );
  end if;

  if p_operation <> 'admin.user_access.set' then
    return private.perform_operation_before_company_scope(
      p_operation, p_payload, p_actor
    );
  end if;

  if p_actor is null or p_actor <> (select auth.uid()) then
    raise exception using errcode = '42501', message = 'A valid authenticated actor is required';
  end if;
  if v_company_id is null
     or not private.has_company_permission(v_company_id, 'system.admin') then
    raise exception using errcode = '42501', message = 'Company administrator permission is required';
  end if;

  v_target_user_id := (p_payload ->> 'user_id')::uuid;
  v_is_active := coalesce((p_payload ->> 'is_active')::boolean, true);
  v_is_primary := coalesce((p_payload ->> 'is_primary')::boolean, false);
  if pg_catalog.jsonb_typeof(coalesce(p_payload -> 'role_codes', '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_payload -> 'role_codes', '[]'::jsonb)) > 10 then
    raise exception using errcode = '22023', message = 'role_codes must be an array of at most 10 roles';
  end if;
  select coalesce(pg_catalog.array_agg(distinct x.code order by x.code), array[]::text[])
  into v_role_codes
  from pg_catalog.jsonb_array_elements_text(
    coalesce(p_payload -> 'role_codes', '[]'::jsonb)
  ) x(code);
  if v_is_active and pg_catalog.cardinality(v_role_codes) = 0 then
    raise exception using errcode = '22023', message = 'An active company user requires at least one role';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(v_role_codes) x(code)
    left join public.roles r on r.code = x.code
    where r.id is null
  ) then
    raise exception using errcode = '22023', message = 'One or more role codes are invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('company-access:' || v_company_id::text, 0)
  );
  perform 1 from public.profiles p where p.user_id = v_target_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'User profile not found';
  end if;

  select id into v_admin_role_id from public.roles where code = 'admin';
  if exists (
    select 1 from public.company_user_roles cur
    join public.company_memberships cm
      on cm.company_id = cur.company_id and cm.user_id = cur.user_id
    where cur.company_id = v_company_id
      and cur.user_id = v_target_user_id
      and cur.role_id = v_admin_role_id
      and cm.is_active
  ) and (
    not v_is_active or not ('admin' = any(v_role_codes))
  ) and (
    select pg_catalog.count(*)
    from public.company_user_roles cur
    join public.company_memberships cm
      on cm.company_id = cur.company_id and cm.user_id = cur.user_id
    where cur.company_id = v_company_id
      and cur.role_id = v_admin_role_id
      and cm.is_active
  ) <= 1 then
    raise exception using errcode = '23514', message = 'Each company must retain at least one active administrator';
  end if;

  insert into public.company_memberships (
    company_id, user_id, is_active, is_primary, created_by, updated_by
  ) values (
    v_company_id, v_target_user_id, v_is_active, v_is_primary, p_actor, p_actor
  )
  on conflict (company_id, user_id) do update
  set is_active = excluded.is_active,
      is_primary = excluded.is_primary,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_actor;

  if v_is_primary and v_is_active then
    update public.company_memberships
    set is_primary = false,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where user_id = v_target_user_id
      and company_id <> v_company_id
      and is_primary;
  end if;

  delete from public.company_user_roles cur
  where cur.company_id = v_company_id and cur.user_id = v_target_user_id;
  if v_is_active then
    insert into public.company_user_roles (
      company_id, user_id, role_id, created_by
    )
    select v_company_id, v_target_user_id, r.id, p_actor
    from public.roles r
    where r.code = any(v_role_codes);
  end if;

  update public.profiles
  set display_name = case
        when p_payload ? 'display_name'
          then pg_catalog.left(pg_catalog.btrim(p_payload ->> 'display_name'), 200)
        else display_name
      end,
      is_active = is_active or v_is_active,
      updated_at = pg_catalog.clock_timestamp()
  where user_id = v_target_user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'operation', p_operation, 'id', v_target_user_id,
    'company_id', v_company_id, 'idempotent', false
  );
end;
$function$;

-- Move the current public facade behind a new company-verification boundary.
alter function public.erp_execute(text, jsonb, text) set schema private;
alter function private.erp_execute(text, jsonb, text)
  rename to erp_execute_before_company_scope;

create function public.erp_execute(
  p_operation text,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_company_id uuid;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Payload must be a JSON object';
  end if;
  begin
    v_company_id := nullif(p_payload ->> 'company_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'A valid company_id is required';
  end;
  if v_company_id is null or not private.can_access_company(v_company_id) then
    raise exception using errcode = '42501', message = 'The selected company is not assigned to this user';
  end if;
  if p_operation = 'system.purge_business_data' and not exists (
    select 1 from public.profiles p
    where p.user_id = v_actor and p.is_active and p.is_super_admin
  ) then
    raise exception using errcode = '42501', message = 'Only the group super administrator can purge both companies';
  end if;

  perform pg_catalog.set_config('app.current_company_id', v_company_id::text, true);
  return private.erp_execute_before_company_scope(
    p_operation, p_payload, p_idempotency_key
  );
end;
$function$;

-- Dashboard calculations explicitly filter the selected legal company.  Only
-- physical availability is shared; financial and workforce totals never are.
create function public.erp_company_dashboard(
  p_company_id uuid,
  p_year integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_year integer := coalesce(p_year, extract(year from current_date)::integer);
  v_inventory jsonb;
  v_finance jsonb;
  v_workforce jsonb;
  v_operations jsonb;
  v_revenue numeric(20,2);
  v_cogs numeric(20,2);
  v_expenses numeric(20,2);
  v_receivables numeric(20,2);
  v_payables numeric(20,2);
  v_cash_bank numeric(20,2);
begin
  if not private.can_access_company(p_company_id) then
    raise exception using errcode = '42501', message = 'The selected company is not assigned to this user';
  end if;
  if not private.has_company_any_permission(
    p_company_id, array['dashboard.read','reports.read']::text[]
  ) then
    raise exception using errcode = '42501', message = 'Dashboard permission denied for this company';
  end if;
  if v_year not between 2000 and 2200 then
    raise exception using errcode = '22023', message = 'Dashboard year is out of range';
  end if;
  perform pg_catalog.set_config('app.current_company_id', p_company_id::text, true);

  select pg_catalog.jsonb_build_object(
    'bulk', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'stage', 'bulk', 'item_count', pg_catalog.count(*) filter (where i.stage = 'bulk'),
      'quantity_on_hand', coalesce(pg_catalog.sum(b.quantity_on_hand) filter (where i.stage = 'bulk'), 0),
      'inventory_value', coalesce(pg_catalog.sum(cb.inventory_value) filter (where i.stage = 'bulk'), 0)
    )),
    'chip', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'stage', 'chip', 'item_count', pg_catalog.count(*) filter (where i.stage = 'chip'),
      'quantity_on_hand', coalesce(pg_catalog.sum(b.quantity_on_hand) filter (where i.stage = 'chip'), 0),
      'inventory_value', coalesce(pg_catalog.sum(cb.inventory_value) filter (where i.stage = 'chip'), 0)
    )),
    'finished', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'stage', 'finished', 'item_count', pg_catalog.count(*) filter (where i.stage = 'finished'),
      'quantity_on_hand', coalesce(pg_catalog.sum(b.quantity_on_hand) filter (where i.stage = 'finished'), 0),
      'inventory_value', coalesce(pg_catalog.sum(cb.inventory_value) filter (where i.stage = 'finished'), 0)
    ))
  ) into v_inventory
  from public.inventory_items i
  left join public.inventory_balances b on b.item_id = i.id
  left join public.company_inventory_balances cb
    on cb.item_id = i.id and cb.company_id = p_company_id
  where i.is_active;

  select
    coalesce(pg_catalog.sum(case when a.category = 'revenue' then jl.credit - jl.debit else 0 end), 0),
    coalesce(pg_catalog.sum(case when a.code = 'COGS' then jl.debit - jl.credit else 0 end), 0),
    coalesce(pg_catalog.sum(case when a.category = 'expense' and a.code <> 'COGS'
      then jl.debit - jl.credit else 0 end), 0)
  into v_revenue, v_cogs, v_expenses
  from public.journal_lines jl
  join public.journal_entries je
    on je.id = jl.journal_entry_id and je.company_id = jl.company_id
  join public.accounts a on a.id = jl.account_id
  where je.company_id = p_company_id
    and je.journal_date >= pg_catalog.make_date(v_year, 1, 1)
    and je.journal_date < pg_catalog.make_date(v_year + 1, 1, 1);

  select coalesce(pg_catalog.sum(s.balance_due), 0)
  into v_receivables
  from public.sales s
  where s.company_id = p_company_id and s.status = 'posted';

  select
    coalesce(pg_catalog.sum(ab.balance) filter (where ab.category = 'liability'), 0),
    coalesce(pg_catalog.sum(ab.balance) filter (where ab.account_code in ('CASH','BANK')), 0)
  into v_payables, v_cash_bank
  from public.account_balances ab
  where ab.company_id = p_company_id;

  v_finance := pg_catalog.jsonb_build_object(
    'revenue', v_revenue, 'cogs', v_cogs, 'expenses', v_expenses,
    'receivables', v_receivables, 'payables', v_payables,
    'cash_bank', v_cash_bank
  );

  select pg_catalog.jsonb_build_object(
    'active_employees', pg_catalog.count(*) filter (where e.status = 'active'),
    'open_daily_wages', coalesce((select pg_catalog.sum(oe.amount)
      from public.employee_open_earnings oe
      where oe.company_id = p_company_id and oe.source_type = 'daily_work'), 0),
    'open_piecework', coalesce((select pg_catalog.sum(oe.amount)
      from public.employee_open_earnings oe
      where oe.company_id = p_company_id and oe.source_type <> 'daily_work'), 0)
  ) into v_workforce
  from public.employees e
  where e.company_id = p_company_id;

  v_operations := pg_catalog.jsonb_build_object(
    'purchases', (select pg_catalog.count(*) from public.raw_material_purchases r
      where r.company_id = p_company_id and r.status = 'posted'
        and r.purchase_date >= pg_catalog.make_date(v_year,1,1)
        and r.purchase_date < pg_catalog.make_date(v_year+1,1,1)),
    'conversions', (select pg_catalog.count(*) from public.conversions c
      where c.company_id = p_company_id and c.status = 'posted'
        and c.conversion_date >= pg_catalog.make_date(v_year,1,1)
        and c.conversion_date < pg_catalog.make_date(v_year+1,1,1)),
    'production', (select pg_catalog.count(*) from public.production_runs p
      where p.company_id = p_company_id and p.status = 'posted'
        and p.production_date >= pg_catalog.make_date(v_year,1,1)
        and p.production_date < pg_catalog.make_date(v_year+1,1,1)),
    'sales', (select pg_catalog.count(*) from public.sales s
      where s.company_id = p_company_id and s.status = 'posted'
        and s.sale_date >= pg_catalog.make_date(v_year,1,1)
        and s.sale_date < pg_catalog.make_date(v_year+1,1,1)),
    'payroll', (select pg_catalog.count(*) from public.payrolls p
      where p.company_id = p_company_id and p.status = 'posted'
        and p.payroll_date >= pg_catalog.make_date(v_year,1,1)
        and p.payroll_date < pg_catalog.make_date(v_year+1,1,1))
  );

  return pg_catalog.jsonb_build_object(
    'year', v_year, 'company_id', p_company_id,
    'inventory', v_inventory, 'finance', v_finance,
    'workforce', v_workforce, 'operations', v_operations,
    'generated_at', pg_catalog.clock_timestamp()
  );
end;
$function$;

-- No private function is a public API.  Publish only the two reviewed RPCs.
revoke all on function
  private.current_company_id(),
  private.can_access_company(uuid),
  private.has_company_permission(uuid,text),
  private.has_company_any_permission(uuid,text[]),
  private.assert_open_period(uuid,date),
  private.lock_company_inventory(uuid,uuid[]),
  private.company_inventory_cost(uuid,uuid,numeric),
  private.perform_operation_before_company_scope(text,jsonb,uuid),
  private.perform_operation_v2(text,jsonb,uuid),
  private.erp_execute_before_company_scope(text,jsonb,text)
from public, anon, authenticated;

grant execute on function private.has_permission(text) to authenticated;
grant execute on function private.has_any_permission(text[]) to authenticated;
grant execute on function private.is_active_erp_user() to authenticated;
grant execute on function private.has_company_permission(uuid,text) to authenticated;
grant execute on function private.has_company_any_permission(uuid,text[]) to authenticated;

revoke all on function public.erp_execute(text,jsonb,text)
from public, anon, authenticated;
revoke all on function public.erp_company_dashboard(uuid,integer)
from public, anon, authenticated;
grant execute on function public.erp_execute(text,jsonb,text) to authenticated;
grant execute on function public.erp_company_dashboard(uuid,integer) to authenticated;

notify pgrst, 'reload schema';

commit;
