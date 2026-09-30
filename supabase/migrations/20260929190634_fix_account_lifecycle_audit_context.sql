-- Account lifecycle RPCs write company-scoped audit rows directly, so establish
-- the same transaction-local verified company context used by erp_execute.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '30s';

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

  select cm.company_id into v_audit_company_id
  from public.company_memberships cm
  where cm.user_id = v_actor and cm.is_active
  order by cm.is_primary desc, cm.company_id
  limit 1;
  if v_audit_company_id is null then
    raise exception using errcode = '42501', message = 'An active company membership is required';
  end if;

  perform pg_catalog.set_config('app.current_company_id', v_audit_company_id::text, true);

  update public.profiles
  set is_active = p_is_active,
      updated_at = pg_catalog.clock_timestamp()
  where user_id = p_target_user_id;

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
  if v_audit_company_id is null then
    raise exception using errcode = '42501', message = 'An active company membership is required';
  end if;

  perform pg_catalog.set_config('app.current_company_id', v_audit_company_id::text, true);

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

notify pgrst, 'reload schema';

commit;
