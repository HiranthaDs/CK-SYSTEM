-- Read-only smoke test for the bootstrapped administrator's RLS-visible API
-- contract. Run only in an environment with at least one intended Auth user.
begin;

do $require_auth_user$
declare
  v_user_id uuid;
begin
  select p.user_id into v_user_id
  from public.profiles p
  join auth.users u on u.id = p.user_id and u.deleted_at is null
  where p.is_active
    and exists (
      select 1 from public.company_memberships cm
      where cm.user_id = p.user_id and cm.is_active
    )
  order by p.created_at, p.user_id
  limit 1;

  if v_user_id is null then
    raise exception 'An active company-assigned Auth user is required for authenticated access checks';
  end if;

  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_user_id::text,
    true
  );
end;
$require_auth_user$;

set local role authenticated;

do $access_sweep$
declare
  v_name text;
  v_dashboard jsonb;
begin
  foreach v_name in array array[
    'current_user_access', 'companies',
    'company_memberships', 'company_user_roles',
    'company_inventory_balances', 'fiscal_periods',
    'inventory_ownership_transfers', 'employees', 'employee_compensation_history',
    'conversion_types', 'piecework_rates', 'inventory_items',
    'raw_material_purchases', 'conversions', 'conversion_workers',
    'daily_work', 'daily_work_piecework', 'overtime_entries',
    'payroll_overtime_claims', 'overtime_work_view', 'production_runs', 'sales',
    'sale_items', 'sale_payments', 'payrolls', 'payroll_details',
    'payroll_payments', 'stock_adjustments', 'journal_entries',
    'journal_lines', 'stock_movements', 'inventory_position',
    'inventory_stage_summary', 'production_daily_summary',
    'account_balances', 'account_balances_by_year', 'ledger_view',
    'employee_open_earnings', 'sales_outstanding', 'payroll_outstanding',
    'audit_log', 'shared_inventory_availability'
  ]
  loop
    execute pg_catalog.format('select 1 from public.%I limit 0', v_name);
  end loop;

  select public.erp_company_dashboard(
    cm.company_id,
    extract(year from current_date)::integer
  )
  into v_dashboard
  from public.company_memberships cm
  where cm.user_id = (select auth.uid()) and cm.is_active
  order by cm.is_primary desc, cm.created_at, cm.company_id
  limit 1;
  if pg_catalog.jsonb_typeof(v_dashboard) <> 'object'
     or not v_dashboard ?& array[
       'year', 'inventory', 'finance', 'workforce', 'operations', 'generated_at'
     ] then
    raise exception 'Dashboard RPC returned an incomplete contract';
  end if;
end;
$access_sweep$;

rollback;
