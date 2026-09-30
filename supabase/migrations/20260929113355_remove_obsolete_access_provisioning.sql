-- Auth users are provisioned by the auth.users trigger and the existing-user
-- backfill. No login-time access RPC or approval function remains.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

drop function if exists public.ensure_current_user_company_access(text);

notify pgrst, 'reload schema';

commit;
