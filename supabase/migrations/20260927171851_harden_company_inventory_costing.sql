-- Cost inventory from the owning legal company, add explicit ownership
-- transfers, and prevent pooled physical stock from contaminating either set
-- of books.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

drop index if exists public.sales_invoice_no_posted_idx;
create unique index sales_company_invoice_no_posted_idx
  on public.sales (company_id, invoice_no)
  where status = 'posted';

create table public.inventory_ownership_transfers (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  reference_no text not null unique,
  transfer_date date not null,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  from_company_id uuid not null references public.companies(id) on delete restrict,
  to_company_id uuid not null references public.companies(id) on delete restrict,
  quantity numeric(20,6) not null,
  value numeric(20,2) not null,
  notes text not null,
  from_journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  to_journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint inventory_transfer_distinct_companies check (from_company_id <> to_company_id),
  constraint inventory_transfer_quantity_positive check (
    quantity > 0 and quantity::text not in ('NaN','Infinity','-Infinity')
  ),
  constraint inventory_transfer_value_positive check (
    value > 0 and value::text not in ('NaN','Infinity','-Infinity')
  ),
  constraint inventory_transfer_notes_not_blank check (pg_catalog.btrim(notes) <> '')
);

create index inventory_transfers_from_date_idx
  on public.inventory_ownership_transfers (from_company_id, transfer_date desc, id desc);
create index inventory_transfers_to_date_idx
  on public.inventory_ownership_transfers (to_company_id, transfer_date desc, id desc);
create index inventory_transfers_item_date_idx
  on public.inventory_ownership_transfers (item_id, transfer_date desc, id desc);

create trigger inventory_transfers_rpc_guard
before insert or update or delete on public.inventory_ownership_transfers
for each row execute function private.require_rpc_guard();
create trigger inventory_transfers_append_only
before update or delete on public.inventory_ownership_transfers
for each row execute function private.reject_row_rewrite();

alter table public.inventory_ownership_transfers enable row level security;
revoke all on table public.inventory_ownership_transfers from public, anon, authenticated;
grant select on table public.inventory_ownership_transfers to authenticated;
create policy inventory_transfers_read on public.inventory_ownership_transfers
for select to authenticated
using (
  private.has_company_any_permission(
    from_company_id,
    array['inventory.read','finance.read','reports.read']::text[]
  )
  or private.has_company_any_permission(
    to_company_id,
    array['inventory.read','finance.read','reports.read']::text[]
  )
);

