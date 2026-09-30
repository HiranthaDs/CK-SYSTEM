-- Store a reusable catalogue selling price on finished products. Production
-- remains responsible for cost; sales records the actual (editable) price.

alter table public.inventory_items
  add column selling_price numeric(20,2) not null default 0;

alter table public.inventory_items
  add constraint inventory_items_selling_price_valid check (
    selling_price >= 0
    and selling_price::text not in ('NaN', 'Infinity', '-Infinity')
  );

create or replace view public.inventory_position
with (security_invoker = true)
as
select
  i.id as item_id,
  i.sku,
  i.name as item_name,
  i.stage,
  i.unit,
  coalesce(b.quantity_on_hand, 0::numeric)::numeric(20,6) as quantity_on_hand,
  coalesce(b.inventory_value, 0::numeric)::numeric(20,2) as inventory_value,
  case when coalesce(b.quantity_on_hand, 0) = 0 then 0::numeric
       else pg_catalog.round(b.inventory_value / b.quantity_on_hand, 6)
  end::numeric(20,6) as average_unit_cost,
  b.last_movement_at,
  i.is_active,
  i.selling_price
from public.inventory_items i
left join public.inventory_balances b on b.item_id = i.id;

create or replace view public.company_inventory_position
with (security_invoker = true)
as
select
  c.id as company_id,
  i.id as item_id,
  i.sku,
  i.name as item_name,
  i.stage,
  i.unit,
  coalesce(cb.quantity_on_hand, 0::numeric)::numeric(20,6) as quantity_on_hand,
  coalesce(b.quantity_on_hand, 0::numeric)::numeric(20,6) as shared_quantity_on_hand,
  coalesce(cb.inventory_value, 0::numeric)::numeric(20,2) as inventory_value,
  case
    when coalesce(cb.quantity_on_hand, 0) = 0 then 0::numeric
    else pg_catalog.round(cb.inventory_value / cb.quantity_on_hand, 6)
  end::numeric(20,6) as average_unit_cost,
  cb.last_movement_at,
  b.last_movement_at as shared_last_movement_at,
  i.is_active,
  i.selling_price
from public.companies c
cross join public.inventory_items i
left join public.company_inventory_balances cb
  on cb.company_id = c.id and cb.item_id = i.id
left join public.inventory_balances b on b.item_id = i.id
where c.is_active;

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
  v_selling_price numeric(20,2);
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
  v_selling_price := pg_catalog.round(
    nullif(p_payload ->> 'selling_price','')::numeric,2
  );
  v_overhead := pg_catalog.round(
    coalesce(nullif(p_payload ->> 'overhead_cost','')::numeric,0),2
  );
  if v_input::text in ('NaN','Infinity','-Infinity')
     or v_output::text in ('NaN','Infinity','-Infinity')
     or v_overhead::text in ('NaN','Infinity','-Infinity')
     or v_input <= 0 or v_output <= 0 or v_overhead < 0 then
    raise exception using errcode = '22023', message = 'Invalid production quantities or overhead';
  end if;
  if v_selling_price is not null and (
    v_selling_price::text in ('NaN','Infinity','-Infinity') or v_selling_price <= 0
  ) then
    raise exception using errcode = '22023', message = 'Selling price must be greater than zero';
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
  if v_selling_price is not null then
    update public.inventory_items
    set selling_price = v_selling_price,
        updated_at = pg_catalog.now(),
        updated_by = p_actor
    where id = v_finished_item_id;
  end if;
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
