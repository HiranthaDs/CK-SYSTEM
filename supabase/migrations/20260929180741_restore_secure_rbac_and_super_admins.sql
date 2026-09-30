-- Restore explicit, least-privilege company access after the temporary
-- universal-admin migrations. Authentication proves identity; this schema
-- remains authoritative for company and capability authorization.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

lock table auth.users in share row exclusive mode;

-- Repair a legacy UUID lookup that incorrectly called pg_catalog.min(uuid).
-- PostgreSQL does not provide that aggregate for UUIDs; choosing the first
-- ordered UUID preserves the original duplicate-detection behaviour.
do $repair_operation_function$
declare
  v_definition text;
  v_repaired_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'private.perform_operation_v2_before_employee_profiles(text,jsonb,uuid)'::regprocedure
  ) into v_definition;

  v_repaired_definition := pg_catalog.replace(
    v_definition,
    'pg_catalog.min(i.id)',
    '(pg_catalog.array_agg(i.id order by i.id))[1]'
  );

  if v_repaired_definition = v_definition then
    raise exception 'Could not locate the legacy UUID min expression';
  end if;

  execute v_repaired_definition;
end;
$repair_operation_function$;

drop index if exists public.profiles_one_super_admin_idx;

-- The old global policy could expose compensation history from a company the
-- caller was not assigned to. The company-scoped erp_read policy replaces it.
drop policy if exists employee_compensation_history_read
on public.employee_compensation_history;

-- The two owner-approved identities are group super administrators. Passwords
-- deliberately remain exclusively in Supabase Auth and never enter SQL.
update public.profiles p
set is_super_admin = pg_catalog.lower(coalesce(u.email, '')) in (
      'hiranthadiass4@gmail.com',
      'asela78@gmail.com'
    ),
    is_active = case
      when pg_catalog.lower(coalesce(u.email, '')) in (
        'hiranthadiass4@gmail.com',
        'asela78@gmail.com'
      ) then true
      else false
    end,
    updated_at = pg_catalog.clock_timestamp()
from auth.users u
where u.id = p.user_id
  and u.deleted_at is null;

-- Universal Admin assignments cannot be distinguished from legitimate grants,
-- so ordinary users return to pending. A super administrator must explicitly
-- provision their company scope and capability roles.
delete from public.company_user_roles cur
using public.profiles p
where p.user_id = cur.user_id
  and not p.is_super_admin;

delete from public.company_memberships cm
using public.profiles p
where p.user_id = cm.user_id
  and not p.is_super_admin;

delete from public.user_roles ur
using public.profiles p
where p.user_id = ur.user_id
  and not p.is_super_admin;

update public.company_memberships cm
set is_primary = false,
    updated_at = pg_catalog.clock_timestamp(),
    updated_by = cm.user_id
from public.profiles p
where p.user_id = cm.user_id
  and p.is_super_admin
  and cm.is_primary;

insert into public.company_memberships (
  company_id, user_id, is_active, is_primary, created_by, updated_by
)
select
  c.id,
  p.user_id,
  true,
  c.code = 'CK',
  p.user_id,
  p.user_id
from public.profiles p
cross join public.companies c
where p.is_super_admin and c.is_active
on conflict (company_id, user_id) do update
set is_active = true,
    is_primary = excluded.is_primary,
    updated_at = pg_catalog.clock_timestamp(),
    updated_by = excluded.updated_by;

delete from public.company_user_roles cur
using public.profiles p
where p.user_id = cur.user_id and p.is_super_admin;

insert into public.company_user_roles (company_id, user_id, role_id, created_by)
select cm.company_id, cm.user_id, r.id, cm.user_id
from public.company_memberships cm
join public.profiles p on p.user_id = cm.user_id and p.is_super_admin
cross join public.roles r
where cm.is_active and r.code = 'admin'
on conflict (company_id, user_id, role_id) do nothing;

delete from public.user_roles ur
using public.profiles p
where p.user_id = ur.user_id and p.is_super_admin;

