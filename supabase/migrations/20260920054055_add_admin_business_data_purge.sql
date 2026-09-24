-- Add an administrator-only, transactionally atomic live-business-data purge.
--
-- The public facade is wrapped instead of copied so this migration composes
-- with every operation added by earlier migrations. Ordinary mutations share
-- an advisory transaction lock; the purge takes its exclusive counterpart so
-- no write can cross the reset boundary.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Preserve the dispatcher produced by all preceding migrations, then publish
-- the purge as a narrow wrapper around it. Calls made recursively by the old
-- dispatcher resolve through this new wrapper and continue to work unchanged.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_admin_purge;

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
begin
  if p_operation <> 'system.purge_business_data' then
    return private.perform_operation_before_admin_purge(
      p_operation,
      p_payload,
      p_actor
    );
  end if;

  if p_actor is null or p_actor <> (select auth.uid()) then
    raise exception using
      errcode = '42501',
      message = 'A valid authenticated actor is required';
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

  perform private.assert_permission('system.admin');

  if coalesce(p_payload ->> 'confirmation', '') <> 'DELETE ALL BUSINESS DATA'
     or not (p_payload @> '{"acknowledge_irreversible": true}'::jsonb) then
    raise exception using
      errcode = '22023',
      message = 'Exact purge confirmation and irreversible acknowledgement are required';
  end if;

  -- This is deliberately an explicit, closed list with no CASCADE. If a later
  -- migration adds a dependent business table, PostgreSQL will fail the purge
  -- rather than silently deleting data outside the reviewed scope.
  truncate table
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
    public.inventory_balances,
    public.journal_lines,
    public.journal_entries,
    public.employee_compensation_history,
    public.employees,
    public.piecework_rates,
    public.inventory_items,
    public.audit_log
  restart identity;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', p_operation,
    'id', null,
    'purged_at', pg_catalog.clock_timestamp(),
    'preserved', pg_catalog.jsonb_build_array(
      'authentication accounts',
      'user profiles and access roles',
      'chart of accounts',
      'database schema and configuration'
    )
  );
end;
$function$;

-- Move the previous public facade behind the private schema so callers cannot
-- bypass the advisory write barrier. The replacement keeps the exact RPC
-- signature expected by PostgREST and the FastAPI gateway.
alter function public.erp_execute(text, jsonb, text) set schema private;
alter function private.erp_execute(text, jsonb, text)
  rename to erp_execute_before_admin_purge;

create or replace function public.erp_execute(
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
  v_result jsonb;
begin
  if p_operation = 'system.purge_business_data' then
    -- Check both authorization and deliberate confirmation before waiting for
    -- the exclusive lock. The private dispatcher repeats these checks.
    perform private.assert_permission('system.admin');
    if p_payload is null
       or pg_catalog.jsonb_typeof(p_payload) <> 'object'
       or coalesce(p_payload ->> 'confirmation', '') <> 'DELETE ALL BUSINESS DATA'
       or not (p_payload @> '{"acknowledge_irreversible": true}'::jsonb) then
      raise exception using
        errcode = '22023',
        message = 'Exact purge confirmation and irreversible acknowledgement are required';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(1129003, 1);
  else
    perform pg_catalog.pg_advisory_xact_lock_shared(1129003, 1);
  end if;

  v_result := private.erp_execute_before_admin_purge(
    p_operation,
    p_payload,
    p_idempotency_key
  );

  if p_operation = 'system.purge_business_data' then
    -- Remove stale receipts for data that no longer exists, but retain the
    -- current receipt so a network retry cannot execute the purge twice.
    delete from public.idempotency_keys k
    where not (
      k.actor_user_id = v_actor
      and k.idempotency_key = p_idempotency_key
    );
  end if;

  return v_result;
end;
$function$;

revoke all on function
  private.perform_operation_before_admin_purge(text, jsonb, uuid),
  private.perform_operation_v2(text, jsonb, uuid),
  private.erp_execute_before_admin_purge(text, jsonb, text)
from public, anon, authenticated;

revoke all on function public.erp_execute(text, jsonb, text)
from public, anon, authenticated;
grant execute on function public.erp_execute(text, jsonb, text)
to authenticated;

commit;
