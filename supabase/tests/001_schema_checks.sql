-- Run after all migrations. This script is read-only and fails immediately
-- when the public ERP contract or its security boundary is incomplete.
begin;

do $checks$
declare
  v_name text;
  v_default text;
begin
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosrc like '%pg_catalog.current_date%'
  ) then
    raise exception 'ERP functions must not schema-qualify CURRENT_DATE';
  end if;

  if pg_catalog.to_regprocedure('public.erp_execute(text,jsonb,text)') is null then
    raise exception 'Missing public.erp_execute(text,jsonb,text)';
  end if;
  if pg_catalog.to_regprocedure('public.erp_dashboard(integer)') is null then
    raise exception 'Missing public.erp_dashboard(integer)';
  end if;

  foreach v_name in array array[
    'current_user_access', 'inventory_position', 'inventory_stage_summary',
    'production_daily_summary', 'account_balances', 'account_balances_by_year',
    'employee_open_earnings', 'sales_outstanding', 'payroll_outstanding',
    'ledger_view', 'overtime_work_view'
  ]
  loop
    if pg_catalog.to_regclass('public.' || v_name) is null then
      raise exception 'Missing public read model: %', v_name;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = v_name
        and 'security_invoker=true' = any(coalesce(c.reloptions, array[]::text[]))
    ) then
      raise exception 'Read model % must use security_invoker=true', v_name;
    end if;
  end loop;

  select pg_catalog.pg_get_expr(d.adbin, d.adrelid)
  into v_default
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public'
    and c.relname = 'profiles'
    and a.attname = 'is_active';
  if coalesce(v_default, '') not in ('false', 'false::boolean') then
    raise exception 'New profiles must default to inactive';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any(array[
        'profiles', 'roles', 'permissions', 'user_roles', 'role_permissions',
        'employees', 'employee_compensation_history', 'conversion_types',
        'piecework_rates',
        'inventory_items', 'accounts',
        'journal_entries', 'journal_lines', 'raw_material_purchases',
        'conversions', 'conversion_workers', 'daily_work',
        'daily_work_piecework', 'daily_work_conversion_links', 'overtime_entries',
        'payroll_overtime_claims', 'production_runs',
        'sales', 'sale_items', 'sale_payments', 'payrolls', 'payroll_details',
        'payroll_payments', 'stock_adjustments', 'inventory_balances',
        'stock_movements', 'audit_log', 'idempotency_keys'
      ])
      and not c.relrowsecurity
  ) then
    raise exception 'One or more exposed ERP tables do not have RLS enabled';
  end if;

  if pg_catalog.has_function_privilege(
    'anon', 'public.erp_execute(text,jsonb,text)', 'execute'
  ) then
    raise exception 'anon must not execute public.erp_execute';
  end if;
  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null
     and (
       pg_catalog.has_function_privilege('anon', 'public.rls_auto_enable()', 'execute')
       or pg_catalog.has_function_privilege(
         'authenticated', 'public.rls_auto_enable()', 'execute'
       )
     ) then
    raise exception 'Data API roles must not execute public.rls_auto_enable';
  end if;
  if not pg_catalog.has_function_privilege(
    'authenticated', 'public.erp_execute(text,jsonb,text)', 'execute'
  ) then
    raise exception 'authenticated must execute public.erp_execute';
  end if;
  if pg_catalog.has_schema_privilege('anon', 'private', 'usage')
     or pg_catalog.has_schema_privilege('authenticated', 'private', 'usage') then
    raise exception 'Data API roles must not have USAGE on private schema';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.profiles', 'select') then
    raise exception 'anon must not read public.profiles';
  end if;
  if not pg_catalog.has_table_privilege(
    'authenticated', 'public.current_user_access', 'select'
  ) then
    raise exception 'authenticated must read public.current_user_access';
  end if;
  if not exists (
    select 1
    from public.permissions p
    join public.role_permissions rp on rp.permission_id = p.id
    join public.roles r on r.id = rp.role_id
    where p.code = 'system.admin' and r.code = 'admin'
  ) then
    raise exception 'Administrator role is missing system.admin';
  end if;
  if exists (
    select 1
    from public.profiles p
    where p.is_active
      and not exists (
        select 1 from public.user_roles ur where ur.user_id = p.user_id
      )
  ) then
    raise exception 'An active profile has no assigned role';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and indexname = 'sales_invoice_no_posted_idx'
  ) then
    raise exception 'Missing live-invoice uniqueness index';
  end if;
  if pg_catalog.to_regclass('public.conversion_types') is null then
    raise exception 'Missing public.conversion_types';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.piecework_rates'::regclass
      and a.attname = 'conversion_type_id'
      and not a.attisdropped
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.conversions'::regclass
      and a.attname = 'conversion_type_id'
      and not a.attisdropped
  ) then
    raise exception 'Conversion type links are incomplete';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.overtime_entries'::regclass
      and t.tgname = 'overtime_entries_rpc_guard'
      and not t.tgisinternal
  ) or not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.payroll_overtime_claims'::regclass
      and t.tgname = 'payroll_overtime_claims_rpc_guard'
      and not t.tgisinternal
  ) then
    raise exception 'Overtime write guards are incomplete';
  end if;
end;
$checks$;

rollback;
