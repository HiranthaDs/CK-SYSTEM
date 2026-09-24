-- Transactional destructive-operation checks. The final ROLLBACK restores the
-- database exactly as it was before this script, including identity sequences.
begin;

create temporary table purge_preserved_counts (
  relation_name text primary key,
  row_count bigint not null
) on commit drop;

insert into purge_preserved_counts (relation_name, row_count) values
  ('auth.users', (select pg_catalog.count(*) from auth.users)),
  ('public.profiles', (select pg_catalog.count(*) from public.profiles)),
  ('public.roles', (select pg_catalog.count(*) from public.roles)),
  ('public.permissions', (select pg_catalog.count(*) from public.permissions)),
  ('public.user_roles', (select pg_catalog.count(*) from public.user_roles)),
  ('public.role_permissions', (select pg_catalog.count(*) from public.role_permissions)),
  ('public.accounts', (select pg_catalog.count(*) from public.accounts));

-- A signed-in identity with no active ERP profile must not reach the purge.
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  pg_catalog.gen_random_uuid()::text,
  true
);
set local role authenticated;

do $non_admin_denied$
begin
  begin
    perform public.erp_execute(
      'system.purge_business_data',
      '{"confirmation":"DELETE ALL BUSINESS DATA","acknowledge_irreversible":true}'::jsonb,
      'purge-non-admin-test'
    );
    raise exception 'A non-administrator unexpectedly reached the purge operation';
  exception
    when sqlstate '42501' then null;
  end;
end;
$non_admin_denied$;

reset role;

-- Use a real active administrator for the remaining checks.
do $select_admin$
declare
  v_user_id uuid;
begin
  select p.user_id
  into v_user_id
  from public.profiles p
  join public.user_roles ur on ur.user_id = p.user_id
  join public.roles r on r.id = ur.role_id
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions pe on pe.id = rp.permission_id
  where p.is_active
    and pe.code = 'system.admin'
  order by p.created_at, p.user_id
  limit 1;

  if v_user_id is null then
    raise exception 'An active system administrator is required for purge checks';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_user_id::text, true);
end;
$select_admin$;

set local role authenticated;

-- Seed one representative record through the same audited facade used by the
-- API. Earlier live data, if present, is also restored by the final rollback.
select public.erp_execute(
  'employee.upsert',
  pg_catalog.jsonb_build_object(
    'employee_no', 'EMP-PURGE-TRANSACTION-TEST',
    'name', 'Purge transaction sentinel',
    'joined_date', current_date,
    'pay_model', 'monthly',
    'monthly_rate', 1,
    'status', 'active'
  ),
  'purge-seed-test-0001'
);

-- An inexact phrase is rejected before acquiring the purge lock or changing
-- any idempotency/audit state.
do $wrong_confirmation$
begin
  begin
    perform public.erp_execute(
      'system.purge_business_data',
      '{"confirmation":"delete all business data","acknowledge_irreversible":true}'::jsonb,
      'purge-wrong-confirmation'
    );
    raise exception 'An inexact purge confirmation was unexpectedly accepted';
  exception
    when sqlstate '22023' then null;
  end;

  if not exists (
    select 1 from public.employees where employee_no = 'EMP-PURGE-TRANSACTION-TEST'
  ) then
    raise exception 'Rejected purge changed business data';
  end if;
end;
$wrong_confirmation$;

select public.erp_execute(
  'system.purge_business_data',
  '{"confirmation":"DELETE ALL BUSINESS DATA","acknowledge_irreversible":true}'::jsonb,
  'purge-valid-test-0001'
);

-- The same receipt must make a transport retry safe and must not create a
-- second audit event.
do $idempotent_retry$
declare
  v_result jsonb;
begin
  select public.erp_execute(
    'system.purge_business_data',
    '{"confirmation":"DELETE ALL BUSINESS DATA","acknowledge_irreversible":true}'::jsonb,
    'purge-valid-test-0001'
  ) into v_result;

  if coalesce((v_result ->> 'idempotent')::boolean, false) is not true then
    raise exception 'Purge retry did not return its idempotent receipt';
  end if;
end;
$idempotent_retry$;

reset role;

do $verify_purge$
declare
  v_table text;
  v_count bigint;
begin
  foreach v_table in array array[
    'payroll_overtime_claims', 'overtime_entries',
    'payroll_details', 'payroll_payments', 'payrolls',
    'sale_items', 'sale_payments', 'sales',
    'daily_work_conversion_links', 'daily_work_piecework', 'daily_work',
    'conversion_workers', 'conversions', 'production_runs',
    'raw_material_purchases', 'stock_adjustments', 'stock_movements',
    'inventory_balances', 'journal_lines', 'journal_entries',
    'employee_compensation_history', 'employees', 'piecework_rates',
    'conversion_types',
    'inventory_items'
  ]
  loop
    execute pg_catalog.format('select count(*) from public.%I', v_table) into v_count;
    if v_count <> 0 then
      raise exception 'Purged table public.% still contains % row(s)', v_table, v_count;
    end if;
  end loop;

  if (select pg_catalog.count(*) from public.audit_log) <> 1
     or not exists (
       select 1 from public.audit_log
       where operation = 'system.purge_business_data'
         and action = 'execute'
     ) then
    raise exception 'Purge must leave exactly one system purge audit event';
  end if;

  if (select pg_catalog.count(*) from public.idempotency_keys) <> 1
     or not exists (
       select 1 from public.idempotency_keys
       where operation = 'system.purge_business_data'
         and idempotency_key = 'purge-valid-test-0001'
         and response is not null
     ) then
    raise exception 'Purge must retain only its completed retry receipt';
  end if;

  if (select pg_catalog.count(*) from auth.users)
       <> (select row_count from purge_preserved_counts where relation_name = 'auth.users')
     or (select pg_catalog.count(*) from public.profiles)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.profiles')
     or (select pg_catalog.count(*) from public.roles)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.roles')
     or (select pg_catalog.count(*) from public.permissions)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.permissions')
     or (select pg_catalog.count(*) from public.user_roles)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.user_roles')
     or (select pg_catalog.count(*) from public.role_permissions)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.role_permissions')
     or (select pg_catalog.count(*) from public.accounts)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.accounts') then
    raise exception 'Purge changed authentication, RBAC, or chart-of-accounts configuration';
  end if;
end;
$verify_purge$;

rollback;
