-- Auditable overtime work records and atomic payroll claiming.
-- OT is operational until payroll is posted; payroll creates the accounting
-- expense/payable entry and claims each OT record exactly once.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

create table if not exists public.overtime_entries (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  employee_id uuid not null references public.employees(id) on delete restrict,
  work_date date not null,
  hours numeric(8,2) not null,
  rate numeric(20,2) not null,
  amount numeric(20,2) generated always as (round(hours * rate, 2)) stored,
  notes text,
  revision integer not null default 1,
  status text not null default 'posted',
  replaces_id uuid references public.overtime_entries(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint overtime_reference_not_blank check (btrim(reference_no) <> ''),
  constraint overtime_hours_valid check (hours > 0 and hours <= 24),
  constraint overtime_rate_positive check (rate > 0),
  constraint overtime_revision_positive check (revision > 0),
  constraint overtime_status_valid check (status in ('posted', 'reversed')),
  constraint overtime_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null) or
    (status = 'reversed' and reversed_at is not null and reversed_by is not null)
  )
);

create index if not exists overtime_entries_employee_date_idx
  on public.overtime_entries (employee_id, work_date desc, id desc);
create index if not exists overtime_entries_status_date_idx
  on public.overtime_entries (status, work_date desc);
create index if not exists overtime_entries_replaces_id_idx
  on public.overtime_entries (replaces_id);

create table if not exists public.payroll_overtime_claims (
  id uuid primary key default gen_random_uuid(),
  payroll_id uuid not null references public.payrolls(id) on delete restrict,
  overtime_id uuid not null references public.overtime_entries(id) on delete restrict,
  payroll_reference_no text not null,
  is_active boolean not null default true,
  claimed_at timestamptz not null default now(),
  released_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  released_by uuid references auth.users(id) on delete restrict,
  constraint payroll_overtime_claim_release_state check (
    (is_active and released_at is null and released_by is null) or
    (not is_active and released_at is not null and released_by is not null)
  )
);

create unique index if not exists payroll_overtime_claims_active_ot_idx
  on public.payroll_overtime_claims (overtime_id) where is_active;
create index if not exists payroll_overtime_claims_overtime_idx
  on public.payroll_overtime_claims (overtime_id);
create index if not exists payroll_overtime_claims_payroll_idx
  on public.payroll_overtime_claims (payroll_id, is_active);

create trigger overtime_entries_rpc_guard
before insert or update or delete on public.overtime_entries
for each row execute function private.require_rpc_guard();

create trigger payroll_overtime_claims_rpc_guard
before insert or update or delete on public.payroll_overtime_claims
for each row execute function private.require_rpc_guard();

alter table public.overtime_entries enable row level security;
alter table public.payroll_overtime_claims enable row level security;

revoke all on table public.overtime_entries, public.payroll_overtime_claims from anon, authenticated;
grant select on table public.overtime_entries, public.payroll_overtime_claims to authenticated;

drop policy if exists erp_read on public.overtime_entries;
create policy erp_read on public.overtime_entries
for select to authenticated
using ((select private.has_any_permission(
  array['employees.read', 'payroll.read', 'reports.read']::text[]
)));

drop policy if exists erp_read on public.payroll_overtime_claims;
create policy erp_read on public.payroll_overtime_claims
for select to authenticated
using ((select private.has_any_permission(
  array['employees.read', 'payroll.read', 'reports.read', 'finance.read']::text[]
)));

create or replace view public.overtime_work_view
with (security_invoker = true)
as
select
  ot.id,
  ot.reference_no,
  ot.employee_id,
  e.employee_no,
  e.name as employee_name,
  ot.work_date,
  ot.hours,
  ot.rate,
  ot.amount,
  ot.notes,
  ot.revision,
  ot.status,
  ot.replaces_id,
  ot.created_at,
  ot.updated_at,
  c.payroll_id as claimed_payroll_id,
  c.payroll_reference_no as claimed_payroll_reference
