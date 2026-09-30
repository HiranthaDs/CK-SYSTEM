-- Account-lifecycle and company-scoped destructive-operation checks. The final
-- ROLLBACK restores users, RBAC, data, audit rows, and identity sequences.
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
  ('public.companies', (select pg_catalog.count(*) from public.companies)),
  ('public.company_memberships', (select pg_catalog.count(*) from public.company_memberships)),
  ('public.company_user_roles', (select pg_catalog.count(*) from public.company_user_roles)),
  ('public.accounts', (select pg_catalog.count(*) from public.accounts)),
  ('public.inventory_items', (select pg_catalog.count(*) from public.inventory_items)),
  ('public.conversion_types', (select pg_catalog.count(*) from public.conversion_types)),
  ('public.piecework_rates', (select pg_catalog.count(*) from public.piecework_rates));

do $safeupdate_compatible_purge$
begin
  if pg_catalog.strpos(
    pg_catalog.lower(pg_catalog.pg_get_functiondef(
      'private.perform_operation_v2(text,jsonb,uuid)'::pg_catalog.regprocedure
    )),
    'where b.item_id is not null'
  ) = 0 then
    raise exception 'Company purge inventory reconciliation is incompatible with pg-safeupdate';
  end if;
end;
$safeupdate_compatible_purge$;

select pg_catalog.set_config('request.jwt.claim.sub', pg_catalog.gen_random_uuid()::text, true);
set local role authenticated;
do $non_admin_denied$
begin
  begin
    perform public.remove_user_account(
      pg_catalog.gen_random_uuid(), '2113', 'unauthorized-remove', 'unauthorized-remove-key'
    );
    raise exception 'A non-super administrator unexpectedly removed an account';
  exception when sqlstate '42501' then null;
  end;
end;
$non_admin_denied$;
reset role;

do $select_test_context$
declare
  v_actor uuid;
  v_other_admin uuid;
  v_target_company uuid;
  v_target_code text;
  v_other_company uuid;
  v_other_code text;
begin
  select p.user_id into v_actor
  from public.profiles p
  where p.is_active and p.is_super_admin and p.removed_at is null
  order by p.created_at, p.user_id
  limit 1;

  select p.user_id into v_other_admin
  from public.profiles p
  where p.is_active and p.is_super_admin and p.removed_at is null
    and p.user_id <> v_actor
  order by p.created_at, p.user_id
  limit 1;

  select c.id, c.code into v_target_company, v_target_code
  from public.companies c
  join public.company_memberships cm on cm.company_id = c.id
  where cm.user_id = v_actor and cm.is_active and c.is_active
  order by cm.is_primary desc, c.code
  limit 1;

  select c.id, c.code into v_other_company, v_other_code
  from public.companies c
  join public.company_memberships cm on cm.company_id = c.id
  where cm.user_id = v_actor and cm.is_active and c.is_active
    and c.id <> v_target_company
  order by c.code
  limit 1;

  if v_actor is null or v_other_admin is null then
    raise exception 'Two active super administrators are required for lifecycle checks';
  end if;
  if v_target_company is null or v_other_company is null then
    raise exception 'Both CK and AR memberships are required for company purge checks';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_actor::text, true);
  perform pg_catalog.set_config('app.test_actor', v_actor::text, true);
  perform pg_catalog.set_config('app.test_other_admin', v_other_admin::text, true);
  perform pg_catalog.set_config('app.test_company_id', v_target_company::text, true);
  perform pg_catalog.set_config('app.test_company_code', v_target_code, true);
  perform pg_catalog.set_config('app.other_company_id', v_other_company::text, true);
  perform pg_catalog.set_config('app.other_company_code', v_other_code, true);
end;
$select_test_context$;

savepoint account_lifecycle_checks;
set local role authenticated;

do $account_guards$
begin
  begin
    perform public.set_user_account_status(
      pg_catalog.current_setting('app.test_actor')::uuid,
      false,
      'self-deactivate',
      'self-deactivate-key'
    );
    raise exception 'A super administrator deactivated their own account';
  exception when sqlstate '23514' then null;
  end;

  begin
    perform public.remove_user_account(
      pg_catalog.current_setting('app.test_other_admin')::uuid,
      '0000',
      'wrong-pin',
      'wrong-pin-key'
    );
    raise exception 'An incorrect account-removal PIN was accepted';
  exception when sqlstate '22023' then null;
  end;
end;
$account_guards$;

select public.set_user_account_status(
  pg_catalog.current_setting('app.test_other_admin')::uuid,
  false,
  'status-off',
  'status-off-key'
);

do $verify_inactive$
begin
  if exists (
    select 1 from public.profiles
    where user_id = pg_catalog.current_setting('app.test_other_admin')::uuid
      and is_active
  ) then
    raise exception 'Account status did not become inactive';
  end if;
end;
$verify_inactive$;

select public.set_user_account_status(
  pg_catalog.current_setting('app.test_other_admin')::uuid,
  true,
  'status-on',
  'status-on-key'
);

select public.remove_user_account(
  pg_catalog.current_setting('app.test_other_admin')::uuid,
  '2113',
  'remove-account',
  'remove-account-key'
);

reset role;

do $verify_removed$
begin
  if not exists (
    select 1 from public.profiles
    where user_id = pg_catalog.current_setting('app.test_other_admin')::uuid
      and not is_active
      and removed_at is not null
  ) then
    raise exception 'Removed account was not retained as an inactive audit principal';
  end if;
  if exists (
    select 1 from public.company_memberships
    where user_id = pg_catalog.current_setting('app.test_other_admin')::uuid
  ) or exists (
    select 1 from public.admin_user_access
    where user_id = pg_catalog.current_setting('app.test_other_admin')::uuid
  ) then
    raise exception 'Removed account still has access or remains in the administration list';
  end if;
  if not exists (
    select 1 from auth.users
    where id = pg_catalog.current_setting('app.test_other_admin')::uuid
  ) then
    raise exception 'Soft account removal deleted the Supabase Auth identity';
  end if;
