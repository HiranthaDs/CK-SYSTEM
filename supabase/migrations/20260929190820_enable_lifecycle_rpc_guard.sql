begin;

-- Account-lifecycle RPCs insert their own append-only audit records. They do
-- not pass through erp_execute, so admit only these two tightly checked audit
-- inserts when the authenticated actor is still an active group super admin
-- and the row uses the verified company context. All other tables and audit
-- operations continue to require erp_execute's transaction guard.
create or replace function private.require_rpc_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') = 'enabled' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_schema = 'public'
     and tg_table_name = 'audit_log'
     and tg_op = 'INSERT'
     and new.operation in ('admin.user.status', 'admin.user.remove')
     and new.actor_user_id = (select auth.uid())
     and new.company_id = private.current_company_id()
     and private.is_group_super_admin() then
    return new;
  end if;

  raise exception using
    errcode = '42501',
    message = 'Direct ERP table mutation is disabled; use erp_execute';
end;
$function$;

commit;
