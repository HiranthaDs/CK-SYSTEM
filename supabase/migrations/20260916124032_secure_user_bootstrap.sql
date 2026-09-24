-- Make account provisioning fail closed even when hosted Auth signup was left
-- enabled. Existing Auth identities are bootstrapped by the foundation
-- migration; every later identity stays inactive and has no ERP role until an
-- administrator deliberately approves it.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

alter table public.profiles alter column is_active set default false;

insert into public.permissions (code, description)
values ('system.admin', 'Full system administration')
on conflict (code) do update
set description = excluded.description,
    updated_at = pg_catalog.now();

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'system.admin'
where r.code = 'admin'
on conflict (role_id, permission_id) do nothing;

-- Remove only legacy viewer grants that the old signup trigger assigned to the
-- same user. Roles deliberately assigned by a different administrator remain.
delete from public.user_roles ur
using public.roles r
where ur.role_id = r.id
  and r.code = 'viewer'
  and ur.created_by = ur.user_id
  and not exists (
    select 1
    from public.user_roles other_ur
    join public.roles other_r on other_r.id = other_ur.role_id
    where other_ur.user_id = ur.user_id
      and other_r.code <> 'viewer'
  );

update public.profiles p
set is_active = false,
    updated_at = pg_catalog.clock_timestamp()
where p.is_active
  and not exists (
    select 1 from public.user_roles ur where ur.user_id = p.user_id
  );

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (user_id, display_name, email, is_active)
  values (
    new.id,
    coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(pg_catalog.split_part(new.email, '@', 1), ''),
      ''
    ),
    new.email,
    false
  )
  on conflict (user_id) do update
  set email = excluded.email,
      updated_at = pg_catalog.now();

  return new;
end;
$function$;

revoke all on function private.handle_new_auth_user()
from public, anon, authenticated;

-- New Supabase projects can contain this event-trigger helper in public. The
-- event trigger itself continues to run as postgres; Data API roles never need
-- permission to invoke its SECURITY DEFINER function directly.
do $secure_platform_helpers$
begin
  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() '
      || 'from public, anon, authenticated, service_role';
  end if;
end;
$secure_platform_helpers$;

alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
