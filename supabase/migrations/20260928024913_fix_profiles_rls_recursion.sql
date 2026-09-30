-- Avoid recursive evaluation of profiles RLS while retaining group-admin
-- visibility for unassigned users.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create or replace function private.is_group_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
     and exists (
       select 1
       from public.profiles p
       where p.user_id = (select auth.uid())
         and p.is_active
         and p.is_super_admin
     );
$function$;

revoke all on function private.is_group_super_admin()
from public, anon, authenticated, service_role;
grant execute on function private.is_group_super_admin() to authenticated;

drop policy if exists profiles_company_admin_read on public.profiles;
create policy profiles_company_admin_read on public.profiles
for select to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.company_memberships target_membership
    where target_membership.user_id = profiles.user_id
      and private.has_company_permission(
        target_membership.company_id,
        'system.admin'
      )
  )
  or (select private.is_group_super_admin())
);

notify pgrst, 'reload schema';

commit;