from public.overtime_entries ot
join public.employees e on e.id = ot.employee_id
left join lateral (
  select poc.payroll_id, poc.payroll_reference_no
  from public.payroll_overtime_claims poc
  where poc.overtime_id = ot.id and poc.is_active
  order by poc.claimed_at desc, poc.id desc
  limit 1
) c on true;

revoke all on table public.overtime_work_view from anon, authenticated;
grant select on table public.overtime_work_view to authenticated;

-- Preserve the reviewed dispatcher and layer OT + payroll-claim behavior over it.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_overtime;

create function private.perform_operation_v2(
  p_operation text,
  p_payload jsonb,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_payload jsonb := p_payload;
  v_result jsonb;
  v_id uuid;
  v_target_id uuid;
  v_reference text;
  v_reason text;
  v_old public.overtime_entries%rowtype;
  v_hours numeric(8,2);
  v_rate numeric(20,2);
  v_date date;
  v_revision integer := 1;
  v_replaces_id uuid;
  v_salary_month text;
  v_month_start date;
  v_month_end date;
  v_input jsonb;
  v_ot_ids uuid[] := array[]::uuid[];
  v_ot_earnings jsonb := '[]'::jsonb;
  v_count integer;
  v_payroll public.payrolls%rowtype;
begin
  -- The admin purge uses an explicit closed TRUNCATE list. Because OT adds
  -- foreign keys to employees and payrolls, both OT tables must be included in
  -- the same TRUNCATE statement (pre-truncating them separately is not enough
  -- for PostgreSQL's FK safety check).
  if p_operation = 'system.purge_business_data' then
    if p_actor is null or p_actor <> (select auth.uid()) then
      raise exception using errcode = '42501', message = 'A valid authenticated actor is required';
    end if;
    if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
      raise exception using errcode = '42501', message = 'ERP operation guard is not active';
    end if;
    if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
      raise exception using errcode = '22023', message = 'Operation payload must be a JSON object';
    end if;
    perform private.assert_permission('system.admin');
    if coalesce(p_payload ->> 'confirmation', '') <> 'DELETE ALL BUSINESS DATA'
       or not (p_payload @> '{"acknowledge_irreversible": true}'::jsonb) then
      raise exception using
        errcode = '22023',
        message = 'Exact purge confirmation and irreversible acknowledgement are required';
    end if;

    truncate table
      public.payroll_overtime_claims,
      public.overtime_entries,
      public.payroll_details,
      public.payroll_payments,
      public.payrolls,
      public.sale_items,
      public.sale_payments,
      public.sales,
      public.daily_work_conversion_links,
      public.daily_work_piecework,
      public.daily_work,
      public.conversion_workers,
      public.conversions,
      public.production_runs,
      public.raw_material_purchases,
      public.stock_adjustments,
      public.stock_movements,
      public.inventory_balances,
      public.journal_lines,
      public.journal_entries,
      public.employee_compensation_history,
      public.employees,
      public.piecework_rates,
      public.conversion_types,
      public.inventory_items,
      public.audit_log
    restart identity;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'operation', p_operation,
      'id', null,
      'purged_at', pg_catalog.clock_timestamp(),
      'preserved', pg_catalog.jsonb_build_array(
        'authentication accounts',
        'user profiles and access roles',
        'chart of accounts',
        'database schema and configuration'
      )
    );
  end if;

  if p_operation not in (
    'overtime.upsert', 'overtime.reverse',
    'payroll.post', 'payroll.replace', 'payroll.reverse'
  ) then
    return private.perform_operation_before_overtime(p_operation, p_payload, p_actor);
  end if;

  if p_actor is null or p_actor <> (select auth.uid()) then
    raise exception using errcode = '42501', message = 'A valid authenticated actor is required';
  end if;
  if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
    raise exception using errcode = '42501', message = 'ERP operation guard is not active';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Operation payload must be a JSON object';
  end if;

  if p_operation = 'overtime.upsert' then
    perform private.assert_permission('employees.write');

    if nullif(v_payload ->> 'id', '') is not null then
      v_id := (v_payload ->> 'id')::uuid;
      select * into v_old from public.overtime_entries where id = v_id for update;
      if not found then
        raise exception using errcode = 'P0001', message = 'Overtime record not found';
      end if;
      if v_old.status <> 'posted' then
        raise exception using errcode = 'P0001', message = 'Reversed overtime cannot be edited';
      end if;
      if exists (
        select 1 from public.payroll_overtime_claims c
        where c.overtime_id = v_old.id and c.is_active
      ) then
        raise exception using errcode = 'P0001', message = 'Claimed overtime cannot be edited';
      end if;

      update public.overtime_entries
      set status = 'reversed',
          reversed_at = pg_catalog.clock_timestamp(),
          reversed_by = p_actor,
          reversal_reason = 'Replaced by corrected overtime',
          updated_at = pg_catalog.clock_timestamp(),
          updated_by = p_actor
      where id = v_old.id;

      v_replaces_id := v_old.id;
      v_revision := v_old.revision + 1;
      v_payload := v_payload - 'id';
    end if;

    v_target_id := (v_payload ->> 'employee_id')::uuid;
    perform 1 from public.employees e where e.id = v_target_id and e.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active employee not found';
    end if;

    v_date := (v_payload ->> 'work_date')::date;
    v_hours := pg_catalog.round((v_payload ->> 'hours')::numeric, 2);
    v_rate := pg_catalog.round((v_payload ->> 'rate')::numeric, 2);
    if v_hours <= 0 or v_hours > 24 then
      raise exception using errcode = '22023', message = 'OT hours must be greater than 0 and no more than 24';
    end if;
    if v_rate <= 0 then
      raise exception using errcode = '22023', message = 'OT rate must be greater than 0';
    end if;

    v_id := pg_catalog.gen_random_uuid();
    v_reference := private.new_reference('OT');
    insert into public.overtime_entries (
      id, reference_no, employee_id, work_date, hours, rate, notes,
      revision, replaces_id, created_by, updated_by
    ) values (
      v_id, v_reference, v_target_id, v_date, v_hours, v_rate,
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'notes'), 1000), ''),
      v_revision, v_replaces_id, p_actor, p_actor
    );

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'overtime.reverse' then
    perform private.assert_permission('employees.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_old from public.overtime_entries where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Overtime record not found';
    end if;
    if v_old.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Overtime is already reversed';
    end if;
    if exists (
      select 1 from public.payroll_overtime_claims c
      where c.overtime_id = v_id and c.is_active
    ) then
      raise exception using errcode = 'P0001', message = 'Claimed overtime cannot be reversed';
    end if;
    v_reason := coalesce(nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'reason'), 500), ''), 'Overtime reversed');
    update public.overtime_entries
    set status = 'reversed',
        reversed_at = pg_catalog.clock_timestamp(),
        reversed_by = p_actor,
        reversal_reason = v_reason,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_old.reference_no, 'idempotent', false, 'reversed', true
    );

  elsif p_operation = 'payroll.replace' then
    perform private.assert_permission('payroll.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_payroll from public.payrolls where id = v_target_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Payroll not found';
    end if;

    -- Route the reversal through this wrapper so any active OT claims are
    -- released before the corrected payroll attempts to claim them again.
    perform private.perform_operation_v2(
      'payroll.reverse',
      pg_catalog.jsonb_build_object(
        'id', v_target_id,
        'reason', 'Replaced by corrected payroll'
      ),
      p_actor
    );
    v_payload := coalesce(v_payload -> 'replacement', '{}'::jsonb)
      || pg_catalog.jsonb_build_object('_replaces_id', v_target_id);
    if nullif(v_payload ->> 'reference_no', '') is null
       or v_payload ->> 'reference_no' = v_payroll.reference_no then
      v_payload := pg_catalog.jsonb_set(
        v_payload,
        '{reference_no}',
        pg_catalog.to_jsonb(private.new_reference('PAY'))
      );
    end if;
    return private.perform_operation_v2('payroll.post', v_payload, p_actor)
      || pg_catalog.jsonb_build_object('operation', p_operation);

  elsif p_operation = 'payroll.post' then
    perform private.assert_permission('payroll.write');
    v_input := coalesce(v_payload -> 'overtime_ids', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 500 then
      raise exception using errcode = '22023', message = 'overtime_ids must be an array of at most 500 IDs';
    end if;

    select coalesce(pg_catalog.array_agg(distinct x.value::uuid order by x.value::uuid), array[]::uuid[])
    into v_ot_ids
    from pg_catalog.jsonb_array_elements_text(v_input) x(value);

    if pg_catalog.cardinality(v_ot_ids) <> pg_catalog.jsonb_array_length(v_input) then
      raise exception using errcode = '22023', message = 'overtime_ids must be unique';
    end if;

    if pg_catalog.cardinality(v_ot_ids) = 0 then
      return private.perform_operation_before_overtime(p_operation, v_payload, p_actor);
    end if;

    v_target_id := (v_payload ->> 'employee_id')::uuid;
    v_salary_month := v_payload ->> 'salary_month';
    if coalesce(v_salary_month, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception using errcode = '22023', message = 'salary_month must use YYYY-MM';
    end if;
    v_month_start := pg_catalog.to_date(v_salary_month || '-01', 'YYYY-MM-DD');
    v_month_end := (v_month_start + interval '1 month')::date;

    perform ot.id
    from public.overtime_entries ot
    where ot.id = any(v_ot_ids)
    order by ot.id
    for update;

    select pg_catalog.count(*)::integer into v_count
    from public.overtime_entries ot
    where ot.id = any(v_ot_ids)
      and ot.employee_id = v_target_id
      and ot.status = 'posted'
      and ot.work_date >= v_month_start
      and ot.work_date < v_month_end
      and not exists (
        select 1 from public.payroll_overtime_claims c
        where c.overtime_id = ot.id and c.is_active
      );
    if v_count <> pg_catalog.cardinality(v_ot_ids) then
      raise exception using errcode = '23505', message = 'One or more overtime claims are invalid, outside the salary month, or already claimed';
    end if;

    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'type', 'overtime',
        'description', 'Overtime ' || ot.reference_no || ' · ' || pg_catalog.to_char(ot.work_date, 'YYYY-MM-DD'),
        'quantity', ot.hours,
        'rate', ot.rate,
        'amount', ot.amount,
        'account_code', 'WAGES_EXPENSE'
      ) order by ot.work_date, ot.id
    ), '[]'::jsonb)
    into v_ot_earnings
    from public.overtime_entries ot
    where ot.id = any(v_ot_ids);

    if pg_catalog.jsonb_typeof(coalesce(v_payload -> 'earnings', '[]'::jsonb)) <> 'array' then
      raise exception using errcode = '22023', message = 'earnings must be an array';
    end if;
    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{earnings}',
      coalesce(v_payload -> 'earnings', '[]'::jsonb) || v_ot_earnings,
      true
    );

    v_result := private.perform_operation_before_overtime(p_operation, v_payload, p_actor);
    v_id := (v_result ->> 'id')::uuid;

    insert into public.payroll_overtime_claims (payroll_id, overtime_id, payroll_reference_no, created_by)
    select v_id, ot.id, coalesce(v_result ->> 'reference_no', v_id::text), p_actor
    from public.overtime_entries ot
    where ot.id = any(v_ot_ids)
    order by ot.id;

    return v_result;

  elsif p_operation = 'payroll.reverse' then
    perform private.assert_permission('payroll.write');
    v_id := (v_payload ->> 'id')::uuid;
    v_result := private.perform_operation_before_overtime(p_operation, v_payload, p_actor);
    update public.payroll_overtime_claims
    set is_active = false,
        released_at = pg_catalog.clock_timestamp(),
        released_by = p_actor
    where payroll_id = v_id and is_active;
    return v_result;
  end if;

  return private.perform_operation_before_overtime(p_operation, p_payload, p_actor);
end;
$function$;

-- The dispatcher itself is private. The public RPC wrapper and permissions are
-- left unchanged and continue to call private.perform_operation_v2 by name.
revoke all on function private.perform_operation_v2(text, jsonb, uuid) from public, anon, authenticated;

commit;
