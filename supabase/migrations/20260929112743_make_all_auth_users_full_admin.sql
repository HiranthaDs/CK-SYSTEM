-- Authentication is the only user gate. Every non-deleted Auth identity gets
-- full Admin permissions in every active company. The group super-admin flag
-- remains unique to the designated owner for destructive group-level actions.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Prevent an Auth insert from running the previous inactive-user trigger while
-- this transaction replaces that trigger and reconciles existing identities.
lock table auth.users in share row exclusive mode;

do $require_admin_role$
begin
  if not exists (select 1 from public.roles r where r.code = 'admin') then
    raise exception 'The Admin role is required before enabling universal access';
  end if;
end;
$require_admin_role$;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'admin'
on conflict (role_id, permission_id) do nothing;

insert into public.profiles (user_id, display_name, email, is_active)
select
  u.id,
  pg_catalog.left(coalesce(
    nullif(pg_catalog.btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(pg_catalog.split_part(coalesce(u.email, ''), '@', 1), ''),
    ''
  ), 200),
  u.email,
  true
from auth.users u
where u.deleted_at is null
on conflict (user_id) do update
set email = excluded.email,
    is_active = true,
    updated_at = pg_catalog.clock_timestamp();

insert into public.company_memberships (
  company_id,
  user_id,
  is_active,
  is_primary,
  created_by,
  updated_by
)
select c.id, p.user_id, true, false, p.user_id, p.user_id
from public.profiles p
join auth.users u on u.id = p.user_id and u.deleted_at is null
cross join public.companies c
where p.is_active
  and c.is_active
on conflict (company_id, user_id) do update
set is_active = true,
    is_primary = company_memberships.is_primary and company_memberships.is_active,
    updated_at = pg_catalog.clock_timestamp(),
    updated_by = excluded.updated_by;

with ranked_memberships as (
  select
    cm.company_id,
    cm.user_id,
    pg_catalog.row_number() over (
      partition by cm.user_id
      order by cm.is_primary desc,
               case when c.code = 'AR' then 0 else 1 end,
               c.code
    ) as company_rank
  from public.company_memberships cm
  join public.companies c on c.id = cm.company_id
  where cm.is_active and c.is_active
)
update public.company_memberships cm
set is_primary = ranked.company_rank = 1,
    updated_at = pg_catalog.clock_timestamp(),
    updated_by = cm.user_id
from ranked_memberships ranked
where cm.company_id = ranked.company_id
  and cm.user_id = ranked.user_id
  and cm.is_primary is distinct from (ranked.company_rank = 1);

delete from public.company_user_roles cur
using public.profiles p, auth.users u
where cur.user_id = p.user_id
  and u.id = p.user_id
  and u.deleted_at is null
  and p.is_active;

insert into public.company_user_roles (company_id, user_id, role_id, created_by)
select cm.company_id, cm.user_id, r.id, cm.user_id
from public.company_memberships cm
join auth.users u on u.id = cm.user_id and u.deleted_at is null
cross join public.roles r
where cm.is_active
  and r.code = 'admin'
on conflict (company_id, user_id, role_id) do nothing;

-- Keep the legacy role table aligned for older database helpers and audits.
delete from public.user_roles ur
using public.profiles p, auth.users u
where ur.user_id = p.user_id
  and u.id = p.user_id
  and u.deleted_at is null
  and p.is_active;

insert into public.user_roles (user_id, role_id, created_by)
select p.user_id, r.id, p.user_id
from public.profiles p
join auth.users u on u.id = p.user_id and u.deleted_at is null
cross join public.roles r
where p.is_active
  and r.code = 'admin'
on conflict (user_id, role_id) do nothing;

update public.profiles
set is_super_admin = false,
    updated_at = pg_catalog.clock_timestamp()
where is_super_admin;

update public.profiles p
set is_super_admin = true,
    is_active = true,
    updated_at = pg_catalog.clock_timestamp()
from auth.users u
where u.id = p.user_id
  and u.deleted_at is null
  and pg_catalog.lower(coalesce(u.email, '')) = 'hiranthadiass4@gmail.com';

create unique index if not exists profiles_one_super_admin_idx
  on public.profiles (is_super_admin)
  where is_super_admin;

create or replace function public.ensure_current_user_company_access(
  p_company_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_company_id uuid;
  v_primary_company_id uuid;
  v_company_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_company_code, '')));
  v_email text;
  v_display_name text;
  v_admin_role_id bigint;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  select
    nullif(pg_catalog.btrim(u.email), ''),
    nullif(pg_catalog.btrim(u.raw_user_meta_data ->> 'full_name'), '')
  into v_email, v_display_name
  from auth.users u
  where u.id = v_user_id
    and u.deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'The Authentication user is unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('automatic-company-access:' || v_user_id::text, 0)
  );

  select c.id
  into v_company_id
  from public.companies c
  where c.code = v_company_code
    and c.is_active;

  if v_company_id is null then
    raise exception using errcode = '22023', message = 'The selected company portal is unavailable';
  end if;

  select r.id into v_admin_role_id
  from public.roles r
  where r.code = 'admin';
  if v_admin_role_id is null then
    raise exception using errcode = 'P0001', message = 'The Admin role is unavailable';
  end if;

  insert into public.profiles (user_id, display_name, email, is_active)
  values (
    v_user_id,
    pg_catalog.left(coalesce(v_display_name, pg_catalog.split_part(coalesce(v_email, ''), '@', 1), ''), 200),
    v_email,
    true
  )
  on conflict (user_id) do update
  set email = coalesce(excluded.email, profiles.email),
      is_active = true,
      updated_at = pg_catalog.clock_timestamp();

  select cm.company_id
  into v_primary_company_id
  from public.company_memberships cm
  join public.companies c on c.id = cm.company_id and c.is_active
  where cm.user_id = v_user_id
  order by cm.is_primary desc, cm.is_active desc,
           case when c.id = v_company_id then 0 else 1 end,
           c.code
  limit 1;
  v_primary_company_id := coalesce(v_primary_company_id, v_company_id);

  update public.company_memberships cm
  set is_primary = false,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = v_user_id
  where cm.user_id = v_user_id
    and cm.is_primary
    and cm.company_id <> v_primary_company_id;

  insert into public.company_memberships (
    company_id,
    user_id,
    is_active,
    is_primary,
    created_by,
    updated_by
  )
  select
    c.id,
    v_user_id,
    true,
    c.id = v_primary_company_id,
    v_user_id,
    v_user_id
  from public.companies c
  where c.is_active
  on conflict (company_id, user_id) do update
  set is_active = true,
      is_primary = excluded.is_primary,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = v_user_id;

  delete from public.company_user_roles cur
  using public.roles r
  where cur.user_id = v_user_id
    and r.id = cur.role_id
    and r.code <> 'admin';
  insert into public.company_user_roles (company_id, user_id, role_id, created_by)
  select cm.company_id, v_user_id, v_admin_role_id, v_user_id
  from public.company_memberships cm
  join public.companies c on c.id = cm.company_id and c.is_active
  where cm.user_id = v_user_id and cm.is_active
  on conflict (company_id, user_id, role_id) do nothing;

  delete from public.user_roles ur
  using public.roles r
  where ur.user_id = v_user_id
    and r.id = ur.role_id
    and r.code <> 'admin';
  insert into public.user_roles (user_id, role_id, created_by)
  values (v_user_id, v_admin_role_id, v_user_id)
  on conflict (user_id, role_id) do nothing;

  return pg_catalog.jsonb_build_object(
    'company_id', v_company_id,
    'company_code', v_company_code,
    'profile_active', true,
    'membership_active', true
  );