insert into public.user_roles (user_id, role_id, created_by)
select p.user_id, r.id, p.user_id
from public.profiles p
cross join public.roles r
where p.is_super_admin and r.code = 'admin'
on conflict (user_id, role_id) do nothing;

-- New Auth identities are pending unless they are one of the designated owner
-- accounts. The backend provisions ordinary users only after Auth creation has
-- succeeded, preventing signup from becoming an authorization path.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_is_owner boolean := pg_catalog.lower(coalesce(new.email, '')) in (
    'hiranthadiass4@gmail.com',
    'asela78@gmail.com'
  );
  v_admin_role_id bigint;
begin
  insert into public.profiles (
    user_id, display_name, email, is_active, is_super_admin
  ) values (
    new.id,
    pg_catalog.left(coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''),
      ''
    ), 200),
    new.email,
    v_is_owner,
    v_is_owner
  )
  on conflict (user_id) do update
  set email = excluded.email,
      is_active = profiles.is_active or excluded.is_active,
      is_super_admin = profiles.is_super_admin or excluded.is_super_admin,
      updated_at = pg_catalog.clock_timestamp();

  if not v_is_owner then
    return new;
  end if;

  select r.id into v_admin_role_id from public.roles r where r.code = 'admin';
  if v_admin_role_id is null then
    raise exception 'The Admin role is unavailable';
  end if;

  insert into public.company_memberships (
    company_id, user_id, is_active, is_primary, created_by, updated_by
  )
  select c.id, new.id, true, c.code = 'CK', new.id, new.id
  from public.companies c
  where c.is_active
  on conflict (company_id, user_id) do update
  set is_active = true,
      is_primary = excluded.is_primary,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = new.id;

  insert into public.company_user_roles (company_id, user_id, role_id, created_by)
  select cm.company_id, new.id, v_admin_role_id, new.id
  from public.company_memberships cm
  where cm.user_id = new.id and cm.is_active
  on conflict (company_id, user_id, role_id) do nothing;

  insert into public.user_roles (user_id, role_id, created_by)
  values (new.id, v_admin_role_id, new.id)
  on conflict (user_id, role_id) do nothing;

  return new;
end;
$function$;

revoke all on function private.handle_new_auth_user()
from public, anon, authenticated, service_role;

-- One row per profile/company lets the administration UI show both assigned
-- and unassigned portals without weakening the underlying table RLS.
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
where c.is_active;

revoke all on table public.admin_user_access from public, anon, authenticated;
grant select on table public.admin_user_access to authenticated;

