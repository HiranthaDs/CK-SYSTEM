-- The hosted PostgREST role loads pg-safeupdate, which rejects UPDATE
-- statements without an explicit predicate. The company purge reconciles
-- every shared physical-inventory row after removing one company's balances,
-- so retain that behavior while expressing its full-table scope explicitly.
-- Authentication identities, profiles, memberships, and role assignments are
-- deliberately absent from this function's deletion list.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

create or replace function private.perform_operation_v2(
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
  v_company_id uuid;
  v_company_code text;
begin
  if p_operation <> 'system.purge_business_data' then
    return private.perform_operation_before_company_scoped_purge(
      p_operation, p_payload, p_actor
    );
  end if;

  if p_actor is null or p_actor <> (select auth.uid())
     or not private.is_group_super_admin() then
    raise exception using
      errcode = '42501',
      message = 'Only a group super administrator can purge company data';
  end if;
  if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
    raise exception using
      errcode = '42501',
      message = 'ERP operation guard is not active';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Operation payload must be a JSON object';
  end if;

  v_company_id := private.current_company_id();
  select c.code into v_company_code
  from public.companies c
  where c.id = v_company_id and c.is_active;
  if v_company_code is null then
    raise exception using
      errcode = '22023',
      message = 'The selected company is unavailable';
  end if;
  if coalesce(p_payload ->> 'company_code', '') <> v_company_code then
    raise exception using
      errcode = '22023',
      message = 'The purge company confirmation does not match the selected portal';
  end if;
  if coalesce(p_payload ->> 'confirmation', '') <> 'DELETE ALL BUSINESS DATA'
     or not (p_payload @> '{"acknowledge_irreversible": true}'::jsonb) then
    raise exception using
      errcode = '22023',
      message = 'Exact purge confirmation and irreversible acknowledgement are required';
  end if;

  -- Both companies share physical stock totals, so serialize every company
  -- purge before recalculating those totals from the surviving ownership rows.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('company-business-purge', 0)
  );
  perform pg_catalog.set_config('app.erp_company_purge', 'enabled', true);

  delete from public.payroll_overtime_claims where company_id = v_company_id;
  delete from public.payroll_details where company_id = v_company_id;
  delete from public.payroll_payments where company_id = v_company_id;
  delete from public.payrolls where company_id = v_company_id;

  delete from public.sale_items where company_id = v_company_id;
  delete from public.sale_payments where company_id = v_company_id;
  delete from public.sales where company_id = v_company_id;

  delete from public.daily_work_conversion_links where company_id = v_company_id;
  delete from public.daily_work_piecework where company_id = v_company_id;
  delete from public.conversion_workers where company_id = v_company_id;
  delete from public.daily_work where company_id = v_company_id;
  delete from public.overtime_entries where company_id = v_company_id;

  delete from public.production_runs where company_id = v_company_id;
  delete from public.conversions where company_id = v_company_id;
  delete from public.raw_material_purchases where company_id = v_company_id;
  delete from public.stock_adjustments where company_id = v_company_id;
  delete from public.stock_movements where company_id = v_company_id;

  delete from public.inventory_ownership_transfers
  where from_company_id = v_company_id or to_company_id = v_company_id;

  delete from public.employee_compensation_history where company_id = v_company_id;
  delete from public.employees where company_id = v_company_id;

  delete from public.journal_lines where company_id = v_company_id;
  delete from public.journal_entries where company_id = v_company_id;
  delete from public.company_inventory_balances where company_id = v_company_id;

  update public.inventory_balances b
  set quantity_on_hand = coalesce((
        select pg_catalog.sum(cb.quantity_on_hand)
        from public.company_inventory_balances cb
        where cb.item_id = b.item_id
      ), 0),
      inventory_value = coalesce((
        select pg_catalog.sum(cb.inventory_value)
        from public.company_inventory_balances cb
        where cb.item_id = b.item_id
      ), 0),
      last_movement_at = (
        select pg_catalog.max(cb.last_movement_at)
        from public.company_inventory_balances cb
        where cb.item_id = b.item_id
      ),
      updated_at = pg_catalog.clock_timestamp()
  -- item_id is the non-null primary key. This predicate intentionally selects
  -- every balance row and satisfies pg-safeupdate on Data API connections.
  where b.item_id is not null;

  delete from public.audit_log where company_id = v_company_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', p_operation,
    'id', v_company_id,
    'company_code', v_company_code,
    'purged_at', pg_catalog.clock_timestamp(),
    'preserved', pg_catalog.jsonb_build_array(
      'all authentication accounts and user profiles',
      'company memberships and capability roles',
      'the other company and all of its business records',
      'shared inventory item definitions and setup rates',
      'legal company definitions and chart of accounts',
      'fiscal period controls, database schema, and configuration'
    )
  );
end;
$function$;

revoke all on function private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
