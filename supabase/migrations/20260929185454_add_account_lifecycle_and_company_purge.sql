-- Add auditable account lifecycle controls and make the destructive business
-- reset company-scoped. Authentication identities and RBAC configuration are
-- never part of the CK/AR business-data purge.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

alter table public.profiles
  add column removed_at timestamptz,
  add column removed_by uuid references auth.users(id) on delete set null,
  add constraint profiles_removal_state check (
    removed_at is not null or removed_by is null
  );

-- Removed accounts remain as inactive audit principals but disappear from the
-- administration list. This avoids breaking immutable created_by references.
drop view if exists public.admin_user_access;
create view public.admin_user_access
with (security_invoker = true)
as
select
  c.id as company_id,
  c.code as company_code,
  c.name as company_name,
  p.user_id,
  p.display_name,
  p.email,
  p.is_active as profile_active,
  p.is_super_admin,
  coalesce(cm.is_active, false) as membership_active,
  coalesce(cm.is_primary, false) as is_primary,
  coalesce((
    select pg_catalog.array_agg(distinct r.code order by r.code)
    from public.company_user_roles cur
    join public.roles r on r.id = cur.role_id
    where cur.company_id = c.id and cur.user_id = p.user_id
  ), array[]::text[]) as role_codes
from public.profiles p
cross join public.companies c
left join public.company_memberships cm
  on cm.company_id = c.id and cm.user_id = p.user_id
where c.is_active
  and p.removed_at is null;

revoke all on table public.admin_user_access from public, anon, authenticated;
grant select on table public.admin_user_access to authenticated;

create or replace function public.set_user_account_status(
  p_target_user_id uuid,
  p_is_active boolean,
  p_request_id text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_before_active boolean;
  v_target_super boolean;
  v_audit_company_id uuid;
begin
  if v_actor is null or not private.is_group_super_admin() then
    raise exception using errcode = '42501', message = 'Group super administrator permission is required';
  end if;
  if p_target_user_id is null or p_is_active is null then
    raise exception using errcode = '22023', message = 'A target account and status are required';
  end if;
  if p_target_user_id = v_actor and not p_is_active then
    raise exception using errcode = '23514', message = 'You cannot deactivate your current account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-lifecycle:' || p_target_user_id::text, 0)
  );

  select p.is_active, p.is_super_admin
  into v_before_active, v_target_super
  from public.profiles p
  where p.user_id = p_target_user_id and p.removed_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'The login account is unavailable';
  end if;

  if v_target_super and not p_is_active and not exists (
    select 1
    from public.profiles other
    where other.is_active
      and other.is_super_admin
      and other.removed_at is null
      and other.user_id <> p_target_user_id
  ) then
    raise exception using errcode = '23514', message = 'At least one other active super administrator is required';
  end if;

  update public.profiles
  set is_active = p_is_active,
      updated_at = pg_catalog.clock_timestamp()
  where user_id = p_target_user_id;

  select cm.company_id into v_audit_company_id
  from public.company_memberships cm
  where cm.user_id = v_actor and cm.is_active
  order by cm.is_primary desc, cm.company_id
  limit 1;

  insert into public.audit_log (
    actor_user_id, operation, entity_table, entity_id, action,
    before_data, after_data, idempotency_key, request_id, company_id
  ) values (
    v_actor,
    'admin.user.status',
    'profiles',
    p_target_user_id::text,
    'update',
    pg_catalog.jsonb_build_object('is_active', v_before_active),
    pg_catalog.jsonb_build_object('is_active', p_is_active),
    nullif(pg_catalog.btrim(p_idempotency_key), ''),
    nullif(pg_catalog.btrim(p_request_id), ''),
    v_audit_company_id
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', 'admin.user.status',
    'id', p_target_user_id,
    'is_active', p_is_active,
    'idempotent', v_before_active = p_is_active
  );
end;
$function$;

