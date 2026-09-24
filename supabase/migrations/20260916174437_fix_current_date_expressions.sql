-- PostgreSQL date/time keywords such as CURRENT_DATE cannot be schema
-- qualified. Repair the three already-deployed functions while the foundation
-- migrations retain the corrected definitions for clean installations.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $repair_current_date$
declare
  v_function record;
begin
  for v_function in
    select p.oid, pg_catalog.pg_get_functiondef(p.oid) as definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.prosrc like '%pg_catalog.current_date%'
      and (
        (n.nspname = 'public' and p.proname = 'erp_dashboard')
        or (
          n.nspname = 'private'
          and p.proname in ('perform_operation_v2', 'reverse_journal')
        )
      )
  loop
    execute pg_catalog.replace(
      v_function.definition,
      'pg_catalog.current_date',
      'current_date'
    );
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosrc like '%pg_catalog.current_date%'
  ) then
    raise exception 'One or more ERP functions still schema-qualify CURRENT_DATE';
  end if;
end;
$repair_current_date$;

notify pgrst, 'reload schema';

commit;