create or replace function private.post_company_conversion(
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
  v_company_id uuid := private.current_company_id();
  v_id uuid := pg_catalog.gen_random_uuid();
  v_reference text;
  v_date date;
  v_source_item_id uuid;
  v_output_item_id uuid;
  v_type_id uuid;
  v_input numeric(20,6);
  v_output numeric(20,6);
  v_material_cost numeric(20,2);
  v_labor_cost numeric(20,2) := 0;
  v_overhead numeric(20,2);
  v_total numeric(20,2);
  v_lines jsonb;
  v_workers jsonb;
  v_worker jsonb;
  v_journal_id uuid;
begin
  perform private.assert_permission('inventory.write');
  v_reference := coalesce(
    nullif(pg_catalog.btrim(p_payload ->> 'reference_no'), ''),
    private.new_reference('CNV')
  );
  v_date := (p_payload ->> 'conversion_date')::date;
  perform private.assert_open_period(v_company_id, v_date);
  v_input := pg_catalog.round((p_payload ->> 'input_kg')::numeric, 6);
  v_output := pg_catalog.round((p_payload ->> 'output_kg')::numeric, 6);
  v_overhead := pg_catalog.round(
    coalesce(nullif(p_payload ->> 'overhead_cost', '')::numeric, 0), 2
  );
  if v_input::text in ('NaN','Infinity','-Infinity')
     or v_output::text in ('NaN','Infinity','-Infinity')
     or v_overhead::text in ('NaN','Infinity','-Infinity')
     or v_input <= 0 or v_output <= 0 or v_output > v_input * 1.02
     or v_overhead < 0 then
    raise exception using errcode = '22023', message = 'Invalid conversion quantities or overhead';
  end if;

  v_source_item_id := private.resolve_inventory_item(
    p_payload ->> 'source_item_id', p_payload ->> 'source_material_name', 'bulk', p_actor
  );
  v_output_item_id := private.resolve_inventory_item(
    p_payload ->> 'output_item_id', p_payload ->> 'chip_name', 'chip', p_actor
  );
  if v_source_item_id = v_output_item_id then
    raise exception using errcode = '22023', message = 'Conversion input and output must differ';
  end if;

  if nullif(p_payload ->> 'conversion_type_id', '') is not null then
    v_type_id := (p_payload ->> 'conversion_type_id')::uuid;
    perform 1 from public.conversion_types ct
    where ct.id = v_type_id and ct.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active conversion type not found';
    end if;
  end if;

  v_workers := coalesce(p_payload -> 'workers', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_workers) <> 'array'
     or pg_catalog.jsonb_array_length(v_workers) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Conversion requires 1 to 100 workers';
  end if;
  for v_worker in select x.value from pg_catalog.jsonb_array_elements(v_workers) x(value)
  loop
    perform 1 from public.employees e
    where e.id = (v_worker ->> 'employee_id')::uuid
      and e.company_id = v_company_id and e.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Conversion worker is not active in this company';
    end if;
    if nullif(v_worker ->> 'rate_id', '') is not null then
      perform 1
      from public.piecework_rates pr
      where pr.id = (v_worker ->> 'rate_id')::uuid
        and pr.status = 'active'
        and v_date between pr.effective_from and coalesce(pr.effective_to, v_date)
        and pg_catalog.round(pr.rate_per_kg, 6)
            = pg_catalog.round((v_worker ->> 'rate_per_kg')::numeric, 6)
        and (v_type_id is null or pr.conversion_type_id is null
             or pr.conversion_type_id = v_type_id);
      if not found then
        raise exception using errcode = '23514', message = 'Selected piecework rate is invalid for this conversion';
      end if;
    end if;
    if (v_worker ->> 'quantity_kg')::numeric <= 0
       or (v_worker ->> 'rate_per_kg')::numeric <= 0 then
      raise exception using errcode = '22023', message = 'Worker quantity and rate must be positive';
    end if;
    v_labor_cost := v_labor_cost + pg_catalog.round(
      (v_worker ->> 'quantity_kg')::numeric
        * (v_worker ->> 'rate_per_kg')::numeric,
      2
    );
  end loop;
  if v_labor_cost <= 0 then
    raise exception using errcode = '22023', message = 'Conversion labor must be positive';
  end if;

  perform private.lock_inventory(array[v_source_item_id, v_output_item_id]);
  perform private.lock_company_inventory(
    v_company_id, array[v_source_item_id, v_output_item_id]
  );
  v_material_cost := private.company_inventory_cost(
    v_company_id, v_source_item_id, v_input
  );
  if v_material_cost <= 0 then
    raise exception using errcode = 'P0001', message = 'Company bulk inventory has no usable cost';
  end if;
  v_total := pg_catalog.round(v_material_cost + v_labor_cost + v_overhead, 2);

  v_lines := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'account_code','CHIP_INVENTORY','description','Converted chip received',
      'debit',v_total,'credit',0
    ),
    pg_catalog.jsonb_build_object(
      'account_code','RAW_MATERIAL_INVENTORY','description','Bulk material consumed',
      'debit',0,'credit',v_material_cost
    ),
    pg_catalog.jsonb_build_object(
      'account_code','WAGES_PAYABLE','description','Conversion piecework payable',
      'debit',0,'credit',v_labor_cost
    )
  );
  if v_overhead > 0 then
    v_lines := v_lines || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_code','OVERHEAD_PAYABLE','description','Conversion overhead',
        'debit',0,'credit',v_overhead
      )
    );
  end if;
  v_journal_id := private.post_journal(
    v_date, 'Conversion ' || v_reference, 'conversion', v_id,
    v_lines, p_actor
  );

  insert into public.conversions (
    id, reference_no, conversion_date, conversion_type_id,
    source_item_id, output_item_id, chip_type, input_kg, output_kg,
    material_cost, labor_cost, overhead_cost, total_converted_cost,
    journal_entry_id, replaces_id, created_by, updated_by
  ) values (
    v_id, pg_catalog.left(v_reference,80), v_date, v_type_id,
    v_source_item_id, v_output_item_id,
    nullif(pg_catalog.btrim(p_payload ->> 'chip_type'),''),
    v_input, v_output, v_material_cost, v_labor_cost, v_overhead, v_total,
    v_journal_id, nullif(p_payload ->> '_replaces_id','')::uuid,
    p_actor, p_actor
  );

  insert into public.conversion_workers (
    id, conversion_id, employee_id, rate_id, work_date, task,
    quantity_kg, rate_per_kg, amount, created_by
  )
  select
    pg_catalog.gen_random_uuid(), v_id, (x.value ->> 'employee_id')::uuid,
    nullif(x.value ->> 'rate_id','')::uuid, v_date,
    pg_catalog.left(pg_catalog.btrim(x.value ->> 'task'),160),
    pg_catalog.round((x.value ->> 'quantity_kg')::numeric,6),
    pg_catalog.round((x.value ->> 'rate_per_kg')::numeric,6),
    pg_catalog.round(
      (x.value ->> 'quantity_kg')::numeric
        * (x.value ->> 'rate_per_kg')::numeric,
      2
    ),
    p_actor
  from pg_catalog.jsonb_array_elements(v_workers) x(value);

  perform private.apply_stock(
    v_source_item_id, -v_input, -v_material_cost, v_date,
    'conversion', v_id, v_journal_id, 'Bulk material consumed', p_actor
  );
  perform private.apply_stock(
    v_output_item_id, v_output, v_total, v_date,
    'conversion', v_id, v_journal_id, 'Converted chip received', p_actor
  );
  return pg_catalog.jsonb_build_object(
    'ok',true,'operation','conversion.post','id',v_id,
    'reference_no',v_reference,'idempotent',false
  );
