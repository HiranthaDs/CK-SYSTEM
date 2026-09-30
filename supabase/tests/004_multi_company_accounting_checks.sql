-- Transactional verification for legal-entity isolation and double entry.
-- The final rollback removes every journal and idempotency receipt created here.
begin;

do $select_test_admin$
declare
  v_user_id uuid;
begin
  select p.user_id
  into v_user_id
  from public.profiles p
  where p.is_active
    and p.is_super_admin
    and exists (
      select 1
      from public.company_memberships cm
      where cm.user_id = p.user_id
        and cm.is_active
    )
  order by p.created_at, p.user_id
  limit 1;

  if v_user_id is null then
    raise exception 'An active group super administrator is required';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_user_id::text, true);
end;
$select_test_admin$;

set local role authenticated;

do $company_accounting_checks$
declare
  v_ck uuid := '00000000-0000-4000-8000-000000000001'::uuid;
  v_ar uuid := '00000000-0000-4000-8000-000000000002'::uuid;
  v_ck_result jsonb;
  v_ar_result jsonb;
  v_ck_journal uuid;
  v_ar_journal uuid;
  v_payload jsonb;
begin
  if not exists (
    select 1 from public.companies
    where id = v_ck and code = 'CK' and name = 'CK Plastics' and is_active
  ) or not exists (
    select 1 from public.companies
    where id = v_ar and code = 'AR' and name = 'AR Plastics' and is_active
  ) then
    raise exception 'CK Plastics and AR Plastics must both be active';
  end if;

  if not exists (
    select 1
    from public.current_user_access cua
    where cua.user_id = (select auth.uid())
      and pg_catalog.jsonb_array_length(cua.companies) = 2
  ) then
    raise exception 'The group super administrator must be assigned to both companies';
  end if;

  begin
    perform public.erp_execute(
      'admin.user_access.set',
      pg_catalog.jsonb_build_object(
        'company_id', v_ck,
        'user_id', (select auth.uid()),
        'is_active', false,
        'is_primary', false,
        'role_codes', pg_catalog.jsonb_build_array()
      ),
      'test-access-management-disabled-0001'
    );
    raise exception 'The removed user-access operation is still callable';
  exception
    when sqlstate '42501' then null;
  end;

  if (select pg_catalog.count(*) from public.company_inventory_position where company_id = v_ck)
     <> (select pg_catalog.count(*) from public.inventory_items)
     or (select pg_catalog.count(*) from public.company_inventory_position where company_id = v_ar)
     <> (select pg_catalog.count(*) from public.inventory_items) then
    raise exception 'Each company inventory view must contain the complete shared item catalogue';
  end if;

  if exists (
    select 1
    from public.company_inventory_position ck
    join public.company_inventory_position ar on ar.item_id = ck.item_id
    where ck.company_id = v_ck
      and ar.company_id = v_ar
      and ck.shared_quantity_on_hand <> ar.shared_quantity_on_hand
  ) then
    raise exception 'Shared physical availability differs between company portals';
  end if;

  if exists (
    select 1
    from public.company_inventory_stage_summary cis
    where cis.company_id in (v_ck, v_ar)
      and cis.shared_total_quantity < 0
  ) then
    raise exception 'Shared inventory summary contains an invalid negative physical balance';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'company_id', v_ck,
    'journal_date', current_date,
    'reference_no', 'TEST-CK-DOUBLE-ENTRY',
    'memo', 'Transactional CK double-entry check',
    'lines', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_code', 'CASH', 'description', 'Test debit',
        'debit', 123.45, 'credit', 0
      ),
      pg_catalog.jsonb_build_object(
        'account_code', 'OWNER_EQUITY', 'description', 'Test credit',
        'debit', 0, 'credit', 123.45
      )
    )
  );
  v_ck_result := public.erp_execute(
    'journal.post', v_payload, 'test-ck-double-entry-0001'
  );
  v_ck_journal := (v_ck_result ->> 'id')::uuid;

  v_payload := v_payload || pg_catalog.jsonb_build_object(
    'company_id', v_ar,
    'reference_no', 'TEST-AR-DOUBLE-ENTRY',
    'memo', 'Transactional AR double-entry check'
  );
  v_ar_result := public.erp_execute(
    'journal.post', v_payload, 'test-ar-double-entry-0001'
  );
  v_ar_journal := (v_ar_result ->> 'id')::uuid;

  if v_ck_journal is null or v_ar_journal is null or v_ck_journal = v_ar_journal then
    raise exception 'Company journals did not return distinct identifiers';
  end if;

  if (select company_id from public.journal_entries where id = v_ck_journal) <> v_ck
     or (select company_id from public.journal_entries where id = v_ar_journal) <> v_ar then
    raise exception 'A journal crossed its verified company boundary';
  end if;

  if exists (
    select 1
    from public.journal_entries je
    join public.journal_lines jl on jl.journal_entry_id = je.id
    where je.id in (v_ck_journal, v_ar_journal)
      and jl.company_id <> je.company_id
  ) then
    raise exception 'A journal line crossed its parent company boundary';
  end if;

  if exists (
    select 1
    from public.journal_entries je
    join public.journal_lines jl on jl.journal_entry_id = je.id
    where je.id in (v_ck_journal, v_ar_journal)
    group by je.id
    having pg_catalog.round(pg_catalog.sum(jl.debit), 2)
         <> pg_catalog.round(pg_catalog.sum(jl.credit), 2)
       or pg_catalog.count(*) < 2
  ) then
    raise exception 'A posted company journal is incomplete or unbalanced';
  end if;

  begin
    perform public.erp_execute(
      'journal.post',
      pg_catalog.jsonb_build_object(
        'company_id', v_ck,
        'journal_date', current_date,
        'memo', 'Must reject unbalanced journal',
        'lines', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'account_code', 'CASH', 'debit', 10, 'credit', 0
          ),
          pg_catalog.jsonb_build_object(
            'account_code', 'OWNER_EQUITY', 'debit', 0, 'credit', 9.99
          )
        )
      ),
      'test-reject-unbalanced-0001'
    );
    raise exception 'An unbalanced manual journal was accepted';
  exception
    when sqlstate '23514' then null;
  end;

  begin
    perform public.erp_execute(
      'journal.post',
      pg_catalog.jsonb_build_object(
        'company_id', v_ck,
        'journal_date', current_date,
        'memo', 'Must reject direct control-account posting',
        'lines', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'account_code', 'ACCOUNTS_RECEIVABLE', 'debit', 10, 'credit', 0
          ),
          pg_catalog.jsonb_build_object(
            'account_code', 'OWNER_EQUITY', 'debit', 0, 'credit', 10
          )
        )
      ),
      'test-reject-control-0001'
    );
    raise exception 'A manual control-account journal was accepted';
  exception
    when sqlstate '42501' then null;
  end;
end;
$company_accounting_checks$;

rollback;
