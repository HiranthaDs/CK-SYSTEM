-- Complete the company danger-zone contract and retain human-readable actor
-- identity snapshots on every new immutable audit event.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

alter table public.audit_log
  add column actor_display_name text,
  add column actor_email text;

-- Populate historical events once during this controlled migration. The
-- rewrite and company-context triggers are restored in the same transaction,
-- including on error. The backfill spans every company, so no single request
-- company can be used for this migration-only update.
alter table public.audit_log disable trigger audit_log_append_only;
alter table public.audit_log disable trigger audit_log_company_context;
update public.audit_log a
set actor_display_name = p.display_name,
    actor_email = p.email
from public.profiles p
where p.user_id = a.actor_user_id
  and a.id is not null;
alter table public.audit_log enable trigger audit_log_company_context;
alter table public.audit_log enable trigger audit_log_append_only;

create function private.snapshot_audit_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Always derive the snapshot from the protected profile. Callers cannot
  -- supply a different name or email for an audit row.
  select p.display_name, p.email
  into new.actor_display_name, new.actor_email
  from public.profiles p
  where p.user_id = new.actor_user_id;

  return new;
end;
$function$;

revoke all on function private.snapshot_audit_actor()
from public, anon, authenticated, service_role;

create trigger audit_log_snapshot_actor
before insert on public.audit_log
for each row execute function private.snapshot_audit_actor();

create index if not exists audit_log_company_actor_time_idx
  on public.audit_log (company_id, actor_display_name, occurred_at desc, id desc);
create index if not exists audit_log_company_action_time_idx
  on public.audit_log (company_id, action, occurred_at desc, id desc);
create index if not exists audit_log_company_entity_time_idx
  on public.audit_log (company_id, entity_table, occurred_at desc, id desc);

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

  -- Both companies share physical stock and conversion-rate setup. Serialize
  -- the reset before rebuilding shared stock from the surviving ownership rows.
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

  -- Rates are shared setup, so this intentionally clears every saved rate.
  -- Historical worker amounts remain on the other company; their nullable
  -- rate_id foreign keys are detached by ON DELETE SET NULL.
  delete from public.piecework_rates where id is not null;

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
  where b.item_id is not null;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', p_operation,
    'id', v_company_id,
    'company_code', v_company_code,
    'purged_at', pg_catalog.clock_timestamp(),
    'deleted', pg_catalog.jsonb_build_array(
      v_company_code || ' inventory position and stock history',
      v_company_code || ' production and conversion data',
      v_company_code || ' sales, receipts, and receivables data',
      'all shared conversion rates'
    ),
    'preserved', pg_catalog.jsonb_build_array(
      'all authentication accounts and user profiles',
      'company memberships and capability roles',
      'the complete activity and audit history plus the purge receipt',
      'the other company and all of its business records',
      'shared inventory item definitions and conversion types',
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