end;
$function$;

create or replace function private.post_company_production(
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
  v_company_id uuid := private.current_company_id();
  v_id uuid := pg_catalog.gen_random_uuid();
  v_reference text;
  v_date date;
  v_chip_item_id uuid;
  v_finished_item_id uuid;
  v_operator_id uuid;
  v_input numeric(20,6);
  v_output numeric(20,6);
  v_material_cost numeric(20,2);
  v_overhead numeric(20,2);
  v_total numeric(20,2);
  v_lines jsonb;
  v_journal_id uuid;
begin
  perform private.assert_permission('production.write');
  v_reference := coalesce(
    nullif(pg_catalog.btrim(p_payload ->> 'reference_no'),''),
    private.new_reference('PRD')
  );
  v_date := (p_payload ->> 'production_date')::date;
  perform private.assert_open_period(v_company_id, v_date);
  v_input := pg_catalog.round((p_payload ->> 'input_kg')::numeric,6);
  v_output := pg_catalog.round((p_payload ->> 'output_quantity')::numeric,6);
  v_overhead := pg_catalog.round(
    coalesce(nullif(p_payload ->> 'overhead_cost','')::numeric,0),2
  );
  if v_input::text in ('NaN','Infinity','-Infinity')
     or v_output::text in ('NaN','Infinity','-Infinity')
     or v_overhead::text in ('NaN','Infinity','-Infinity')
     or v_input <= 0 or v_output <= 0 or v_overhead < 0 then
    raise exception using errcode = '22023', message = 'Invalid production quantities or overhead';
  end if;

  v_chip_item_id := private.resolve_inventory_item(
    p_payload ->> 'chip_item_id', p_payload ->> 'chip_name', 'chip', p_actor
  );
  v_finished_item_id := private.resolve_inventory_item(
    p_payload ->> 'finished_item_id', p_payload ->> 'finished_item_name', 'finished', p_actor
  );
  if v_chip_item_id = v_finished_item_id then
    raise exception using errcode = '22023', message = 'Production input and output must differ';
  end if;
  v_operator_id := (p_payload ->> 'operator_employee_id')::uuid;
  perform 1 from public.employees e
  where e.id = v_operator_id and e.company_id = v_company_id and e.status = 'active';
  if not found then
    raise exception using errcode = 'P0001', message = 'Active production operator not found in this company';
  end if;

  perform private.lock_inventory(array[v_chip_item_id,v_finished_item_id]);
  perform private.lock_company_inventory(
    v_company_id, array[v_chip_item_id,v_finished_item_id]
  );
  v_material_cost := private.company_inventory_cost(
    v_company_id, v_chip_item_id, v_input
  );
  if v_material_cost <= 0 then
    raise exception using errcode = 'P0001', message = 'Company chip inventory has no usable cost';
  end if;
  v_total := pg_catalog.round(v_material_cost + v_overhead,2);
  v_lines := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'account_code','FINISHED_GOODS_INVENTORY','description','Finished goods received',
      'debit',v_total,'credit',0
    ),
    pg_catalog.jsonb_build_object(
      'account_code','CHIP_INVENTORY','description','Chip material consumed',
      'debit',0,'credit',v_material_cost
    )
  );
  if v_overhead > 0 then
    v_lines := v_lines || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_code','OVERHEAD_PAYABLE','description','Production overhead',
        'debit',0,'credit',v_overhead
      )
    );
  end if;
  v_journal_id := private.post_journal(
    v_date,'Production ' || v_reference,'production',v_id,v_lines,p_actor
  );
  insert into public.production_runs (
    id,reference_no,production_date,shift,machine,operator_employee_id,
    chip_item_id,finished_item_id,input_kg,output_quantity,working_hours,
    material_cost,overhead_cost,total_cost,notes,journal_entry_id,
    replaces_id,created_by,updated_by
  ) values (
    v_id,pg_catalog.left(v_reference,80),v_date,
    nullif(pg_catalog.btrim(p_payload ->> 'shift'),''),
    nullif(pg_catalog.btrim(p_payload ->> 'machine'),''),
    v_operator_id,v_chip_item_id,v_finished_item_id,v_input,v_output,
    pg_catalog.round(coalesce(nullif(p_payload ->> 'working_hours','')::numeric,0),4),
    v_material_cost,v_overhead,v_total,
    nullif(pg_catalog.btrim(p_payload ->> 'notes'),''),v_journal_id,
    nullif(p_payload ->> '_replaces_id','')::uuid,p_actor,p_actor
  );
  perform private.apply_stock(
    v_chip_item_id,-v_input,-v_material_cost,v_date,'production',v_id,
    v_journal_id,'Chip material consumed',p_actor
  );
  perform private.apply_stock(
    v_finished_item_id,v_output,v_total,v_date,'production',v_id,
    v_journal_id,'Finished goods received',p_actor
  );
  return pg_catalog.jsonb_build_object(
    'ok',true,'operation','production.post','id',v_id,
    'reference_no',v_reference,'idempotent',false
  );
