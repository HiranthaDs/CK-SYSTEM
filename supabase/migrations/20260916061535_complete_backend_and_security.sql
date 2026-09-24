-- CK SYS V3 - complete transactional API, reporting views, and access control
-- This migration intentionally upgrades both databases that received the
-- truncated initial migration and fresh databases created from this workspace.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- A corrected invoice replaces (rather than mutates) the original row. Keep
-- invoice numbers unique among live invoices while retaining the audit copy.
alter table public.sales drop constraint if exists sales_invoice_no_key;
create unique index if not exists sales_invoice_no_posted_idx
  on public.sales (invoice_no)
  where status = 'posted';

-- Flattened, security-invoker read models keep joins and filtering in Postgres
-- and avoid loading unbounded journals into Python or the browser.
create or replace view public.ledger_view
with (security_invoker = true)
as
select
  jl.id,
  jl.journal_entry_id,
  jl.line_no,
  jl.account_id,
  a.code as account_code,
  a.name as account_name,
  a.category,
  a.normal_side,
  jl.description,
  jl.debit,
  jl.credit,
  jl.created_at,
  je.reference_no,
  je.journal_date as entry_date,
  je.source_type,
  je.source_type as source_module,
  je.source_id,
  je.memo,
  je.status,
  pg_catalog.concat_ws(
    ' ', je.reference_no, je.memo, je.source_type, a.code, a.name, jl.description
  ) as search_text,
  pg_catalog.sum(
    case when a.normal_side = 'debit'
      then jl.debit - jl.credit
      else jl.credit - jl.debit
    end
  ) over (
    partition by jl.account_id
    order by je.journal_date, je.created_at, jl.line_no, jl.id
    rows between unbounded preceding and current row
  )::numeric(20,2) as balance
from public.journal_lines jl
join public.journal_entries je on je.id = jl.journal_entry_id
join public.accounts a on a.id = jl.account_id;

create or replace view public.account_balances_by_year
with (security_invoker = true)
as
select
  extract(year from je.journal_date)::integer as fiscal_year,
  a.id as account_id,
  a.code as account_code,
  a.name as account_name,
  a.category,
  a.normal_side,
  coalesce(pg_catalog.sum(jl.debit), 0::numeric)::numeric(20,2) as debit_total,
  coalesce(pg_catalog.sum(jl.credit), 0::numeric)::numeric(20,2) as credit_total,
  case when a.normal_side = 'debit'
    then coalesce(pg_catalog.sum(jl.debit - jl.credit), 0::numeric)
    else coalesce(pg_catalog.sum(jl.credit - jl.debit), 0::numeric)
  end::numeric(20,2) as balance
from public.accounts a
join public.journal_lines jl on jl.account_id = a.id
join public.journal_entries je on je.id = jl.journal_entry_id
group by extract(year from je.journal_date),
         a.id, a.code, a.name, a.category, a.normal_side;

create or replace view public.inventory_stage_summary
with (security_invoker = true)
as
select
  i.stage,
  pg_catalog.count(*)::bigint as item_count,
  coalesce(pg_catalog.sum(b.quantity_on_hand), 0::numeric)::numeric(20,6) as total_quantity,
  coalesce(pg_catalog.sum(b.inventory_value), 0::numeric)::numeric(20,2) as total_value
from public.inventory_items i
left join public.inventory_balances b on b.item_id = i.id
where i.is_active
group by i.stage;

create or replace view public.production_daily_summary
with (security_invoker = true)
as
select
  p.production_date,
  pg_catalog.count(*)::bigint as run_count,
  coalesce(pg_catalog.sum(p.input_kg), 0::numeric)::numeric(20,6) as input_kg,
  coalesce(pg_catalog.sum(p.output_quantity), 0::numeric)::numeric(20,6) as output_quantity,
  coalesce(pg_catalog.sum(p.total_cost), 0::numeric)::numeric(20,2) as total_cost
from public.production_runs p
where p.status = 'posted'
group by p.production_date;

create index if not exists journal_lines_description_trgm_idx
  on public.journal_lines using gin (description extensions.gin_trgm_ops);
create index if not exists journal_entries_source_date_id_idx
  on public.journal_entries (source_type, journal_date desc, id desc);
create index if not exists sales_status_invoice_idx
  on public.sales (status, invoice_no);
create index if not exists payrolls_status_employee_month_idx
  on public.payrolls (status, employee_id, salary_month);

