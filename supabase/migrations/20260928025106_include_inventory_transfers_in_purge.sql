-- Keep the group-wide purge compatible with the append-only ownership-transfer
-- records added after the company-scope dispatcher was created.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_inventory_transfer_purge;

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
begin
  if p_operation <> 'system.purge_business_data' then
    return private.perform_operation_before_inventory_transfer_purge(
      p_operation, p_payload, p_actor
    );
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_actor and p.is_active and p.is_super_admin
  ) then
    raise exception using
      errcode = '42501',
      message = 'Only the group super administrator can purge both companies';
  end if;
  if coalesce(p_payload ->> 'confirmation', '') <> 'DELETE ALL BUSINESS DATA'
     or not (p_payload @> '{"acknowledge_irreversible": true}'::jsonb) then
    raise exception using
      errcode = '22023',
      message = 'Exact purge confirmation and irreversible acknowledgement are required';
  end if;

  truncate table
    public.inventory_ownership_transfers,
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
    'ok', true,
    'operation', p_operation,
    'id', null,
    'purged_at', pg_catalog.clock_timestamp(),
    'preserved', pg_catalog.jsonb_build_array(
      'authentication accounts', 'company memberships and roles',
      'legal company definitions', 'chart of accounts',
      'fiscal period controls', 'database schema and configuration'
    )
  );
end;
$function$;

revoke all on function
  private.perform_operation_before_inventory_transfer_purge(text,jsonb,uuid),
  private.perform_operation_v2(text,jsonb,uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