end;
$function$;

create or replace function private.post_company_sale(
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
  v_company_id uuid := private.current_company_id();
  v_id uuid := pg_catalog.gen_random_uuid();
  v_reference text;
  v_date date;
  v_method text;
  v_input jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_row record;
  v_item_ids uuid[] := array[]::uuid[];
  v_item_id uuid;
  v_quantity numeric(20,6);
  v_unit_price numeric(20,6);
  v_discount numeric(20,2);
  v_line_total numeric(20,2);
  v_line_cogs numeric(20,2);
  v_unit_cost numeric(20,6);
  v_total numeric(20,2) := 0;
  v_cogs numeric(20,2) := 0;
  v_paid numeric(20,2);
  v_lines jsonb;
  v_journal_id uuid;
begin
  perform private.assert_permission('sales.write');
  v_reference := coalesce(
    nullif(pg_catalog.btrim(p_payload ->> 'reference_no'),''),
    private.new_reference('SAL')
  );
  v_date := (p_payload ->> 'sale_date')::date;
  perform private.assert_open_period(v_company_id, v_date);
  v_method := pg_catalog.lower(pg_catalog.btrim(p_payload ->> 'payment_method'));
  v_input := coalesce(p_payload -> 'items','[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_input) <> 'array'
     or pg_catalog.jsonb_array_length(v_input) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'A sale requires between 1 and 500 items';
  end if;

  for v_row in select x.value from pg_catalog.jsonb_array_elements(v_input) x(value)
  loop
    v_item_id := private.resolve_inventory_item(
      v_row.value ->> 'item_id', v_row.value ->> 'item_name', 'finished', p_actor
    );
    if pg_catalog.array_position(v_item_ids, v_item_id) is not null then
      raise exception using errcode = '23514', message = 'A sale cannot contain the same item twice';
    end if;
    v_item_ids := pg_catalog.array_append(v_item_ids, v_item_id);
    v_rows := v_rows || pg_catalog.jsonb_build_array(
      v_row.value || pg_catalog.jsonb_build_object('_item_id',v_item_id)
    );
  end loop;
  perform private.lock_inventory(v_item_ids);
  perform private.lock_company_inventory(v_company_id,v_item_ids);

  for v_row in select x.value from pg_catalog.jsonb_array_elements(v_rows) x(value)
  loop
    v_item_id := (v_row.value ->> '_item_id')::uuid;
    v_quantity := pg_catalog.round((v_row.value ->> 'quantity')::numeric,6);
    v_unit_price := pg_catalog.round((v_row.value ->> 'unit_price')::numeric,6);
    v_discount := pg_catalog.round(
      coalesce(nullif(v_row.value ->> 'discount','')::numeric,0),2
    );
    if v_quantity::text in ('NaN','Infinity','-Infinity')
       or v_unit_price::text in ('NaN','Infinity','-Infinity')
       or v_discount::text in ('NaN','Infinity','-Infinity')
       or v_quantity <= 0 or v_unit_price <= 0 or v_discount < 0 then
      raise exception using errcode = '22023', message = 'Invalid sale item quantity, price, or discount';
    end if;
    v_line_total := pg_catalog.round(v_quantity * v_unit_price - v_discount,2);
    if v_line_total <= 0 then
      raise exception using errcode = '23514', message = 'Sale line total must be positive';
    end if;
    v_line_cogs := private.company_inventory_cost(
      v_company_id,v_item_id,v_quantity
    );
    if v_line_cogs <= 0 then
      raise exception using errcode = 'P0001', message = 'Company finished inventory has no usable cost';
    end if;
    v_unit_cost := pg_catalog.round(v_line_cogs / v_quantity,6);
    v_total := v_total + v_line_total;
    v_cogs := v_cogs + v_line_cogs;
    v_normalized := v_normalized || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'item_id',v_item_id,'quantity',v_quantity,'unit_price',v_unit_price,
        'discount',v_discount,'line_total',v_line_total,
        'unit_cost',v_unit_cost,'line_cogs',v_line_cogs
      )
    );
  end loop;
  v_total := pg_catalog.round(v_total,2);
  v_cogs := pg_catalog.round(v_cogs,2);
  v_paid := pg_catalog.round(
    coalesce(nullif(p_payload ->> 'amount_paid','')::numeric,0),2
  );
  if v_paid::text in ('NaN','Infinity','-Infinity')
     or v_paid < 0 or v_paid > v_total then
    raise exception using errcode = '23514', message = 'Initial payment exceeds the invoice total';
  end if;
  if v_paid > 0 and private.settlement_account_code(v_method) is null then
    raise exception using errcode = '22023', message = 'Initial payment requires a cash or bank method';
  end if;

  v_lines := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'account_code','ACCOUNTS_RECEIVABLE','description','Customer invoice',
      'debit',v_total,'credit',0
    ),
    pg_catalog.jsonb_build_object(
      'account_code','SALES_REVENUE','description','Sales revenue',
      'debit',0,'credit',v_total
    ),
    pg_catalog.jsonb_build_object(
      'account_code','COGS','description','Cost of goods sold',
      'debit',v_cogs,'credit',0
    ),
    pg_catalog.jsonb_build_object(
      'account_code','FINISHED_GOODS_INVENTORY','description','Finished goods issued',
      'debit',0,'credit',v_cogs
    )
  );
  v_journal_id := private.post_journal(
    v_date,'Sale ' || v_reference,'sale',v_id,v_lines,p_actor
  );

  insert into public.sales (
    id,reference_no,invoice_no,sale_date,customer_name,customer_phone,
    payment_method,total_amount,total_cogs,paid_amount,payment_status,
    journal_entry_id,replaces_id,created_by,updated_by
  ) values (
    v_id,pg_catalog.left(v_reference,80),
    pg_catalog.left(pg_catalog.btrim(p_payload ->> 'invoice_no'),80),v_date,
    pg_catalog.left(pg_catalog.btrim(p_payload ->> 'customer_name'),160),
    nullif(pg_catalog.btrim(p_payload ->> 'customer_phone'),''),v_method,
    v_total,v_cogs,0,'unpaid',v_journal_id,
    nullif(p_payload ->> '_replaces_id','')::uuid,p_actor,p_actor
  );

  insert into public.sale_items (
    id,sale_id,item_id,quantity,unit_price,discount,line_total,
    unit_cost,line_cogs,created_by
  )
  select
    pg_catalog.gen_random_uuid(),v_id,(x.value ->> 'item_id')::uuid,
    (x.value ->> 'quantity')::numeric,(x.value ->> 'unit_price')::numeric,
    (x.value ->> 'discount')::numeric,(x.value ->> 'line_total')::numeric,
    (x.value ->> 'unit_cost')::numeric,(x.value ->> 'line_cogs')::numeric,p_actor
  from pg_catalog.jsonb_array_elements(v_normalized) x(value);

  for v_row in select x.value from pg_catalog.jsonb_array_elements(v_normalized) x(value)
  loop
    perform private.apply_stock(
      (v_row.value ->> 'item_id')::uuid,
      -(v_row.value ->> 'quantity')::numeric,
      -(v_row.value ->> 'line_cogs')::numeric,
      v_date,'sale',v_id,v_journal_id,'Finished goods sold',p_actor
    );
  end loop;

  if v_paid > 0 then
    perform private.perform_operation_v2(
      'sale_payment.post',
      pg_catalog.jsonb_build_object(
        'sale_id',v_id,'payment_date',v_date,'amount',v_paid,
        'method',v_method,'notes','Initial invoice payment','_is_initial',true
      ),
      p_actor
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok',true,'operation','sale.post','id',v_id,
    'reference_no',v_reference,'idempotent',false
  );
