-- Every valid Supabase Auth identity may enter either company portal.
-- Opening a portal activates the caller's own ERP profile and membership and
-- supplies the least-privileged viewer role when no company role exists yet.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

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
  v_company_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_company_code, '')));
  v_email text := nullif(pg_catalog.btrim((select auth.jwt()) ->> 'email'), '');
  v_display_name text := nullif(
    pg_catalog.btrim((select auth.jwt()) -> 'user_metadata' ->> 'full_name'),
    ''
  );
  v_viewer_role_id bigint;
  v_make_primary boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
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

  select
    exists (
      select 1
      from public.company_memberships cm
      where cm.user_id = v_user_id
        and cm.company_id = v_company_id
        and cm.is_active
        and cm.is_primary
    )
    or not exists (
      select 1
      from public.company_memberships cm
      where cm.user_id = v_user_id
        and cm.is_active
        and cm.is_primary
    )
  into v_make_primary;

  insert into public.company_memberships (
    company_id,
    user_id,
    is_active,
    is_primary,
    created_by,
    updated_by
  ) values (
    v_company_id,
    v_user_id,
    true,
    v_make_primary,
    v_user_id,
    v_user_id
  )
  on conflict (company_id, user_id) do update
  set is_active = true,
      is_primary = excluded.is_primary,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = v_user_id;

  select r.id into v_viewer_role_id
  from public.roles r
  where r.code = 'viewer';

  if v_viewer_role_id is null then
    raise exception using errcode = 'P0001', message = 'The default viewer role is unavailable';
  end if;

  if not exists (
    select 1
    from public.company_user_roles cur
    where cur.company_id = v_company_id
      and cur.user_id = v_user_id
  ) then
    insert into public.company_user_roles (company_id, user_id, role_id, created_by)
    values (v_company_id, v_user_id, v_viewer_role_id, v_user_id);
  end if;

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

notify pgrst, 'reload schema';

commit;