-- Atomically assigns a created Auth identity to CK, AR, or both. Only a group
-- super administrator may call this function; user-supplied metadata/JWT claims
-- are never used for authorization.
create or replace function public.provision_user_access(
  p_target_user_id uuid,
  p_display_name text,
  p_company_codes text[],
  p_role_codes text[],
  p_is_super_admin boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_company_codes text[];
  v_role_codes text[];
  v_effective_role_codes text[];
begin
  if v_actor is null or not private.is_group_super_admin() then
    raise exception using errcode = '42501', message = 'Group super administrator permission is required';
  end if;
  if p_target_user_id is null then
    raise exception using errcode = '22023', message = 'A target user is required';
  end if;

  select coalesce(pg_catalog.array_agg(distinct pg_catalog.upper(pg_catalog.btrim(x)) order by pg_catalog.upper(pg_catalog.btrim(x))), array[]::text[])
  into v_company_codes
  from pg_catalog.unnest(coalesce(p_company_codes, array[]::text[])) x
  where pg_catalog.btrim(x) <> '';

  select coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(pg_catalog.btrim(x)) order by pg_catalog.lower(pg_catalog.btrim(x))), array[]::text[])
  into v_role_codes
  from pg_catalog.unnest(coalesce(p_role_codes, array[]::text[])) x
  where pg_catalog.btrim(x) <> '';

  if p_is_super_admin then
    v_company_codes := array['AR', 'CK']::text[];
    v_effective_role_codes := array['admin']::text[];
  else
    v_effective_role_codes := v_role_codes;
  end if;

  if pg_catalog.cardinality(v_company_codes) < 1
     or pg_catalog.cardinality(v_company_codes) > 2
     or exists (
       select 1 from pg_catalog.unnest(v_company_codes) x
       where x not in ('CK', 'AR')
     ) then
    raise exception using errcode = '22023', message = 'Company access must be CK, AR, or both';
  end if;
  if pg_catalog.cardinality(v_effective_role_codes) < 1
     or pg_catalog.cardinality(v_effective_role_codes) > 5
     or exists (
       select 1
       from pg_catalog.unnest(v_effective_role_codes) x
       left join public.roles r on r.code = x
       where r.id is null
     ) then
    raise exception using errcode = '22023', message = 'One or more access roles are invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user-provision:' || p_target_user_id::text, 0)
  );
  perform 1 from public.profiles p where p.user_id = p_target_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'The Authentication profile is unavailable';
  end if;

  if p_target_user_id = v_actor and not p_is_super_admin then
    raise exception using errcode = '23514', message = 'A super administrator cannot remove their own group access';
  end if;

  update public.profiles
  set display_name = pg_catalog.left(coalesce(nullif(pg_catalog.btrim(p_display_name), ''), display_name), 200),
      is_active = true,
      is_super_admin = p_is_super_admin,
      updated_at = pg_catalog.clock_timestamp()
  where user_id = p_target_user_id;

  delete from public.company_user_roles where user_id = p_target_user_id;
  delete from public.company_memberships where user_id = p_target_user_id;

  insert into public.company_memberships (
    company_id, user_id, is_active, is_primary, created_by, updated_by
  )
  select
    c.id,
    p_target_user_id,
    true,
    c.code = v_company_codes[1],
    v_actor,
    v_actor
  from public.companies c
  where c.is_active and c.code = any(v_company_codes);

  insert into public.company_user_roles (company_id, user_id, role_id, created_by)
  select cm.company_id, p_target_user_id, r.id, v_actor
  from public.company_memberships cm
  cross join public.roles r
  where cm.user_id = p_target_user_id
    and cm.is_active
    and r.code = any(v_effective_role_codes);

  delete from public.user_roles where user_id = p_target_user_id;
  insert into public.user_roles (user_id, role_id, created_by)
  select p_target_user_id, r.id, v_actor
  from public.roles r
  where r.code = any(v_effective_role_codes);

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', 'admin.user.provision',
    'id', p_target_user_id,
    'company_codes', v_company_codes,
    'role_codes', v_effective_role_codes,
    'is_super_admin', p_is_super_admin,
    'idempotent', false
  );
end;
$function$;

revoke all on function public.provision_user_access(uuid, text, text[], text[], boolean)
from public, anon, authenticated, service_role;
grant execute on function public.provision_user_access(uuid, text, text[], text[], boolean)
to authenticated;

-- Re-enable the existing company-scoped access editor while retaining the
-- verified company boundary and super-admin-only group purge.
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
  v_company_id uuid;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Payload must be a JSON object';
  end if;
  begin
    v_company_id := nullif(p_payload ->> 'company_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'A valid company_id is required';
  end;
  if v_company_id is null or not private.can_access_company(v_company_id) then
    raise exception using errcode = '42501', message = 'The selected company is unavailable';
  end if;
  if p_operation = 'system.purge_business_data' and not private.is_group_super_admin() then
    raise exception using errcode = '42501', message = 'Only a group super administrator can purge both companies';
  end if;

  perform pg_catalog.set_config('app.current_company_id', v_company_id::text, true);
  return private.erp_execute_before_company_scope(
    p_operation, p_payload, p_idempotency_key
  );
end;
$function$;

revoke all on function public.erp_execute(text, jsonb, text)
from public, anon, authenticated, service_role;
grant execute on function public.erp_execute(text, jsonb, text) to authenticated;

notify pgrst, 'reload schema';

commit;