create or replace function private.set_sale_payment_state(
  p_sale_id uuid,
  p_paid_amount numeric,
  p_actor uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_total numeric(20,2);
  v_paid numeric(20,2) := pg_catalog.round(p_paid_amount, 2);
begin
  select s.total_amount into v_total
  from public.sales s
  where s.id = p_sale_id and s.status = 'posted'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'Posted sale not found';
  end if;
  if v_paid < 0 or v_paid > v_total then
    raise exception using errcode = '23514', message = 'Sale payment exceeds the outstanding balance';
  end if;
  update public.sales
  set paid_amount = v_paid,
      payment_status = case
        when v_paid = 0 then 'unpaid'
        when v_paid = v_total then 'paid'
        else 'partial'
      end,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_actor
  where id = p_sale_id;
end;
$function$;

-- Public RPC facade. It is SECURITY DEFINER because authenticated clients have
-- read-only table grants; every call is identity-bound, permission-checked by
-- the dispatcher, idempotent, guarded, audited, and explicitly not executable
-- by PUBLIC or anon.
create or replace function public.erp_execute(
  p_operation text,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_hash text;
  v_result jsonb;
  v_existing public.idempotency_keys%rowtype;
  v_inserted integer;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  if nullif(pg_catalog.btrim(p_operation), '') is null
     or pg_catalog.char_length(p_operation) > 100 then
    raise exception using errcode = '22023', message = 'A valid operation is required';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Payload must be a JSON object';
  end if;
  if p_idempotency_key is null
     or pg_catalog.char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]+$' then
    raise exception using errcode = '22023', message = 'A valid idempotency key is required';
  end if;

  perform pg_catalog.set_config('app.erp_rpc_guard', 'enabled', true);
  v_hash := pg_catalog.md5(p_operation || ':' || p_payload::text);

  delete from public.idempotency_keys k
  where k.actor_user_id = v_actor
    and k.idempotency_key = p_idempotency_key
    and k.expires_at <= pg_catalog.clock_timestamp();

  insert into public.idempotency_keys (
    actor_user_id, idempotency_key, operation, request_hash
  ) values (
    v_actor, p_idempotency_key, p_operation, v_hash
  )
  on conflict (actor_user_id, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select * into v_existing
    from public.idempotency_keys k
    where k.actor_user_id = v_actor and k.idempotency_key = p_idempotency_key
    for update;
    if not found then
      raise exception using errcode = '40001', message = 'Idempotency state changed; retry the request';
    end if;
    if v_existing.operation <> p_operation or v_existing.request_hash <> v_hash then
      raise exception using errcode = '23505', message = 'Idempotency key was already used for a different request';
    end if;
    if v_existing.response is null then
      raise exception using errcode = '40001', message = 'The original request is still being completed';
    end if;
    return v_existing.response || pg_catalog.jsonb_build_object('idempotent', true);
  end if;

  v_result := private.perform_operation_v2(p_operation, p_payload, v_actor)
    || pg_catalog.jsonb_build_object('idempotent', false);

  update public.idempotency_keys
  set response = v_result,
      completed_at = pg_catalog.clock_timestamp()
  where actor_user_id = v_actor and idempotency_key = p_idempotency_key;

  insert into public.audit_log (
    actor_user_id, operation, entity_table, entity_id, action,
    after_data, idempotency_key, request_id
  ) values (
    v_actor,
    p_operation,
    pg_catalog.split_part(p_operation, '.', 1),
    v_result ->> 'id',
    case when p_operation like '%.reverse' then 'reverse' else 'execute' end,
    v_result,
    p_idempotency_key,
    private.current_request_id()
  );

  return v_result;
end;
$function$;

create or replace function public.erp_dashboard(p_year integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_year integer := coalesce(p_year, extract(year from current_date)::integer);
  v_inventory jsonb;
  v_finance jsonb;
  v_workforce jsonb;
  v_operations jsonb;
  v_revenue numeric(20,2);
  v_cogs numeric(20,2);
  v_expenses numeric(20,2);
  v_receivables numeric(20,2);
  v_payables numeric(20,2);
  v_cash_bank numeric(20,2);
  v_active_employees bigint;
  v_open_daily numeric(20,2);
  v_open_piecework numeric(20,2);
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  if v_year not between 2000 and 2200 then
    raise exception using errcode = '22023', message = 'Dashboard year is out of range';
  end if;
  if not private.has_permission('dashboard.read')
     and not private.has_permission('reports.read') then
    raise exception using errcode = '42501', message = 'ERP dashboard permission denied';
  end if;

  select pg_catalog.jsonb_build_object(
    'bulk', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'stage', 'bulk', 'item_count', pg_catalog.count(*) filter (where i.stage = 'bulk'),
      'quantity_on_hand', coalesce(pg_catalog.sum(b.quantity_on_hand) filter (where i.stage = 'bulk'), 0),
      'inventory_value', coalesce(pg_catalog.sum(b.inventory_value) filter (where i.stage = 'bulk'), 0)
    )),
    'chip', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'stage', 'chip', 'item_count', pg_catalog.count(*) filter (where i.stage = 'chip'),
      'quantity_on_hand', coalesce(pg_catalog.sum(b.quantity_on_hand) filter (where i.stage = 'chip'), 0),
      'inventory_value', coalesce(pg_catalog.sum(b.inventory_value) filter (where i.stage = 'chip'), 0)
    )),
    'finished', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'stage', 'finished', 'item_count', pg_catalog.count(*) filter (where i.stage = 'finished'),
      'quantity_on_hand', coalesce(pg_catalog.sum(b.quantity_on_hand) filter (where i.stage = 'finished'), 0),
      'inventory_value', coalesce(pg_catalog.sum(b.inventory_value) filter (where i.stage = 'finished'), 0)
    ))
  ) into v_inventory
  from public.inventory_items i
  left join public.inventory_balances b on b.item_id = i.id
  where i.is_active;

  select
    coalesce(pg_catalog.sum(
      case when a.category = 'revenue' then jl.credit - jl.debit else 0 end
    ), 0),
    coalesce(pg_catalog.sum(
      case when a.code = 'COGS' then jl.debit - jl.credit else 0 end
    ), 0),
    coalesce(pg_catalog.sum(
      case when a.category = 'expense' and a.code <> 'COGS'
        then jl.debit - jl.credit else 0 end
    ), 0)
  into v_revenue, v_cogs, v_expenses
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.journal_entry_id
  join public.accounts a on a.id = jl.account_id
  where je.journal_date >= pg_catalog.make_date(v_year, 1, 1)
    and je.journal_date < pg_catalog.make_date(v_year + 1, 1, 1);

  select coalesce(pg_catalog.sum(s.balance_due), 0)
  into v_receivables
  from public.sales s
  where s.status = 'posted';

  select
    coalesce(pg_catalog.sum(ab.balance) filter (where ab.category = 'liability'), 0),
    coalesce(pg_catalog.sum(ab.balance) filter (where ab.account_code in ('CASH', 'BANK')), 0)
  into v_payables, v_cash_bank
  from public.account_balances ab;

  v_finance := pg_catalog.jsonb_build_object(
    'revenue', v_revenue, 'cogs', v_cogs, 'expenses', v_expenses,
    'receivables', v_receivables, 'payables', v_payables, 'cash_bank', v_cash_bank
  );

  select pg_catalog.count(*) into v_active_employees
  from public.employees e where e.status = 'active';
  select
    coalesce(pg_catalog.sum(oe.amount) filter (where oe.source_type = 'daily_work'), 0),
    coalesce(pg_catalog.sum(oe.amount) filter (where oe.source_type <> 'daily_work'), 0)
  into v_open_daily, v_open_piecework
  from public.employee_open_earnings oe;
  v_workforce := pg_catalog.jsonb_build_object(
    'active_employees', v_active_employees,
    'open_daily_wages', v_open_daily,
    'open_piecework', v_open_piecework
  );

  v_operations := pg_catalog.jsonb_build_object(
    'purchases', (select pg_catalog.count(*) from public.raw_material_purchases r
      where r.status = 'posted' and r.purchase_date >= pg_catalog.make_date(v_year,1,1)
        and r.purchase_date < pg_catalog.make_date(v_year+1,1,1)),
    'conversions', (select pg_catalog.count(*) from public.conversions c
      where c.status = 'posted' and c.conversion_date >= pg_catalog.make_date(v_year,1,1)
        and c.conversion_date < pg_catalog.make_date(v_year+1,1,1)),
    'production', (select pg_catalog.count(*) from public.production_runs p
      where p.status = 'posted' and p.production_date >= pg_catalog.make_date(v_year,1,1)
        and p.production_date < pg_catalog.make_date(v_year+1,1,1)),
    'sales', (select pg_catalog.count(*) from public.sales s
      where s.status = 'posted' and s.sale_date >= pg_catalog.make_date(v_year,1,1)
        and s.sale_date < pg_catalog.make_date(v_year+1,1,1)),
    'payroll', (select pg_catalog.count(*) from public.payrolls p
      where p.status = 'posted' and p.payroll_date >= pg_catalog.make_date(v_year,1,1)
        and p.payroll_date < pg_catalog.make_date(v_year+1,1,1))
  );

  return pg_catalog.jsonb_build_object(
    'year', v_year,
    'inventory', v_inventory,
    'finance', v_finance,
    'workforce', v_workforce,
    'operations', v_operations,
    'generated_at', pg_catalog.clock_timestamp()
  );
end;
$function$;