end;
$verify_removed$;

rollback to savepoint account_lifecycle_checks;
release savepoint account_lifecycle_checks;

set local role authenticated;
select public.erp_execute(
  'employee.upsert',
  pg_catalog.jsonb_build_object(
    'company_id', pg_catalog.current_setting('app.test_company_id')::uuid,
    'employee_no', 'EMP-PURGE-TARGET-TEST',
    'name', 'Target company purge sentinel',
    'joined_date', current_date,
    'pay_model', 'monthly',
    'monthly_rate', 1,
    'status', 'active'
  ),
  'purge-seed-target-0001'
);

select public.erp_execute(
  'employee.upsert',
  pg_catalog.jsonb_build_object(
    'company_id', pg_catalog.current_setting('app.other_company_id')::uuid,
    'employee_no', 'EMP-PURGE-OTHER-TEST',
    'name', 'Other company preservation sentinel',
    'joined_date', current_date,
    'pay_model', 'monthly',
    'monthly_rate', 1,
    'status', 'active'
  ),
  'purge-seed-other-0001'
);

do $wrong_company_confirmation$
begin
  begin
    perform public.erp_execute(
      'system.purge_business_data',
      pg_catalog.jsonb_build_object(
        'company_id', pg_catalog.current_setting('app.test_company_id')::uuid,
        'company_code', pg_catalog.current_setting('app.other_company_code'),
        'confirmation', 'DELETE ALL BUSINESS DATA',
        'acknowledge_irreversible', true
      ),
      'purge-wrong-company'
    );
    raise exception 'A mismatched company confirmation was accepted';
  exception when sqlstate '22023' then null;
  end;
end;
$wrong_company_confirmation$;

select public.erp_execute(
  'system.purge_business_data',
  pg_catalog.jsonb_build_object(
    'company_id', pg_catalog.current_setting('app.test_company_id')::uuid,
    'company_code', pg_catalog.current_setting('app.test_company_code'),
    'confirmation', 'DELETE ALL BUSINESS DATA',
    'acknowledge_irreversible', true
  ),
  'purge-valid-test-0001'
);

do $idempotent_retry$
declare
  v_result jsonb;
begin
  select public.erp_execute(
    'system.purge_business_data',
    pg_catalog.jsonb_build_object(
      'company_id', pg_catalog.current_setting('app.test_company_id')::uuid,
      'company_code', pg_catalog.current_setting('app.test_company_code'),
      'confirmation', 'DELETE ALL BUSINESS DATA',
      'acknowledge_irreversible', true
    ),
    'purge-valid-test-0001'
  ) into v_result;

  if coalesce((v_result ->> 'idempotent')::boolean, false) is not true then
    raise exception 'Purge retry did not return its idempotent receipt';
  end if;
end;
$idempotent_retry$;
reset role;

do $verify_company_purge$
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
    'company_inventory_balances', 'journal_lines', 'journal_entries',
    'employee_compensation_history', 'employees'
  ]
  loop
    execute pg_catalog.format(
      'select count(*) from public.%I where company_id = $1', v_table
    ) into v_count using pg_catalog.current_setting('app.test_company_id')::uuid;
    if v_count <> 0 then
      raise exception 'Target company table public.% still contains % row(s)', v_table, v_count;
    end if;
  end loop;

  if exists (
    select 1 from public.inventory_ownership_transfers
    where from_company_id = pg_catalog.current_setting('app.test_company_id')::uuid
       or to_company_id = pg_catalog.current_setting('app.test_company_id')::uuid
  ) then
    raise exception 'Target company ownership transfers remain after purge';
  end if;

  if not exists (
    select 1 from public.employees
    where company_id = pg_catalog.current_setting('app.other_company_id')::uuid
      and employee_no = 'EMP-PURGE-OTHER-TEST'
  ) then
    raise exception 'The purge removed data belonging to the other company';
  end if;

  if (select pg_catalog.count(*) from auth.users)
       <> (select row_count from purge_preserved_counts where relation_name = 'auth.users')
     or (select pg_catalog.count(*) from public.profiles)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.profiles')
     or (select pg_catalog.count(*) from public.user_roles)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.user_roles')
     or (select pg_catalog.count(*) from public.company_memberships)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.company_memberships')
     or (select pg_catalog.count(*) from public.company_user_roles)
       <> (select row_count from purge_preserved_counts where relation_name = 'public.company_user_roles') then
    raise exception 'Company purge changed authentication accounts or access assignments';
  end if;

  foreach v_table in array array[
    'roles', 'permissions', 'role_permissions', 'companies', 'accounts',
    'inventory_items', 'conversion_types', 'piecework_rates'
  ]
  loop
    execute pg_catalog.format('select count(*) from public.%I', v_table) into v_count;
    if v_count <> (select row_count from purge_preserved_counts where relation_name = 'public.' || v_table) then
      raise exception 'Company purge changed preserved relation public.%', v_table;
    end if;
  end loop;

  if not exists (
    select 1 from public.audit_log
    where operation = 'system.purge_business_data'
      and company_id = pg_catalog.current_setting('app.test_company_id')::uuid
  ) then
    raise exception 'Company purge audit event is missing';
  end if;
end;
$verify_company_purge$;

rollback;
