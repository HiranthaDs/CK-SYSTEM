-- Remove the legacy approval gate for identities already saved in Supabase
-- Authentication. Every current identity receives an active membership in
-- every active company and at least the Viewer role.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

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
select
  c.id,
  p.user_id,
  true,
  false,
  p.user_id,
  p.user_id
from public.profiles p
cross join public.companies c
where p.is_active
  and c.is_active
on conflict (company_id, user_id) do update
set is_active = true,
    updated_at = pg_catalog.clock_timestamp(),
    updated_by = excluded.updated_by;

with primary_company as (
  select c.id
  from public.companies c
  where c.is_active
  order by case when c.code = 'AR' then 0 else 1 end, c.code
  limit 1
), users_without_primary as (
  select p.user_id
  from public.profiles p
  where p.is_active
    and not exists (
      select 1
      from public.company_memberships cm
      where cm.user_id = p.user_id
        and cm.is_active
        and cm.is_primary
    )
)
update public.company_memberships cm
set is_primary = true,
    updated_at = pg_catalog.clock_timestamp(),
    updated_by = cm.user_id
from primary_company pc
join users_without_primary up on true
where cm.company_id = pc.id
  and cm.user_id = up.user_id
  and cm.is_active;

insert into public.company_user_roles (company_id, user_id, role_id, created_by)
select cm.company_id, cm.user_id, r.id, cm.user_id
from public.company_memberships cm
cross join public.roles r
where cm.is_active
  and r.code = 'viewer'
  and not exists (
    select 1
    from public.company_user_roles cur
    where cur.company_id = cm.company_id
      and cur.user_id = cm.user_id
  )
on conflict (company_id, user_id, role_id) do nothing;

notify pgrst, 'reload schema';

commit;