create or replace function private.set_payroll_payment_state(
  p_payroll_id uuid,
  p_paid_amount numeric,
  p_actor uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_total numeric(20,2);
  v_paid numeric(20,2) := pg_catalog.round(p_paid_amount, 2);
begin
  select p.net_pay into v_total
  from public.payrolls p
  where p.id = p_payroll_id and p.status = 'posted'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'Posted payroll not found';
  end if;
  if v_paid < 0 or v_paid > v_total then
    raise exception using errcode = '23514', message = 'Payroll payment exceeds the outstanding balance';
  end if;
  update public.payrolls
  set paid_amount = v_paid,
      payment_status = case
        when v_paid = 0 and v_total > 0 then 'unpaid'
        when v_paid = v_total then 'paid'
        else 'partial'
      end,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_actor
  where id = p_payroll_id;
end;
$function$;

-- The original dispatcher contains workforce, purchasing, conversion, and
-- production. This wrapper adds the remaining modules without duplicating the
-- already-audited implementations.
create or replace function private.perform_operation_v2(
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
  v_input jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_details jsonb := '[]'::jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_result jsonb;
  v_row record;
  v_id uuid;
  v_target_id uuid;
  v_item_id uuid;
  v_journal_id uuid;
  v_reversal_journal_id uuid;
  v_reference text;
  v_reason text;
  v_method text;
  v_account_code text;
  v_date date;
  v_line_no integer := 0;
  v_count integer;
  v_quantity numeric(20,6);
  v_unit_price numeric(20,6);
  v_unit_cost numeric(20,6);
  v_discount numeric(20,2);
  v_amount numeric(20,2);
  v_amount_2 numeric(20,2);
  v_amount_3 numeric(20,2);
  v_total numeric(20,2);
  v_cogs numeric(20,2);
  v_paid numeric(20,2);
  v_available_quantity numeric(20,6);
  v_available_value numeric(20,2);
  v_regular numeric(20,2);
  v_daily numeric(20,2);
  v_piecework numeric(20,2);
  v_deductions numeric(20,2);
  v_contributions numeric(20,2);
  v_gross numeric(20,2);
  v_net numeric(20,2);
  v_item_ids uuid[] := array[]::uuid[];
  v_daily_ids uuid[] := array[]::uuid[];
  v_conversion_ids uuid[] := array[]::uuid[];
  v_piecework_ids uuid[] := array[]::uuid[];
  v_sale public.sales%rowtype;
  v_sale_payment public.sale_payments%rowtype;
  v_payroll public.payrolls%rowtype;
  v_payroll_payment public.payroll_payments%rowtype;
  v_adjustment public.stock_adjustments%rowtype;
  v_journal public.journal_entries%rowtype;
begin
  if p_operation = any(array[
    'employee.upsert', 'employee.delete',
    'piecework_rate.upsert', 'piecework_rate.delete',
    'daily_work.upsert', 'daily_work.reverse',
    'rm_purchase.post', 'rm_purchase.replace', 'rm_purchase.reverse',
    'conversion.post', 'conversion.replace', 'conversion.reverse',
    'production.post', 'production.replace', 'production.reverse'
  ]) then
    return private.perform_operation(p_operation, p_payload, p_actor);
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

  -- Sales and customer receipts ---------------------------------------------
  if p_operation = 'sale.replace' then
    perform private.assert_permission('sales.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_sale from public.sales where id = v_target_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Sale not found';
    end if;
    perform private.perform_operation_v2(
      'sale.reverse',
      pg_catalog.jsonb_build_object('id', v_target_id, 'reason', 'Replaced by corrected sale'),
      p_actor
    );
    v_payload := coalesce(v_payload -> 'replacement', '{}'::jsonb)
      || pg_catalog.jsonb_build_object('_replaces_id', v_target_id);
    if nullif(v_payload ->> 'reference_no', '') is null
       or v_payload ->> 'reference_no' = v_sale.reference_no then
      v_payload := pg_catalog.jsonb_set(
        v_payload, '{reference_no}', pg_catalog.to_jsonb(private.new_reference('SAL'))
      );
    end if;
    return private.perform_operation_v2('sale.post', v_payload, p_actor)
      || pg_catalog.jsonb_build_object('operation', p_operation);

  elsif p_operation = 'sale.post' then
    perform private.assert_permission('sales.write');
    v_id := pg_catalog.gen_random_uuid();
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''), private.new_reference('SAL')
    );
    v_date := (v_payload ->> 'sale_date')::date;
    v_method := pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'payment_method'));
    v_input := coalesce(v_payload -> 'items', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) not between 1 and 500 then
      raise exception using errcode = '22023', message = 'A sale requires between 1 and 500 items';
    end if;

    -- Resolve every item first and acquire all balance locks in UUID order.
    for v_row in
      select x.value from pg_catalog.jsonb_array_elements(v_input) x(value)
    loop
      v_item_id := private.resolve_inventory_item(
        v_row.value ->> 'item_id', v_row.value ->> 'item_name', 'finished', p_actor
      );
      if pg_catalog.array_position(v_item_ids, v_item_id) is not null then
        raise exception using errcode = '23514', message = 'A sale cannot contain the same item twice';
      end if;
      v_item_ids := pg_catalog.array_append(v_item_ids, v_item_id);
      v_rows := v_rows || pg_catalog.jsonb_build_array(
        v_row.value || pg_catalog.jsonb_build_object('_item_id', v_item_id)
      );
    end loop;
    perform private.lock_inventory(v_item_ids);

    v_input := v_rows;
    v_rows := '[]'::jsonb;
    v_total := 0;
    v_cogs := 0;
    for v_row in
      select x.value from pg_catalog.jsonb_array_elements(v_input) x(value)
    loop
      v_item_id := (v_row.value ->> '_item_id')::uuid;
      v_quantity := pg_catalog.round((v_row.value ->> 'quantity')::numeric, 6);
      v_unit_price := pg_catalog.round((v_row.value ->> 'unit_price')::numeric, 6);
      v_discount := pg_catalog.round(
        coalesce(nullif(v_row.value ->> 'discount', '')::numeric, 0), 2
      );
      if v_quantity <= 0 or v_unit_price <= 0 or v_discount < 0 then
        raise exception using errcode = '22023', message = 'Invalid sale item quantity, price, or discount';
      end if;
      v_amount := pg_catalog.round(v_quantity * v_unit_price - v_discount, 2);
      if v_amount <= 0 then
        raise exception using errcode = '23514', message = 'Sale line total must be positive';
      end if;

      select b.quantity_on_hand, b.inventory_value
      into v_available_quantity, v_available_value
      from public.inventory_balances b
      where b.item_id = v_item_id;
      if v_available_quantity < v_quantity then
        raise exception using errcode = 'P0001', message = 'Insufficient finished-goods inventory';
      end if;
      v_amount_2 := case when v_available_quantity = v_quantity
        then v_available_value
        else pg_catalog.round(v_available_value / v_available_quantity * v_quantity, 2)
      end;
      v_unit_cost := pg_catalog.round(v_amount_2 / v_quantity, 6);
      v_total := v_total + v_amount;
      v_cogs := v_cogs + v_amount_2;
      v_rows := v_rows || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'item_id', v_item_id,
          'quantity', v_quantity,
          'unit_price', v_unit_price,
          'discount', v_discount,
          'line_total', v_amount,
          'unit_cost', v_unit_cost,
          'line_cogs', v_amount_2
        )
      );
    end loop;
    v_total := pg_catalog.round(v_total, 2);
    v_cogs := pg_catalog.round(v_cogs, 2);
    v_paid := pg_catalog.round(
      coalesce(nullif(v_payload ->> 'amount_paid', '')::numeric, 0), 2
    );
    if v_paid < 0 or v_paid > v_total then
      raise exception using errcode = '23514', message = 'Initial payment exceeds the invoice total';
    end if;
    if v_paid > 0 and private.settlement_account_code(v_method) is null then
      raise exception using errcode = '22023', message = 'Initial payment requires a cash or bank settlement method';
    end if;

    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_code', 'ACCOUNTS_RECEIVABLE', 'description', 'Customer invoice',
        'debit', v_total, 'credit', 0
      ),
      pg_catalog.jsonb_build_object(
        'account_code', 'SALES_REVENUE', 'description', 'Sales revenue',
        'debit', 0, 'credit', v_total
      )
    );
    if v_cogs > 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', 'COGS', 'description', 'Cost of goods sold',
          'debit', v_cogs, 'credit', 0
        ),
        pg_catalog.jsonb_build_object(
          'account_code', 'FINISHED_GOODS_INVENTORY', 'description', 'Finished goods issued',
          'debit', 0, 'credit', v_cogs
        )
      );
    end if;
    v_journal_id := private.post_journal(
      v_date, 'Sale ' || v_reference, 'sale', v_id, v_lines, p_actor
    );

    insert into public.sales (
      id, reference_no, invoice_no, sale_date, customer_name, customer_phone,
      payment_method, total_amount, total_cogs, paid_amount, payment_status,
      journal_entry_id, replaces_id, created_by, updated_by
    ) values (
      v_id,
      pg_catalog.left(v_reference, 80),
      pg_catalog.left(pg_catalog.btrim(v_payload ->> 'invoice_no'), 80),
      v_date,
      pg_catalog.left(pg_catalog.btrim(v_payload ->> 'customer_name'), 160),
      nullif(pg_catalog.btrim(v_payload ->> 'customer_phone'), ''),
      v_method,
      v_total,
      v_cogs,
      0,
      'unpaid',
      v_journal_id,
      nullif(v_payload ->> '_replaces_id', '')::uuid,
      p_actor,
      p_actor
    );

    insert into public.sale_items (
      id, sale_id, item_id, quantity, unit_price, discount, line_total,
      unit_cost, line_cogs, created_by
    )
    select
      pg_catalog.gen_random_uuid(), v_id, (x.value ->> 'item_id')::uuid,
      (x.value ->> 'quantity')::numeric, (x.value ->> 'unit_price')::numeric,
      (x.value ->> 'discount')::numeric, (x.value ->> 'line_total')::numeric,
      (x.value ->> 'unit_cost')::numeric, (x.value ->> 'line_cogs')::numeric,
      p_actor
    from pg_catalog.jsonb_array_elements(v_rows) x(value);

    for v_row in
      select x.value from pg_catalog.jsonb_array_elements(v_rows) x(value)
    loop
      perform private.apply_stock(
        (v_row.value ->> 'item_id')::uuid,
        -(v_row.value ->> 'quantity')::numeric,
        -(v_row.value ->> 'line_cogs')::numeric,
        v_date, 'sale', v_id, v_journal_id, 'Finished goods sold', p_actor
      );
    end loop;

    if v_paid > 0 then
      perform private.perform_operation_v2(
        'sale_payment.post',
        pg_catalog.jsonb_build_object(
          'sale_id', v_id,
          'payment_date', v_date,
          'amount', v_paid,
          'method', v_method,
          'notes', 'Initial invoice payment',
          '_is_initial', true
        ),
        p_actor
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'sale_payment.post' then
    perform private.assert_permission('sales.write');
    v_id := pg_catalog.gen_random_uuid();
    v_target_id := (v_payload ->> 'sale_id')::uuid;
    select * into v_sale from public.sales where id = v_target_id for update;
    if not found or v_sale.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Posted sale not found';
    end if;
    v_amount := pg_catalog.round((v_payload ->> 'amount')::numeric, 2);
    if v_amount <= 0 or v_amount > v_sale.balance_due then
      raise exception using errcode = '23514', message = 'Receipt amount exceeds the outstanding balance';
    end if;
    v_method := pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'method'));
    v_account_code := private.settlement_account_code(v_method);
    if v_account_code is null then
      raise exception using errcode = '22023', message = 'Receipt requires a cash or bank settlement method';
    end if;
    v_date := (v_payload ->> 'payment_date')::date;
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''), private.new_reference('RCP')
    );
    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_code', v_account_code, 'description', 'Customer receipt',
        'debit', v_amount, 'credit', 0
      ),
      pg_catalog.jsonb_build_object(
        'account_code', 'ACCOUNTS_RECEIVABLE', 'description', 'Receivable settled',
        'debit', 0, 'credit', v_amount
      )
    );
    v_journal_id := private.post_journal(
      v_date, 'Receipt ' || v_reference, 'sale_payment', v_id, v_lines, p_actor
    );
    insert into public.sale_payments (
      id, reference_no, sale_id, payment_date, amount, method, notes,
      is_initial, journal_entry_id, created_by, updated_by
    ) values (
      v_id, pg_catalog.left(v_reference, 80), v_target_id, v_date, v_amount,
      v_method, nullif(pg_catalog.btrim(v_payload ->> 'notes'), ''),
      coalesce((v_payload ->> '_is_initial')::boolean, false),
      v_journal_id, p_actor, p_actor
    );
    perform private.set_sale_payment_state(v_target_id, v_sale.paid_amount + v_amount, p_actor);
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'sale_payment.reverse' then
    perform private.assert_permission('sales.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_sale_payment from public.sale_payments where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Sale payment not found';
    end if;
    if v_sale_payment.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Sale payment is already reversed';
    end if;
    select * into v_sale from public.sales where id = v_sale_payment.sale_id for update;
    if not found or v_sale.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Posted parent sale not found';
    end if;
    v_reason := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Sale payment reversed'
    );
    v_reversal_journal_id := private.reverse_journal(
      v_sale_payment.journal_entry_id, current_date, p_actor, v_reason
    );
    update public.sale_payments
    set status = 'reversed', reversal_journal_entry_id = v_reversal_journal_id,
        reversed_at = pg_catalog.clock_timestamp(), reversed_by = p_actor,
        reversal_reason = v_reason, updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    perform private.set_sale_payment_state(
      v_sale.id, v_sale.paid_amount - v_sale_payment.amount, p_actor
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_sale_payment.reference_no, 'idempotent', false, 'reversed', true
    );

  elsif p_operation = 'sale.reverse' then
    perform private.assert_permission('sales.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_sale from public.sales where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Sale not found';
    end if;
    if v_sale.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Sale is already reversed';
    end if;
    v_reason := coalesce(nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Sale reversed');
    for v_row in
      select sp.id
      from public.sale_payments sp
      where sp.sale_id = v_id and sp.status = 'posted'
      order by sp.payment_date desc, sp.id desc
    loop
      perform private.perform_operation_v2(
        'sale_payment.reverse',
        pg_catalog.jsonb_build_object('id', v_row.id, 'reason', v_reason),
        p_actor
      );
    end loop;
    select coalesce(pg_catalog.array_agg(distinct si.item_id order by si.item_id), array[]::uuid[])
    into v_item_ids
    from public.sale_items si
    where si.sale_id = v_id;
    perform private.lock_inventory(v_item_ids);
    v_reversal_journal_id := private.reverse_journal(
      v_sale.journal_entry_id, current_date, p_actor, v_reason
    );
    for v_row in
      select si.* from public.sale_items si where si.sale_id = v_id order by si.item_id
    loop
      perform private.apply_stock(
        v_row.item_id, v_row.quantity, v_row.line_cogs,
        current_date, 'sale.reversal', v_id,
        v_reversal_journal_id, v_reason, p_actor
      );
    end loop;
    update public.sales
    set status = 'reversed', reversal_journal_entry_id = v_reversal_journal_id,
        reversed_at = pg_catalog.clock_timestamp(), reversed_by = p_actor,
        reversal_reason = v_reason, updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_sale.reference_no, 'idempotent', false, 'reversed', true
    );

  -- Payroll, claims, deductions, and settlements ----------------------------
  elsif p_operation = 'payroll.replace' then
    perform private.assert_permission('payroll.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_payroll from public.payrolls where id = v_target_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Payroll not found';
    end if;
    perform private.perform_operation_v2(
      'payroll.reverse',
      pg_catalog.jsonb_build_object('id', v_target_id, 'reason', 'Replaced by corrected payroll'),
      p_actor
    );
    v_payload := coalesce(v_payload -> 'replacement', '{}'::jsonb)
      || pg_catalog.jsonb_build_object('_replaces_id', v_target_id);
    if nullif(v_payload ->> 'reference_no', '') is null
       or v_payload ->> 'reference_no' = v_payroll.reference_no then
      v_payload := pg_catalog.jsonb_set(
        v_payload, '{reference_no}', pg_catalog.to_jsonb(private.new_reference('PAY'))
      );
    end if;
    return private.perform_operation_v2('payroll.post', v_payload, p_actor)
      || pg_catalog.jsonb_build_object('operation', p_operation);

  elsif p_operation = 'payroll.post' then
    perform private.assert_permission('payroll.write');
    v_id := pg_catalog.gen_random_uuid();
    v_target_id := (v_payload ->> 'employee_id')::uuid;
    perform 1 from public.employees e where e.id = v_target_id and e.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active payroll employee not found';
    end if;
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''), private.new_reference('PAY')
    );
    v_date := (v_payload ->> 'payroll_date')::date;
    if coalesce(v_payload ->> 'salary_month', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception using errcode = '22023', message = 'salary_month must use YYYY-MM';
    end if;
    if coalesce(v_payload ->> 'status', '') not in ('payable', 'paid') then
      raise exception using errcode = '22023', message = 'Payroll status must be payable or paid';
    end if;

    v_input := coalesce(v_payload -> 'daily_work_ids', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 500 then
      raise exception using errcode = '22023', message = 'daily_work_ids must be an array of at most 500 IDs';
    end if;
    select coalesce(pg_catalog.array_agg(x.value::uuid order by x.value), array[]::uuid[])
    into v_daily_ids
    from pg_catalog.jsonb_array_elements_text(v_input) x(value);

    v_input := coalesce(v_payload -> 'conversion_worker_ids', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 500 then
      raise exception using errcode = '22023', message = 'conversion_worker_ids must be an array of at most 500 IDs';
    end if;
    select coalesce(pg_catalog.array_agg(x.value::uuid order by x.value), array[]::uuid[])
    into v_conversion_ids
    from pg_catalog.jsonb_array_elements_text(v_input) x(value);

    v_input := coalesce(v_payload -> 'manual_piecework_ids', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 500 then
      raise exception using errcode = '22023', message = 'manual_piecework_ids must be an array of at most 500 IDs';
    end if;
    select coalesce(pg_catalog.array_agg(x.value::uuid order by x.value), array[]::uuid[])
    into v_piecework_ids
    from pg_catalog.jsonb_array_elements_text(v_input) x(value);

    -- Lock claim sources in deterministic groups and reject stale or foreign claims.
    perform dw.id
    from public.daily_work dw
    where dw.id = any(v_daily_ids)
    order by dw.id
    for update;
    select pg_catalog.count(*)::integer into v_count
    from public.daily_work dw
    where dw.id = any(v_daily_ids)
      and dw.employee_id = v_target_id
      and dw.status = 'posted'
      and not exists (
        select 1 from public.payroll_details pd
        where pd.source_daily_work_id = dw.id and pd.is_active
      );
    if v_count <> pg_catalog.cardinality(v_daily_ids) then
      raise exception using errcode = '23505', message = 'One or more daily-work claims are invalid or already claimed';
    end if;

    perform cw.id
    from public.conversion_workers cw
    where cw.id = any(v_conversion_ids)
    order by cw.id
    for update;
    select pg_catalog.count(*)::integer into v_count
    from public.conversion_workers cw
    join public.conversions c on c.id = cw.conversion_id
    where cw.id = any(v_conversion_ids)
      and cw.employee_id = v_target_id
      and c.status = 'posted'
      and not exists (
        select 1 from public.payroll_details pd
        where pd.source_conversion_worker_id = cw.id and pd.is_active
      );
    if v_count <> pg_catalog.cardinality(v_conversion_ids) then
      raise exception using errcode = '23505', message = 'One or more conversion claims are invalid or already claimed';
    end if;

    perform dwp.id
    from public.daily_work_piecework dwp
    where dwp.id = any(v_piecework_ids)
    order by dwp.id
    for update;
    select pg_catalog.count(*)::integer into v_count
    from public.daily_work_piecework dwp
    join public.daily_work dw on dw.id = dwp.daily_work_id
    where dwp.id = any(v_piecework_ids)
      and dw.employee_id = v_target_id
      and dw.status = 'posted'
      and not exists (
        select 1 from public.payroll_details pd
        where pd.source_manual_piecework_id = dwp.id and pd.is_active
      );
    if v_count <> pg_catalog.cardinality(v_piecework_ids) then
      raise exception using errcode = '23505', message = 'One or more piecework claims are invalid or already claimed';
    end if;

    v_regular := 0;
    v_daily := 0;
    v_piecework := 0;
    v_deductions := 0;
    v_contributions := 0;

    for v_row in
      select dw.* from public.daily_work dw where dw.id = any(v_daily_ids) order by dw.work_date, dw.id
    loop
      v_daily := v_daily + v_row.base_amount;
      v_line_no := v_line_no + 1;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_no', v_line_no, 'line_kind', 'daily_wage',
          'earning_type', 'daily_work', 'description', 'Daily work ' || v_row.reference_no,
          'quantity', v_row.work_units, 'rate', v_row.daily_rate,
          'amount', v_row.base_amount, 'account_code', 'WAGES_PAYABLE',
          'source_daily_work_id', v_row.id
        )
      );
    end loop;

    for v_row in
      select cw.*, c.reference_no
      from public.conversion_workers cw
      join public.conversions c on c.id = cw.conversion_id
      where cw.id = any(v_conversion_ids)
      order by cw.work_date, cw.id
    loop
      v_piecework := v_piecework + v_row.amount;
      v_line_no := v_line_no + 1;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_no', v_line_no, 'line_kind', 'conversion_piecework',
          'earning_type', 'conversion_piecework',
          'description', v_row.task || ' (' || v_row.reference_no || ')',
          'quantity', v_row.quantity_kg, 'rate', v_row.rate_per_kg,
          'amount', v_row.amount, 'account_code', 'WAGES_PAYABLE',
          'source_conversion_worker_id', v_row.id
        )
      );
    end loop;

    for v_row in
      select dwp.*, dw.reference_no, dw.work_date
      from public.daily_work_piecework dwp
      join public.daily_work dw on dw.id = dwp.daily_work_id
      where dwp.id = any(v_piecework_ids)
      order by dw.work_date, dwp.id
    loop
      v_piecework := v_piecework + v_row.amount;
      v_line_no := v_line_no + 1;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_no', v_line_no, 'line_kind', 'manual_piecework',
          'earning_type', 'manual_piecework',
          'description', v_row.task || ' (' || v_row.reference_no || ')',
          'quantity', v_row.quantity_kg, 'rate', v_row.rate_per_kg,
          'amount', v_row.amount, 'account_code', 'WAGES_PAYABLE',
          'source_manual_piecework_id', v_row.id
        )
      );
    end loop;

    v_input := coalesce(v_payload -> 'earnings', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 200 then
      raise exception using errcode = '22023', message = 'earnings must contain at most 200 rows';
    end if;
    for v_row in select x.value from pg_catalog.jsonb_array_elements(v_input) x(value)
    loop
      v_amount := pg_catalog.round((v_row.value ->> 'amount')::numeric, 2);
      if v_amount <= 0 then
        raise exception using errcode = '22023', message = 'Payroll earnings must be positive';
      end if;
      v_account_code := coalesce(
        nullif(pg_catalog.upper(pg_catalog.btrim(v_row.value ->> 'account_code')), ''),
        'WAGES_EXPENSE'
      );
      perform private.resolve_account_id(v_account_code, null);
      v_regular := v_regular + v_amount;
      v_line_no := v_line_no + 1;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_no', v_line_no, 'line_kind', 'earning',
          'earning_type', pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_row.value ->> 'type'), ''), 'earning'), 160),
          'description', pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_row.value ->> 'description'), ''), 'Payroll earning'), 300),
          'quantity', nullif(v_row.value ->> 'quantity', '')::numeric,
          'rate', nullif(v_row.value ->> 'rate', '')::numeric,
          'amount', v_amount, 'account_code', v_account_code
        )
      );
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', v_account_code, 'description', 'Payroll earning',
          'debit', v_amount, 'credit', 0
        )
      );
    end loop;

    v_input := coalesce(v_payload -> 'deductions', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 200 then
      raise exception using errcode = '22023', message = 'deductions must contain at most 200 rows';
    end if;
    for v_row in select x.value from pg_catalog.jsonb_array_elements(v_input) x(value)
    loop
      v_amount := pg_catalog.round((v_row.value ->> 'amount')::numeric, 2);
      if v_amount <= 0 then
        raise exception using errcode = '22023', message = 'Payroll deductions must be positive';
      end if;
      v_account_code := coalesce(
        nullif(pg_catalog.upper(pg_catalog.btrim(v_row.value ->> 'account_code')), ''),
        'PAYROLL_DEDUCTIONS_PAYABLE'
      );
      perform private.resolve_account_id(v_account_code, null);
      v_deductions := v_deductions + v_amount;
      v_line_no := v_line_no + 1;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_no', v_line_no, 'line_kind', 'deduction',
          'earning_type', pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_row.value ->> 'type'), ''), 'deduction'), 160),
          'description', pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_row.value ->> 'description'), ''), 'Payroll deduction'), 300),
          'amount', v_amount, 'account_code', v_account_code
        )
      );
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', v_account_code, 'description', 'Payroll deduction payable',
          'debit', 0, 'credit', v_amount
        )
      );
    end loop;

    v_input := coalesce(v_payload -> 'employer_contributions', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 100 then
      raise exception using errcode = '22023', message = 'employer_contributions must contain at most 100 rows';
    end if;
    for v_row in select x.value from pg_catalog.jsonb_array_elements(v_input) x(value)
    loop
      v_amount := pg_catalog.round((v_row.value ->> 'amount')::numeric, 2);
      if v_amount <= 0 then
        raise exception using errcode = '22023', message = 'Employer contributions must be positive';
      end if;
      v_account_code := coalesce(
        nullif(pg_catalog.upper(pg_catalog.btrim(v_row.value ->> 'account_code')), ''),
        'EMPLOYER_CONTRIBUTION_PAYABLE'
      );
      perform private.resolve_account_id(v_account_code, null);
      v_contributions := v_contributions + v_amount;
      v_line_no := v_line_no + 1;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_no', v_line_no, 'line_kind', 'employer_contribution',
          'earning_type', pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_row.value ->> 'type'), ''), 'employer_contribution'), 160),
          'description', pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_row.value ->> 'description'), ''), 'Employer contribution'), 300),
          'amount', v_amount, 'account_code', v_account_code
        )
      );
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', v_account_code, 'description', 'Employer contribution payable',
          'debit', 0, 'credit', v_amount
        )
      );
    end loop;

    v_regular := pg_catalog.round(v_regular, 2);
    v_daily := pg_catalog.round(v_daily, 2);
    v_piecework := pg_catalog.round(v_piecework, 2);
    v_deductions := pg_catalog.round(v_deductions, 2);
    v_contributions := pg_catalog.round(v_contributions, 2);
    v_gross := v_regular + v_daily + v_piecework;
    if v_gross <= 0 or v_deductions > v_gross then
      raise exception using errcode = '23514', message = 'Payroll gross must be positive and deductions cannot exceed gross';
    end if;
    v_net := v_gross - v_deductions;

    -- Manual earnings establish new wages payable. Claimed daily/conversion
    -- earnings were accrued by their source transaction and are not expensed twice.
    if v_regular > 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', 'WAGES_PAYABLE', 'description', 'Manual payroll earnings payable',
          'debit', 0, 'credit', v_regular
        )
      );
    end if;
    if v_deductions > 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', 'WAGES_PAYABLE', 'description', 'Employee deductions withheld',
          'debit', v_deductions, 'credit', 0
        )
      );
    end if;
    if v_contributions > 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', 'EMPLOYER_CONTRIBUTION_EXPENSE',
          'description', 'Employer contribution expense',
          'debit', v_contributions, 'credit', 0
        )
      );
    end if;
    if pg_catalog.jsonb_array_length(v_lines) = 0 then
      -- A claims-only payroll changes claim ownership but not the ledger. The
      -- same-account control pair keeps an immutable payroll journal reference.
      v_lines := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', 'WAGES_PAYABLE', 'description', 'Payroll claim control',
          'debit', v_gross, 'credit', 0
        ),
        pg_catalog.jsonb_build_object(
          'account_code', 'WAGES_PAYABLE', 'description', 'Payroll claim control',
          'debit', 0, 'credit', v_gross
        )
      );
    end if;

    v_journal_id := private.post_journal(
      v_date, 'Payroll ' || v_reference, 'payroll', v_id, v_lines, p_actor
    );
    v_method := nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'payment_method')), '');
    insert into public.payrolls (
      id, reference_no, payroll_date, salary_month, employee_id,
      regular_earnings, daily_wages, piecework_earnings, gross_pay,
      deductions_total, employer_contributions, net_pay, paid_amount,
      payment_method, payment_status, journal_entry_id, replaces_id,
      created_by, updated_by
    ) values (
      v_id, pg_catalog.left(v_reference, 80), v_date, v_payload ->> 'salary_month',
      v_target_id, v_regular, v_daily, v_piecework, v_gross,
      v_deductions, v_contributions, v_net, 0, v_method,
      case when v_net = 0 then 'paid' else 'unpaid' end,
      v_journal_id, nullif(v_payload ->> '_replaces_id', '')::uuid,
      p_actor, p_actor
    );

    insert into public.payroll_details (
      id, payroll_id, line_no, line_kind, earning_type, description,
      quantity, rate, amount, account_id, source_daily_work_id,
      source_conversion_worker_id, source_manual_piecework_id, created_by
    )
    select
      pg_catalog.gen_random_uuid(), v_id, (x.value ->> 'line_no')::smallint,
      x.value ->> 'line_kind', x.value ->> 'earning_type',
      x.value ->> 'description', nullif(x.value ->> 'quantity', '')::numeric,
      nullif(x.value ->> 'rate', '')::numeric, (x.value ->> 'amount')::numeric,
      private.resolve_account_id(x.value ->> 'account_code', null),
      nullif(x.value ->> 'source_daily_work_id', '')::uuid,
      nullif(x.value ->> 'source_conversion_worker_id', '')::uuid,
      nullif(x.value ->> 'source_manual_piecework_id', '')::uuid,
      p_actor
    from pg_catalog.jsonb_array_elements(v_details) x(value);

    if v_payload ->> 'status' = 'paid' and v_net > 0 then
      if private.settlement_account_code(v_method) is null then
        raise exception using errcode = '22023', message = 'Paid payroll requires a cash or bank settlement method';
      end if;
      perform private.perform_operation_v2(
        'payroll_payment.post',
        pg_catalog.jsonb_build_object(
          'payroll_id', v_id, 'payment_date', v_date, 'amount', v_net,
          'method', v_method, 'notes', 'Initial payroll settlement', '_is_initial', true
        ),
        p_actor
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'payroll_payment.post' then
    perform private.assert_permission('payroll.write');
    v_id := pg_catalog.gen_random_uuid();
    v_target_id := (v_payload ->> 'payroll_id')::uuid;
    select * into v_payroll from public.payrolls where id = v_target_id for update;
    if not found or v_payroll.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Posted payroll not found';
    end if;
    v_amount := pg_catalog.round((v_payload ->> 'amount')::numeric, 2);
    if v_amount <= 0 or v_amount > v_payroll.balance_due then
      raise exception using errcode = '23514', message = 'Payroll payment exceeds the outstanding balance';
    end if;
    v_method := pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'method'));
    v_account_code := private.settlement_account_code(v_method);
    if v_account_code is null then
      raise exception using errcode = '22023', message = 'Payroll payment requires a cash or bank settlement method';
    end if;
    v_date := (v_payload ->> 'payment_date')::date;
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''), private.new_reference('PYP')
    );
    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_code', 'WAGES_PAYABLE', 'description', 'Payroll settled',
        'debit', v_amount, 'credit', 0
      ),
      pg_catalog.jsonb_build_object(
        'account_code', v_account_code, 'description', 'Payroll payment',
        'debit', 0, 'credit', v_amount
      )
    );
    v_journal_id := private.post_journal(
      v_date, 'Payroll payment ' || v_reference, 'payroll_payment', v_id, v_lines, p_actor
    );
    insert into public.payroll_payments (
      id, reference_no, payroll_id, payment_date, amount, method, notes,
      is_initial, journal_entry_id, created_by, updated_by
    ) values (
      v_id, pg_catalog.left(v_reference, 80), v_target_id, v_date, v_amount,
      v_method, nullif(pg_catalog.btrim(v_payload ->> 'notes'), ''),
      coalesce((v_payload ->> '_is_initial')::boolean, false),
      v_journal_id, p_actor, p_actor
    );
    perform private.set_payroll_payment_state(
      v_target_id, v_payroll.paid_amount + v_amount, p_actor
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'payroll_payment.reverse' then
    perform private.assert_permission('payroll.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_payroll_payment from public.payroll_payments where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Payroll payment not found';
    end if;
    if v_payroll_payment.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Payroll payment is already reversed';
    end if;
    select * into v_payroll from public.payrolls where id = v_payroll_payment.payroll_id for update;
    if not found or v_payroll.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Posted parent payroll not found';
    end if;
    v_reason := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Payroll payment reversed'
    );
    v_reversal_journal_id := private.reverse_journal(
      v_payroll_payment.journal_entry_id, current_date, p_actor, v_reason
    );
    update public.payroll_payments
    set status = 'reversed', reversal_journal_entry_id = v_reversal_journal_id,
        reversed_at = pg_catalog.clock_timestamp(), reversed_by = p_actor,
        reversal_reason = v_reason, updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    perform private.set_payroll_payment_state(
      v_payroll.id, v_payroll.paid_amount - v_payroll_payment.amount, p_actor
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_payroll_payment.reference_no,
      'idempotent', false, 'reversed', true
    );

  elsif p_operation = 'payroll.reverse' then
    perform private.assert_permission('payroll.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_payroll from public.payrolls where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Payroll not found';
    end if;
    if v_payroll.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Payroll is already reversed';
    end if;
    v_reason := coalesce(nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Payroll reversed');
    for v_row in
      select pp.id
      from public.payroll_payments pp
      where pp.payroll_id = v_id and pp.status = 'posted'
      order by pp.payment_date desc, pp.id desc
    loop
      perform private.perform_operation_v2(
        'payroll_payment.reverse',
        pg_catalog.jsonb_build_object('id', v_row.id, 'reason', v_reason),
        p_actor
      );
    end loop;
    v_reversal_journal_id := private.reverse_journal(
      v_payroll.journal_entry_id, current_date, p_actor, v_reason
    );
    update public.payroll_details set is_active = false where payroll_id = v_id;
    update public.payrolls
    set status = 'reversed', reversal_journal_entry_id = v_reversal_journal_id,
        reversed_at = pg_catalog.clock_timestamp(), reversed_by = p_actor,
        reversal_reason = v_reason, updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_payroll.reference_no, 'idempotent', false, 'reversed', true
    );

  -- Inventory corrections ---------------------------------------------------
  elsif p_operation = 'adjustment.replace' then
    perform private.assert_permission('inventory.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_adjustment from public.stock_adjustments where id = v_target_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Stock adjustment not found';
    end if;
    perform private.perform_operation_v2(
      'adjustment.reverse',
      pg_catalog.jsonb_build_object('id', v_target_id, 'reason', 'Replaced by corrected adjustment'),
      p_actor
    );
    v_payload := coalesce(v_payload -> 'replacement', '{}'::jsonb)
      || pg_catalog.jsonb_build_object('_replaces_id', v_target_id);
    if nullif(v_payload ->> 'reference_no', '') is null
       or v_payload ->> 'reference_no' = v_adjustment.reference_no then
      v_payload := pg_catalog.jsonb_set(
        v_payload, '{reference_no}', pg_catalog.to_jsonb(private.new_reference('ADJ'))
      );
    end if;
    return private.perform_operation_v2('adjustment.post', v_payload, p_actor)
      || pg_catalog.jsonb_build_object('operation', p_operation);

  elsif p_operation = 'adjustment.post' then
    perform private.assert_permission('inventory.write');
    v_id := pg_catalog.gen_random_uuid();
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''), private.new_reference('ADJ')
    );
    v_date := (v_payload ->> 'adjustment_date')::date;
    v_quantity := pg_catalog.round((v_payload ->> 'quantity')::numeric, 6);
    v_amount := pg_catalog.round((v_payload ->> 'value')::numeric, 2);
    v_method := pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'direction'));
    v_reason := pg_catalog.btrim(v_payload ->> 'notes');
    if v_quantity <= 0 or v_amount <= 0 or v_method not in ('positive', 'negative') then
      raise exception using errcode = '22023', message = 'Invalid adjustment quantity, value, or direction';
    end if;
    if nullif(v_reason, '') is null then
      raise exception using errcode = '22023', message = 'An adjustment reason is required';
    end if;
    if nullif(v_payload ->> 'item_id', '') is not null then
      select i.id into v_item_id
      from public.inventory_items i
      where i.id = (v_payload ->> 'item_id')::uuid and i.is_active;
    else
      select pg_catalog.min(i.id), pg_catalog.count(*)::integer
      into v_item_id, v_count
      from public.inventory_items i
      where i.is_active
        and pg_catalog.lower(i.name) = pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'item_name'));
      if v_count > 1 then
        raise exception using errcode = '23514', message = 'Inventory item name is ambiguous; provide item_id';
      end if;
    end if;
    if v_item_id is null then
      raise exception using errcode = 'P0001', message = 'Active inventory item not found';
    end if;
    v_account_code := private.inventory_account_code(v_item_id);
    if v_account_code is null then
      raise exception using errcode = 'P0001', message = 'Inventory account could not be resolved';
    end if;
    perform private.lock_inventory(array[v_item_id]);
    if v_method = 'positive' then
      v_lines := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', v_account_code, 'description', v_reason,
          'debit', v_amount, 'credit', 0
        ),
        pg_catalog.jsonb_build_object(
          'account_code', 'INVENTORY_GAIN', 'description', v_reason,
          'debit', 0, 'credit', v_amount
        )
      );
    else
      v_lines := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'account_code', 'INVENTORY_LOSS', 'description', v_reason,
          'debit', v_amount, 'credit', 0
        ),
        pg_catalog.jsonb_build_object(
          'account_code', v_account_code, 'description', v_reason,
          'debit', 0, 'credit', v_amount
        )
      );
    end if;
    v_journal_id := private.post_journal(
      v_date, 'Stock adjustment ' || v_reference, 'adjustment', v_id, v_lines, p_actor
    );
    insert into public.stock_adjustments (
      id, reference_no, adjustment_date, item_id, direction, quantity,
      value, notes, journal_entry_id, replaces_id, created_by, updated_by
    ) values (
      v_id, pg_catalog.left(v_reference, 80), v_date, v_item_id, v_method,
      v_quantity, v_amount, pg_catalog.left(v_reason, 2000), v_journal_id,
      nullif(v_payload ->> '_replaces_id', '')::uuid, p_actor, p_actor
    );
    perform private.apply_stock(
      v_item_id,
      case when v_method = 'positive' then v_quantity else -v_quantity end,
      case when v_method = 'positive' then v_amount else -v_amount end,
      v_date, 'adjustment', v_id, v_journal_id, v_reason, p_actor
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'adjustment.reverse' then
    perform private.assert_permission('inventory.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_adjustment from public.stock_adjustments where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Stock adjustment not found';
    end if;
    if v_adjustment.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Stock adjustment is already reversed';
    end if;
    perform private.lock_inventory(array[v_adjustment.item_id]);
    v_reason := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Stock adjustment reversed'
    );
    v_reversal_journal_id := private.reverse_journal(
      v_adjustment.journal_entry_id, current_date, p_actor, v_reason
    );
    perform private.apply_stock(
      v_adjustment.item_id,
      case when v_adjustment.direction = 'positive'
        then -v_adjustment.quantity else v_adjustment.quantity end,
      case when v_adjustment.direction = 'positive'
        then -v_adjustment.value else v_adjustment.value end,
      current_date, 'adjustment.reversal', v_id,
      v_reversal_journal_id, v_reason, p_actor
    );
    update public.stock_adjustments
    set status = 'reversed', reversal_journal_entry_id = v_reversal_journal_id,
        reversed_at = pg_catalog.clock_timestamp(), reversed_by = p_actor,
        reversal_reason = v_reason, updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_adjustment.reference_no,
      'idempotent', false, 'reversed', true
    );

  -- Manual journals ---------------------------------------------------------
  elsif p_operation = 'journal.replace' then
    perform private.assert_permission('finance.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_journal from public.journal_entries where id = v_target_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Journal not found';
    end if;
    if v_journal.source_type not in ('manual', 'manual_journal') then
      raise exception using errcode = '42501', message = 'Operational journals must be corrected from their source workspace';
    end if;
    perform private.perform_operation_v2(
      'journal.reverse',
      pg_catalog.jsonb_build_object('id', v_target_id, 'reason', 'Replaced by corrected journal'),
      p_actor
    );
    v_payload := coalesce(v_payload -> 'replacement', '{}'::jsonb);
    if nullif(v_payload ->> 'reference_no', '') is null
       or v_payload ->> 'reference_no' = v_journal.reference_no then
      v_payload := pg_catalog.jsonb_set(
        v_payload, '{reference_no}', pg_catalog.to_jsonb(private.new_reference('JRN'))
      );
    end if;
    return private.perform_operation_v2('journal.post', v_payload, p_actor)
      || pg_catalog.jsonb_build_object('operation', p_operation);

  elsif p_operation = 'journal.post' then
    perform private.assert_permission('finance.write');
    v_id := pg_catalog.gen_random_uuid();
    v_date := (v_payload ->> 'journal_date')::date;
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''), private.new_reference('JRN')
    );
    v_lines := coalesce(v_payload -> 'lines', '[]'::jsonb);
    v_journal_id := private.post_journal(
      v_date, v_payload ->> 'memo', 'manual_journal', v_id,
      v_lines, p_actor, v_reference, null
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_journal_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'journal.reverse' then
    perform private.assert_permission('finance.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_journal from public.journal_entries where id = v_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Journal not found';
    end if;
    if v_journal.source_type not in ('manual', 'manual_journal') then
      raise exception using errcode = '42501', message = 'Operational journals must be reversed from their source workspace';
    end if;
    v_reason := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Manual journal reversed'
    );
    v_reversal_journal_id := private.reverse_journal(
      v_id, current_date, p_actor, v_reason
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_journal.reference_no,
      'idempotent', false, 'reversed', true,
      'reversal_journal_id', v_reversal_journal_id
    );

  else
    raise exception using
      errcode = '22023',
      message = 'Unsupported ERP operation: ' || coalesce(p_operation, '<null>');
  end if;
end;
$function$;

create or replace function private.has_any_permission(p_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
     and exists (
       select 1
       from pg_catalog.unnest(p_permissions) p(code)
       where private.has_permission(p.code)
     );
$function$;

create or replace function private.is_active_erp_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
     and exists (
       select 1 from public.profiles p
       where p.user_id = (select auth.uid()) and p.is_active
     );
$function$;

-- Secure every base table in the exposed public schema. Authenticated clients
-- receive SELECT only; all writes go through the audited RPC above.
do $enable_rls$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles', 'roles', 'permissions', 'user_roles', 'role_permissions',
    'employees', 'piecework_rates', 'inventory_items', 'accounts',
    'journal_entries', 'journal_lines', 'raw_material_purchases',
    'conversions', 'conversion_workers', 'daily_work',
    'daily_work_piecework', 'daily_work_conversion_links', 'production_runs',
    'sales', 'sale_items', 'sale_payments', 'payrolls', 'payroll_details',
    'payroll_payments', 'stock_adjustments', 'inventory_balances',
    'stock_movements', 'audit_log', 'idempotency_keys'
  ]
  loop
    execute pg_catalog.format('alter table public.%I enable row level security', v_table);
    execute pg_catalog.format('revoke all on table public.%I from anon, authenticated', v_table);
  end loop;
end;
$enable_rls$;

grant usage on schema public to authenticated;
grant select on table
  public.profiles, public.roles, public.permissions, public.user_roles,
  public.role_permissions, public.employees, public.piecework_rates,
  public.inventory_items, public.accounts, public.journal_entries,
  public.journal_lines, public.raw_material_purchases, public.conversions,
  public.conversion_workers, public.daily_work, public.daily_work_piecework,
  public.daily_work_conversion_links, public.production_runs, public.sales,
  public.sale_items, public.sale_payments, public.payrolls,
  public.payroll_details, public.payroll_payments, public.stock_adjustments,
  public.inventory_balances, public.stock_movements, public.audit_log
to authenticated;

drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles
for select to authenticated
using ((select auth.uid()) = user_id and is_active);

drop policy if exists user_roles_read_self on public.user_roles;
create policy user_roles_read_self on public.user_roles
for select to authenticated
using ((select auth.uid()) = user_id and (select private.is_active_erp_user()));

drop policy if exists roles_read_active_user on public.roles;
create policy roles_read_active_user on public.roles
for select to authenticated
using ((select private.is_active_erp_user()));

drop policy if exists permissions_read_active_user on public.permissions;
create policy permissions_read_active_user on public.permissions
for select to authenticated
using ((select private.is_active_erp_user()));

drop policy if exists role_permissions_read_active_user on public.role_permissions;
create policy role_permissions_read_active_user on public.role_permissions
for select to authenticated
using ((select private.is_active_erp_user()));

do $read_policies$
declare
  v_table text;
begin
  foreach v_table in array array['employees', 'piecework_rates']
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using ((select private.has_any_permission(array['
      || quote_literal('employees.read') || ',' || quote_literal('payroll.read') || ','
      || quote_literal('production.read') || ']::text[])))',
      v_table
    );
  end loop;

  foreach v_table in array array[
    'inventory_items', 'inventory_balances', 'stock_movements',
    'raw_material_purchases', 'conversions', 'production_runs', 'stock_adjustments'
  ]
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using ((select private.has_any_permission(array['
      || quote_literal('inventory.read') || ',' || quote_literal('production.read') || ','
      || quote_literal('sales.read') || ',' || quote_literal('reports.read') || ','
      || quote_literal('dashboard.read') || ']::text[])))',
      v_table
    );
  end loop;

  foreach v_table in array array['conversion_workers']
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using ((select private.has_any_permission(array['
      || quote_literal('inventory.read') || ',' || quote_literal('production.read') || ','
      || quote_literal('employees.read') || ',' || quote_literal('payroll.read')
      || ']::text[])))', v_table
    );
  end loop;

  foreach v_table in array array['daily_work', 'daily_work_piecework', 'daily_work_conversion_links']
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using ((select private.has_any_permission(array['
      || quote_literal('employees.read') || ',' || quote_literal('payroll.read') || ','
      || quote_literal('reports.read') || ']::text[])))', v_table
    );
  end loop;

  foreach v_table in array array['sales', 'sale_items', 'sale_payments']
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using ((select private.has_any_permission(array['
      || quote_literal('sales.read') || ',' || quote_literal('reports.read') || ','
      || quote_literal('dashboard.read') || ',' || quote_literal('finance.read')
      || ']::text[])))', v_table
    );
  end loop;

  foreach v_table in array array['payrolls', 'payroll_details', 'payroll_payments']
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using ((select private.has_any_permission(array['
      || quote_literal('payroll.read') || ',' || quote_literal('reports.read') || ','
      || quote_literal('dashboard.read') || ',' || quote_literal('finance.read')
      || ']::text[])))', v_table
    );
  end loop;

  foreach v_table in array array['accounts', 'journal_entries', 'journal_lines']
  loop
    execute pg_catalog.format('drop policy if exists erp_read on public.%I', v_table);
    execute pg_catalog.format(
      'create policy erp_read on public.%I for select to authenticated '
      || 'using ((select private.has_any_permission(array['
      || quote_literal('finance.read') || ',' || quote_literal('reports.read') || ','
      || quote_literal('dashboard.read') || ']::text[])))', v_table
    );
  end loop;
end;
$read_policies$;

drop policy if exists audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log
for select to authenticated
using ((select private.has_permission('audit.read')));

-- Views have security_invoker=true, so the table policies above remain in
-- force. Expose only the explicit read models used by the Python API.
revoke all on table
  public.current_user_access, public.inventory_position,
  public.inventory_stage_summary, public.production_daily_summary,
  public.account_balances, public.account_balances_by_year,
  public.employee_open_earnings, public.sales_outstanding,
  public.payroll_outstanding, public.ledger_view
from anon, authenticated;
grant select on table
  public.current_user_access, public.inventory_position,
  public.inventory_stage_summary, public.production_daily_summary,
  public.account_balances, public.account_balances_by_year,
  public.employee_open_earnings, public.sales_outstanding,
  public.payroll_outstanding, public.ledger_view
to authenticated;

-- Remove default function execution, then publish only the two RPC endpoints
-- and the boolean helpers required by RLS evaluation.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.has_permission(text) to authenticated;
grant execute on function private.has_any_permission(text[]) to authenticated;
grant execute on function private.is_active_erp_user() to authenticated;

revoke all on function public.erp_execute(text, jsonb, text) from public, anon, authenticated;
revoke all on function public.erp_dashboard(integer) from public, anon, authenticated;
grant execute on function public.erp_execute(text, jsonb, text) to authenticated;
grant execute on function public.erp_dashboard(integer) to authenticated;

commit;