revoke all on function public.set_user_account_status(uuid, boolean, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.set_user_account_status(uuid, boolean, text, text)
to authenticated;

create or replace function public.remove_user_account(
  p_target_user_id uuid,
  p_confirmation_pin text,
  p_request_id text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_target_active boolean;
  v_target_super boolean;
  v_audit_company_id uuid;
begin
  if v_actor is null or not private.is_group_super_admin() then
    raise exception using errcode = '42501', message = 'Group super administrator permission is required';
  end if;
  if p_confirmation_pin is distinct from '2113' then
    raise exception using errcode = '22023', message = 'The account-removal PIN is incorrect';
  end if;
  if p_target_user_id is null then
    raise exception using errcode = '22023', message = 'A target account is required';
  end if;
  if p_target_user_id = v_actor then
    raise exception using errcode = '23514', message = 'You cannot remove your current account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-lifecycle:' || p_target_user_id::text, 0)
  );

  select p.is_active, p.is_super_admin
  into v_target_active, v_target_super
  from public.profiles p
  where p.user_id = p_target_user_id and p.removed_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'The login account is unavailable';
  end if;

  if v_target_super and not exists (
    select 1
    from public.profiles other
    where other.is_active
      and other.is_super_admin
      and other.removed_at is null
      and other.user_id <> p_target_user_id
  ) then
    raise exception using errcode = '23514', message = 'At least one other active super administrator is required';
  end if;

  select cm.company_id into v_audit_company_id
  from public.company_memberships cm
  where cm.user_id = v_actor and cm.is_active
  order by cm.is_primary desc, cm.company_id
  limit 1;

  update public.profiles
  set is_active = false,
      is_super_admin = false,
      removed_at = pg_catalog.clock_timestamp(),
      removed_by = v_actor,
      updated_at = pg_catalog.clock_timestamp()
  where user_id = p_target_user_id;

  delete from public.company_user_roles where user_id = p_target_user_id;
  delete from public.company_memberships where user_id = p_target_user_id;
  delete from public.user_roles where user_id = p_target_user_id;

  insert into public.audit_log (
    actor_user_id, operation, entity_table, entity_id, action,
    before_data, after_data, idempotency_key, request_id, company_id
  ) values (
    v_actor,
    'admin.user.remove',
    'profiles',
    p_target_user_id::text,
    'delete',
    pg_catalog.jsonb_build_object(
      'is_active', v_target_active,
      'is_super_admin', v_target_super
    ),
    pg_catalog.jsonb_build_object(
      'is_active', false,
      'access_removed', true
    ),
    nullif(pg_catalog.btrim(p_idempotency_key), ''),
    nullif(pg_catalog.btrim(p_request_id), ''),
    v_audit_company_id
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', 'admin.user.remove',
    'id', p_target_user_id,
    'idempotent', false
  );
end;
$function$;

revoke all on function public.remove_user_account(uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.remove_user_account(uuid, text, text, text)
to authenticated;

-- Append-only records may be removed only inside the explicit company purge
-- transaction and only while the caller remains an active group super admin.
create or replace function private.reject_row_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE'
     and coalesce(pg_catalog.current_setting('app.erp_company_purge', true), '') = 'enabled'
     and private.is_group_super_admin() then
    return old;
  end if;
  raise exception using
    errcode = '55000',
    message = tg_table_name || ' is append-only';
end;
$function$;

alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_company_scoped_purge;

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
    raise exception using errcode = '42501', message = 'Only a group super administrator can purge company data';
  end if;
  if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
    raise exception using errcode = '42501', message = 'ERP operation guard is not active';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Operation payload must be a JSON object';
  end if;

  v_company_id := private.current_company_id();
  select c.code into v_company_code
  from public.companies c
  where c.id = v_company_id and c.is_active;
  if v_company_code is null then
    raise exception using errcode = '22023', message = 'The selected company is unavailable';
  end if;
  if coalesce(p_payload ->> 'company_code', '') <> v_company_code then
    raise exception using errcode = '22023', message = 'The purge company confirmation does not match the selected portal';
  end if;
  if coalesce(p_payload ->> 'confirmation', '') <> 'DELETE ALL BUSINESS DATA'
     or not (p_payload @> '{"acknowledge_irreversible": true}'::jsonb) then
    raise exception using errcode = '22023', message = 'Exact purge confirmation and irreversible acknowledgement are required';
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
      updated_at = pg_catalog.clock_timestamp();

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

revoke all on function
  private.perform_operation_before_company_scoped_purge(text,jsonb,uuid),
  private.perform_operation_v2(text,jsonb,uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