end;
$function$;

create or replace function private.transfer_inventory_ownership(
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
  v_from_company uuid := private.current_company_id();
  v_to_company uuid := (p_payload ->> 'to_company_id')::uuid;
  v_item_id uuid := (p_payload ->> 'item_id')::uuid;
  v_quantity numeric(20,6) := pg_catalog.round((p_payload ->> 'quantity')::numeric,6);
  v_value numeric(20,2);
  v_date date := (p_payload ->> 'transfer_date')::date;
  v_notes text := pg_catalog.btrim(p_payload ->> 'notes');
  v_id uuid := pg_catalog.gen_random_uuid();
  v_reference text := coalesce(
    nullif(pg_catalog.btrim(p_payload ->> 'reference_no'),''),
    private.new_reference('ITR')
  );
  v_inventory_code text;
  v_from_journal uuid;
  v_to_journal uuid;
begin
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_actor and p.is_active and p.is_super_admin
  ) then
    raise exception using errcode = '42501', message = 'Only the group super administrator can transfer stock ownership';
  end if;
  if v_from_company = v_to_company or not private.can_access_company(v_to_company) then
    raise exception using errcode = '22023', message = 'A different assigned destination company is required';
  end if;
  if v_quantity::text in ('NaN','Infinity','-Infinity') or v_quantity <= 0 then
    raise exception using errcode = '22023', message = 'Transfer quantity must be finite and positive';
  end if;
  if nullif(v_notes,'') is null then
    raise exception using errcode = '22023', message = 'Transfer notes are required';
  end if;
  perform private.assert_open_period(v_from_company,v_date);
  perform private.assert_open_period(v_to_company,v_date);
  perform 1 from public.inventory_items i where i.id = v_item_id and i.is_active;
  if not found then
    raise exception using errcode = 'P0001', message = 'Active inventory item not found';
  end if;
  v_inventory_code := private.inventory_account_code(v_item_id);

  -- Serialize ownership transfers for one item, then lock company rows in a
  -- deterministic company order to avoid opposite-direction deadlocks.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-owner:' || v_item_id::text,0)
  );
  perform private.lock_company_inventory(v_from_company,array[v_item_id]);
  perform private.lock_company_inventory(v_to_company,array[v_item_id]);
  perform b.company_id
  from public.company_inventory_balances b
  where b.item_id = v_item_id and b.company_id in (v_from_company,v_to_company)
  order by b.company_id
  for update;
  v_value := private.company_inventory_cost(v_from_company,v_item_id,v_quantity);

  v_from_journal := private.post_journal(
    v_date,'Inventory ownership transfer ' || v_reference,
    'inventory_transfer_out',v_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_code','INTERCOMPANY_DUE_FROM','description',v_notes,
        'debit',v_value,'credit',0
      ),
      pg_catalog.jsonb_build_object(
        'account_code',v_inventory_code,'description',v_notes,
        'debit',0,'credit',v_value
      )
    ),p_actor
  );

  update public.company_inventory_balances
  set quantity_on_hand = pg_catalog.round(quantity_on_hand - v_quantity,6),
      inventory_value = pg_catalog.round(inventory_value - v_value,2),
      last_movement_date = v_date,
      last_movement_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where company_id = v_from_company and item_id = v_item_id;

  perform pg_catalog.set_config('app.current_company_id',v_to_company::text,true);
  v_to_journal := private.post_journal(
    v_date,'Inventory ownership transfer ' || v_reference,
    'inventory_transfer_in',v_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_code',v_inventory_code,'description',v_notes,
        'debit',v_value,'credit',0
      ),
      pg_catalog.jsonb_build_object(
        'account_code','INTERCOMPANY_DUE_TO','description',v_notes,
        'debit',0,'credit',v_value
      )
    ),p_actor
  );
  update public.company_inventory_balances
  set quantity_on_hand = pg_catalog.round(quantity_on_hand + v_quantity,6),
      inventory_value = pg_catalog.round(inventory_value + v_value,2),
      last_movement_date = v_date,
      last_movement_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where company_id = v_to_company and item_id = v_item_id;
  perform pg_catalog.set_config('app.current_company_id',v_from_company::text,true);

  insert into public.inventory_ownership_transfers (
    id,reference_no,transfer_date,item_id,from_company_id,to_company_id,
    quantity,value,notes,from_journal_entry_id,to_journal_entry_id,created_by
  ) values (
    v_id,pg_catalog.left(v_reference,80),v_date,v_item_id,
    v_from_company,v_to_company,v_quantity,v_value,
    pg_catalog.left(v_notes,1000),v_from_journal,v_to_journal,p_actor
  );
  return pg_catalog.jsonb_build_object(
    'ok',true,'operation','inventory.transfer','id',v_id,
    'reference_no',v_reference,'value',v_value,'idempotent',false
  );
end;
$function$;

notify pgrst, 'reload schema';

commit;