end;
$function$;

revoke all on function public.ensure_current_user_company_access(text)
from public, anon, authenticated, service_role;
grant execute on function public.ensure_current_user_company_access(text)
to authenticated;

-- The former access editor is intentionally unreachable. Authentication
-- users always receive the fixed Admin role and cannot downgrade one another.
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
  if p_operation = 'admin.user_access.set' then
    raise exception using
      errcode = '42501',
      message = 'User access management is disabled; Authentication users always have Admin access';
  end if;
  if p_operation = 'system.purge_business_data' and not exists (
    select 1 from public.profiles p
    where p.user_id = v_actor and p.is_active and p.is_super_admin
  ) then
    raise exception using errcode = '42501', message = 'Only the group super administrator can purge both companies';
  end if;

  perform pg_catalog.set_config('app.current_company_id', v_company_id::text, true);
  return private.erp_execute_before_company_scope(
    p_operation, p_payload, p_idempotency_key
  );
end;
$function$;

revoke all on function public.erp_execute(text, jsonb, text)
from public, anon, authenticated, service_role;
grant execute on function public.erp_execute(text, jsonb, text)
to authenticated;

-- New Auth users are fully provisioned immediately, so profile state can no
-- longer produce an "ERP profile is inactive" error after authentication.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_admin_role_id bigint;
begin
  select r.id into v_admin_role_id
  from public.roles r
  where r.code = 'admin';
  if v_admin_role_id is null then
    raise exception 'The Admin role is unavailable';
  end if;

  insert into public.profiles (
    user_id,
    display_name,
    email,
    is_active,
    is_super_admin
  ) values (
    new.id,
    pg_catalog.left(coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''),
      ''
    ), 200),
    new.email,
    true,
    pg_catalog.lower(coalesce(new.email, '')) = 'hiranthadiass4@gmail.com'
  )
  on conflict (user_id) do update
  set email = excluded.email,
      is_active = true,
      is_super_admin = profiles.is_super_admin or excluded.is_super_admin,
      updated_at = pg_catalog.clock_timestamp();

  insert into public.company_memberships (
    company_id,
    user_id,
    is_active,
    is_primary,
    created_by,
    updated_by
  )
  select
    ranked.id,
    new.id,
    true,
    ranked.company_rank = 1,
    new.id,
    new.id
  from (
    select
      c.id,
      pg_catalog.row_number() over (
        order by case when c.code = 'AR' then 0 else 1 end, c.code
      ) as company_rank
    from public.companies c
    where c.is_active
  ) ranked
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

drop view if exists public.admin_user_access;

notify pgrst, 'reload schema';

commit;
