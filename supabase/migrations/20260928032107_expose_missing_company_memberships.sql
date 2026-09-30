-- Show one access-management row for every ordinary profile/company pair.
-- This lets the AR group administrator add a user who already belongs to one
-- company into the other company without sharing accounting data.

create or replace view public.admin_user_access
with (security_invoker = true)
as
select
  cm.company_id,
  p.user_id,
  p.display_name,
  p.email,
  p.is_active as profile_active,
  p.is_super_admin,
  cm.is_active as membership_active,
  cm.is_primary,
  coalesce(
    pg_catalog.array_agg(distinct r.code order by r.code)
      filter (where r.code is not null),
    array[]::text[]
  ) as role_codes
from public.profiles p
join public.company_memberships cm on cm.user_id = p.user_id
left join public.company_user_roles cur
  on cur.company_id = cm.company_id and cur.user_id = cm.user_id
left join public.roles r on r.id = cur.role_id
group by cm.company_id, p.user_id, p.display_name, p.email,
         p.is_active, p.is_super_admin, cm.is_active, cm.is_primary
union all
select
  c.id,
  p.user_id,
  p.display_name,
  p.email,
  p.is_active,
  p.is_super_admin,
  false,
  false,
  array[]::text[]
from public.profiles p
cross join public.companies c
where p.is_super_admin = false
  and c.is_active
  and not exists (
    select 1
    from public.company_memberships cm
    where cm.user_id = p.user_id
      and cm.company_id = c.id
  );

notify pgrst, 'reload schema';
