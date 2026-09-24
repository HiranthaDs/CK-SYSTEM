begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

-- A complete, typed employee profile. Posted payroll rows continue to retain
-- their own snapshots; these fields provide the defaults used to prepare the
-- next payroll and an append-only compensation history records every save.
alter table public.employees
  add column email text,
  add column date_of_birth date,
  add column department text,
  add column tax_no text,
  add column emergency_contact jsonb,
  add column pay_effective_from date,
  add column standard_hours_per_day numeric(6,2) not null default 0,
  add column standard_days_per_month numeric(6,2) not null default 0,
  add column employee_epf_rate numeric(7,4) not null default 0,
  add column employer_epf_rate numeric(7,4) not null default 0,
  add column employer_etf_rate numeric(7,4) not null default 0,
  add column payroll_defaults jsonb not null default
    '{"earnings":[],"deductions":[],"employer_contributions":[]}'::jsonb,
  add column pay_notes text;

update public.employees
set pay_effective_from = coalesce(pay_effective_from, joined_date),
    left_date = case
      when status = 'inactive' then coalesce(left_date, current_date)
      else left_date
    end
where pay_effective_from is null
   or (status = 'inactive' and left_date is null);

alter table public.employees
  alter column pay_effective_from set default current_date,
  alter column pay_effective_from set not null,
  add constraint employees_email_format check (
    email is null or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  add constraint employees_birth_date_valid check (
    date_of_birth is null or date_of_birth < joined_date
  ),
  add constraint employees_pay_effective_date_valid check (
    pay_effective_from >= joined_date
  ),
  add constraint employees_inactive_left_date_required check (
    status <> 'inactive' or left_date is not null
  ),
  add constraint employees_standard_schedule_valid check (
    standard_hours_per_day between 0 and 24
    and standard_days_per_month between 0 and 31
  ),
  add constraint employees_statutory_rates_valid check (
    employee_epf_rate between 0 and 100
    and employer_epf_rate between 0 and 100
    and employer_etf_rate between 0 and 100
  ),
  add constraint employees_emergency_contact_object check (
    emergency_contact is null or pg_catalog.jsonb_typeof(emergency_contact) = 'object'
  ),
  add constraint employees_payroll_defaults_shape check (
    pg_catalog.jsonb_typeof(payroll_defaults) = 'object'
    and pg_catalog.jsonb_typeof(coalesce(payroll_defaults -> 'earnings', '[]'::jsonb)) = 'array'
    and pg_catalog.jsonb_typeof(coalesce(payroll_defaults -> 'deductions', '[]'::jsonb)) = 'array'
    and pg_catalog.jsonb_typeof(coalesce(payroll_defaults -> 'employer_contributions', '[]'::jsonb)) = 'array'
  );

create unique index employees_email_unique_idx
  on public.employees (pg_catalog.lower(email))
  where email is not null and pg_catalog.btrim(email) <> '';
create index employees_department_status_idx
  on public.employees (department, status, name);

create table public.employee_compensation_history (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  effective_from date not null,
  pay_model text not null,
  monthly_rate numeric(20,2) not null,
  daily_rate numeric(20,2) not null,
  ot_rate numeric(20,2) not null,
  standard_hours_per_day numeric(6,2) not null,
  standard_days_per_month numeric(6,2) not null,
  employee_epf_rate numeric(7,4) not null,
  employer_epf_rate numeric(7,4) not null,
  employer_etf_rate numeric(7,4) not null,
  payroll_defaults jsonb not null,
  pay_notes text,
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  changed_by uuid not null references auth.users(id) on delete restrict,
  constraint employee_comp_history_pay_model_valid check (
    pay_model in ('monthly', 'daily', 'hybrid', 'piecework')
  ),
  constraint employee_comp_history_rates_nonnegative check (
    monthly_rate >= 0 and daily_rate >= 0 and ot_rate >= 0
  ),
  constraint employee_comp_history_schedule_valid check (
    standard_hours_per_day between 0 and 24
    and standard_days_per_month between 0 and 31
  ),
  constraint employee_comp_history_statutory_rates_valid check (
    employee_epf_rate between 0 and 100
    and employer_epf_rate between 0 and 100
    and employer_etf_rate between 0 and 100
  ),
  constraint employee_comp_history_defaults_object check (
    pg_catalog.jsonb_typeof(payroll_defaults) = 'object'
  )
);

create index employee_comp_history_employee_date_idx
  on public.employee_compensation_history (employee_id, effective_from desc, changed_at desc);
create index employee_comp_history_changed_by_idx
  on public.employee_compensation_history (changed_by, changed_at desc);

create trigger employee_compensation_history_rpc_guard
before insert or update or delete on public.employee_compensation_history
for each row execute function private.require_rpc_guard();

create trigger employee_compensation_history_append_only
before update or delete on public.employee_compensation_history
for each row execute function private.reject_row_rewrite();

alter table public.employee_compensation_history enable row level security;
revoke all on table public.employee_compensation_history from public, anon, authenticated;
grant select on table public.employee_compensation_history to authenticated;

create policy employee_compensation_history_read
on public.employee_compensation_history
for select to authenticated
using ((select private.has_any_permission(
  array['payroll.read', 'employees.write']::text[]
)));

-- Preserve the previously reviewed dispatcher and layer narrowly-scoped
-- profile/rate invariants in front of it. Internal replacement calls resolve
-- through the new wrapper, so the same checks also apply to corrections.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_v2_before_employee_profiles;

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
  v_employee public.employees%rowtype;
  v_employee_id uuid;
  v_is_new boolean;
  v_work_type text;
begin
  if p_operation = 'piecework_rate.upsert' then
    v_work_type := pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'work_type'));
    if v_work_type <> '' then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('piecework-rate:' || v_work_type, 0)
      );
      if coalesce(v_payload ->> 'status', 'active') = 'active' and exists (
        select 1
        from public.piecework_rates r
        where pg_catalog.lower(r.work_type) = v_work_type
          and r.status = 'active'
          and r.id <> coalesce(nullif(v_payload ->> 'id', '')::uuid, pg_catalog.gen_random_uuid())
          and pg_catalog.daterange(
            r.effective_from, coalesce(r.effective_to, 'infinity'::date), '[]'
          ) && pg_catalog.daterange(
            (v_payload ->> 'effective_from')::date,
            coalesce(nullif(v_payload ->> 'effective_to', '')::date, 'infinity'::date),
            '[]'
          )
      ) then
        raise exception using
          errcode = '23505',
          message = 'An active piecework rate already covers part of this effective period';
      end if;
    end if;
  elsif p_operation = 'conversion.post' then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(v_payload -> 'workers', '[]'::jsonb)) w(value)
      left join public.piecework_rates r
        on r.id = nullif(w.value ->> 'rate_id', '')::uuid
      where nullif(w.value ->> 'rate_id', '') is not null
        and (
          r.id is null
          or r.status <> 'active'
          or (v_payload ->> 'conversion_date')::date < r.effective_from
          or (r.effective_to is not null and (v_payload ->> 'conversion_date')::date > r.effective_to)
          or pg_catalog.round((w.value ->> 'rate_per_kg')::numeric, 6)
             <> pg_catalog.round(r.rate_per_kg, 6)
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'A selected piecework rate is inactive, outside its effective period, or was overridden';
    end if;
  end if;

  if p_operation <> 'employee.upsert' then
    return private.perform_operation_v2_before_employee_profiles(
      p_operation, v_payload, p_actor
    );
  end if;

  v_is_new := nullif(v_payload ->> 'id', '') is null;
  v_result := private.perform_operation_v2_before_employee_profiles(
    p_operation, v_payload, p_actor
  );
  v_employee_id := (v_result ->> 'id')::uuid;

  update public.employees e
  set email = case when v_payload ? 'email'
        then nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'email')), '')
        else e.email end,
      date_of_birth = case when v_payload ? 'date_of_birth'
        then nullif(v_payload ->> 'date_of_birth', '')::date
        else e.date_of_birth end,
      department = case when v_payload ? 'department'
        then nullif(pg_catalog.btrim(v_payload ->> 'department'), '')
        else e.department end,
      tax_no = case when v_payload ? 'tax_no'
        then nullif(pg_catalog.btrim(v_payload ->> 'tax_no'), '')
        else e.tax_no end,
      emergency_contact = case when v_payload ? 'emergency_contact'
        then nullif(v_payload -> 'emergency_contact', 'null'::jsonb)
        else e.emergency_contact end,
      pay_effective_from = case when v_payload ? 'pay_effective_from'
        then coalesce(nullif(v_payload ->> 'pay_effective_from', '')::date, e.joined_date)
        when v_is_new then e.joined_date
        else e.pay_effective_from end,
      standard_hours_per_day = case when v_payload ? 'standard_hours_per_day'
        then coalesce(nullif(v_payload ->> 'standard_hours_per_day', '')::numeric, 0)
        else e.standard_hours_per_day end,
      standard_days_per_month = case when v_payload ? 'standard_days_per_month'
        then coalesce(nullif(v_payload ->> 'standard_days_per_month', '')::numeric, 0)
        else e.standard_days_per_month end,
      employee_epf_rate = case when v_payload ? 'employee_epf_rate'
        then coalesce(nullif(v_payload ->> 'employee_epf_rate', '')::numeric, 0)
        else e.employee_epf_rate end,
      employer_epf_rate = case when v_payload ? 'employer_epf_rate'
        then coalesce(nullif(v_payload ->> 'employer_epf_rate', '')::numeric, 0)
        else e.employer_epf_rate end,
      employer_etf_rate = case when v_payload ? 'employer_etf_rate'
        then coalesce(nullif(v_payload ->> 'employer_etf_rate', '')::numeric, 0)
        else e.employer_etf_rate end,
      payroll_defaults = case when v_payload ? 'payroll_defaults'
        then coalesce(nullif(v_payload -> 'payroll_defaults', 'null'::jsonb),
          '{"earnings":[],"deductions":[],"employer_contributions":[]}'::jsonb)
        else e.payroll_defaults end,
      pay_notes = case when v_payload ? 'pay_notes'
        then nullif(pg_catalog.btrim(v_payload ->> 'pay_notes'), '')
        else e.pay_notes end
  where e.id = v_employee_id
  returning e.* into v_employee;

  if not found then
    raise exception using errcode = 'P0001', message = 'Saved employee could not be reloaded';
  end if;

  insert into public.employee_compensation_history (
    employee_id, effective_from, pay_model, monthly_rate, daily_rate, ot_rate,
    standard_hours_per_day, standard_days_per_month, employee_epf_rate,
    employer_epf_rate, employer_etf_rate, payroll_defaults, pay_notes, changed_by
  ) values (
    v_employee.id, v_employee.pay_effective_from, v_employee.pay_model,
    v_employee.monthly_rate, v_employee.daily_rate, v_employee.ot_rate,
    v_employee.standard_hours_per_day, v_employee.standard_days_per_month,
    v_employee.employee_epf_rate, v_employee.employer_epf_rate,
    v_employee.employer_etf_rate, v_employee.payroll_defaults,
    v_employee.pay_notes, p_actor
  );

  return v_result;
end;
$function$;

revoke all on function private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated;
revoke all on function private.perform_operation_v2_before_employee_profiles(text, jsonb, uuid)
from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
