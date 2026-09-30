-- Company portals display each legal entity's stock ownership while also
-- exposing the shared physical warehouse quantity. The view is read-only and
-- security-invoker so underlying RLS remains the authority.

create view public.company_inventory_position
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
  i.is_active
from public.companies c
cross join public.inventory_items i
left join public.company_inventory_balances cb
  on cb.company_id = c.id and cb.item_id = i.id
left join public.inventory_balances b on b.item_id = i.id
where c.is_active
;

create view public.company_inventory_stage_summary
with (security_invoker = true)
as
select
  cip.company_id,
  cip.stage,
  pg_catalog.count(*)::bigint as item_count,
  coalesce(pg_catalog.sum(cip.quantity_on_hand), 0::numeric)::numeric(20,6) as total_quantity,
  coalesce(pg_catalog.sum(cip.shared_quantity_on_hand), 0::numeric)::numeric(20,6) as shared_total_quantity,
  coalesce(pg_catalog.sum(cip.inventory_value), 0::numeric)::numeric(20,2) as total_value
from public.company_inventory_position cip
where cip.is_active
group by cip.company_id, cip.stage;

revoke all on table
  public.company_inventory_position,
  public.company_inventory_stage_summary
from public, anon, authenticated;

grant select on table
  public.company_inventory_position,
  public.company_inventory_stage_summary
to authenticated;
