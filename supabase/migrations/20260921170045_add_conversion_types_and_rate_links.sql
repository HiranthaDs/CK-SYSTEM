-- Add a stable conversion-type master while preserving the effective-dated
-- piecework-rate and conversion snapshots used by historical payroll claims.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

create table public.conversion_types (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  name text not null,
  default_chip_name text,
  status text not null default 'active',
  notes text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint conversion_types_name_not_blank check (pg_catalog.btrim(name) <> ''),
  constraint conversion_types_name_length check (pg_catalog.char_length(name) <= 160),
  constraint conversion_types_chip_name_length check (
    default_chip_name is null or pg_catalog.char_length(default_chip_name) <= 160
  ),
  constraint conversion_types_notes_length check (
    notes is null or pg_catalog.char_length(notes) <= 1000
  ),
  constraint conversion_types_status_valid check (status in ('active', 'inactive'))
);

create unique index conversion_types_name_unique_idx
  on public.conversion_types (pg_catalog.lower(pg_catalog.btrim(name)));
create index conversion_types_active_name_idx
  on public.conversion_types (name, id)
  where status = 'active';

alter table public.piecework_rates
  add column conversion_type_id uuid,
  add constraint piecework_rates_conversion_type_id_fkey
    foreign key (conversion_type_id)
    references public.conversion_types(id)
    on delete restrict;

create index piecework_rates_conversion_type_id_idx
  on public.piecework_rates (conversion_type_id, effective_from desc);

alter table public.conversions
  add column conversion_type_id uuid,
  add constraint conversions_conversion_type_id_fkey
    foreign key (conversion_type_id)
    references public.conversion_types(id)
    on delete restrict;

create index conversions_conversion_type_id_idx
  on public.conversions (conversion_type_id);

-- Existing rate labels become reusable types. Conversion-only labels are also
-- retained, including a useful default chip name from the latest matching run.
insert into public.conversion_types (name, status, notes)
select distinct on (pg_catalog.lower(pg_catalog.btrim(r.work_type)))
  pg_catalog.btrim(r.work_type),
  'active',
  'Created from an existing piecework rate'
from public.piecework_rates r
where pg_catalog.btrim(r.work_type) <> ''
order by
  pg_catalog.lower(pg_catalog.btrim(r.work_type)),
  r.effective_from desc,
  r.id desc;

insert into public.conversion_types (name, default_chip_name, status, notes)
select distinct on (pg_catalog.lower(pg_catalog.btrim(c.chip_type)))
  pg_catalog.btrim(c.chip_type),
  i.name,
  'active',
  'Created from an existing conversion'
from public.conversions c
join public.inventory_items i on i.id = c.output_item_id
where nullif(pg_catalog.btrim(c.chip_type), '') is not null
  and not exists (
    select 1
    from public.conversion_types t
    where pg_catalog.lower(pg_catalog.btrim(t.name))
      = pg_catalog.lower(pg_catalog.btrim(c.chip_type))
  )
order by
  pg_catalog.lower(pg_catalog.btrim(c.chip_type)),
  c.conversion_date desc,
  c.id desc;

update public.conversion_types t
set default_chip_name = source.default_chip_name,
    updated_at = pg_catalog.clock_timestamp()
from (
  select distinct on (pg_catalog.lower(pg_catalog.btrim(c.chip_type)))
    pg_catalog.lower(pg_catalog.btrim(c.chip_type)) as normalized_name,
    i.name as default_chip_name
  from public.conversions c
  join public.inventory_items i on i.id = c.output_item_id
  where nullif(pg_catalog.btrim(c.chip_type), '') is not null
  order by
    pg_catalog.lower(pg_catalog.btrim(c.chip_type)),
    c.conversion_date desc,
    c.id desc
) source
where pg_catalog.lower(pg_catalog.btrim(t.name)) = source.normalized_name
  and t.default_chip_name is null;

update public.piecework_rates r
set conversion_type_id = t.id,
    updated_at = pg_catalog.clock_timestamp()
from public.conversion_types t
where pg_catalog.lower(pg_catalog.btrim(t.name))
  = pg_catalog.lower(pg_catalog.btrim(r.work_type));

update public.conversions c
set conversion_type_id = t.id,
    updated_at = pg_catalog.clock_timestamp()
from public.conversion_types t
where nullif(pg_catalog.btrim(c.chip_type), '') is not null
  and pg_catalog.lower(pg_catalog.btrim(t.name))
    = pg_catalog.lower(pg_catalog.btrim(c.chip_type));

create trigger conversion_types_rpc_guard
before insert or update or delete on public.conversion_types
for each row execute function private.require_rpc_guard();

alter table public.conversion_types enable row level security;
revoke all on table public.conversion_types from public, anon, authenticated;
grant select on table public.conversion_types to authenticated;

create policy conversion_types_read
on public.conversion_types
for select to authenticated
using ((select private.has_any_permission(
  array[
    'inventory.read', 'production.read', 'employees.read',
    'payroll.read', 'reports.read'
  ]::text[]
)));

drop policy if exists erp_read on public.piecework_rates;
create policy erp_read
on public.piecework_rates
for select to authenticated
using ((select private.has_any_permission(
  array[
    'employees.read', 'payroll.read', 'inventory.read',
    'production.read', 'reports.read'
  ]::text[]
)));

-- Layer type management and canonical rate snapshots over the reviewed
-- dispatcher. All existing operation names and payloads continue to work.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_conversion_types;

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
  v_conversion_payload jsonb;
  v_workers jsonb;
  v_normalized_workers jsonb := '[]'::jsonb;
  v_worker jsonb;
  v_result jsonb;
  v_id uuid;
  v_type_id uuid;
  v_name text;
  v_status text;
  v_conversion_date date;
  v_effective_from date;
  v_effective_to date;
  v_type public.conversion_types%rowtype;
  v_rate public.piecework_rates%rowtype;
begin
  if p_operation = 'system.purge_business_data' then
    v_result := private.perform_operation_before_conversion_types(
      p_operation, p_payload, p_actor
    );
    delete from public.conversion_types;
    return v_result;
  end if;

  if p_operation <> any(array[
    'conversion_type.upsert', 'conversion_type.delete',
    'piecework_rate.upsert', 'piecework_rate.delete',
    'conversion.post', 'conversion.replace'
  ]) then
    return private.perform_operation_before_conversion_types(
      p_operation, p_payload, p_actor
    );
  end if;

  if p_actor is null or p_actor <> (select auth.uid()) then
    raise exception using
      errcode = '42501',
      message = 'A valid authenticated actor is required';
  end if;
  if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
    raise exception using
      errcode = '42501',
      message = 'ERP operation guard is not active';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Operation payload must be a JSON object';
  end if;

  if p_operation = 'conversion_type.upsert' then
    if not (select private.has_any_permission(
      array['inventory.write', 'production.write', 'employees.write']::text[]
    )) then
      raise exception using
        errcode = '42501',
        message = 'Conversion master write permission is required';
    end if;
    v_id := coalesce(
      nullif(v_payload ->> 'id', '')::uuid,
      pg_catalog.gen_random_uuid()
    );
    v_name := pg_catalog.btrim(v_payload ->> 'name');
    v_status := coalesce(nullif(v_payload ->> 'status', ''), 'active');

    if coalesce(v_name, '') = '' then
      raise exception using errcode = '22023', message = 'Conversion type name is required';
    end if;
    if v_status not in ('active', 'inactive') then
      raise exception using errcode = '22023', message = 'Invalid conversion type status';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'conversion-type:' || pg_catalog.lower(v_name),
        0
      )
    );

    insert into public.conversion_types (
      id, name, default_chip_name, status, notes, created_by, updated_by
    ) values (
      v_id,
      pg_catalog.left(v_name, 160),
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'default_chip_name'), 160), ''),
      v_status,
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'notes'), 1000), ''),
      p_actor,
      p_actor
    )
    on conflict (id) do update
    set name = excluded.name,
        default_chip_name = excluded.default_chip_name,
        status = excluded.status,
        notes = excluded.notes,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'operation', p_operation,
      'id', v_id,
      'reference_no', v_name,
      'idempotent', false
    );

  elsif p_operation = 'conversion_type.delete' then
    if not (select private.has_any_permission(
      array['inventory.write', 'production.write', 'employees.write']::text[]
    )) then
      raise exception using
        errcode = '42501',
        message = 'Conversion master write permission is required';
    end if;
    v_id := (v_payload ->> 'id')::uuid;
    update public.conversion_types
    set status = 'inactive',
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id
    returning name into v_name;
    if not found then
      raise exception using errcode = 'P0001', message = 'Conversion type not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'operation', p_operation,
      'id', v_id,
      'reference_no', v_name,
      'idempotent', false
    );

  elsif p_operation = 'piecework_rate.upsert' then
    if not (select private.has_any_permission(
      array['employees.write', 'inventory.write', 'production.write']::text[]
    )) then
      raise exception using
        errcode = '42501',
        message = 'Conversion rate write permission is required';
    end if;
    v_type_id := nullif(v_payload ->> 'conversion_type_id', '')::uuid;
    v_name := nullif(pg_catalog.btrim(v_payload ->> 'work_type'), '');
    v_id := coalesce(
      nullif(v_payload ->> 'id', '')::uuid,
      pg_catalog.gen_random_uuid()
    );
    v_effective_from := (v_payload ->> 'effective_from')::date;
    v_effective_to := nullif(v_payload ->> 'effective_to', '')::date;
    v_status := coalesce(nullif(v_payload ->> 'status', ''), 'active');

    if v_type_id is not null then
      select * into v_type
      from public.conversion_types t
      where t.id = v_type_id and t.status = 'active';
      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'Active conversion type not found';
      end if;
    else
      if v_name is null then
        raise exception using
          errcode = '22023',
          message = 'Conversion type or work type is required';
      end if;
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'conversion-type:' || pg_catalog.lower(v_name),
          0
        )
      );
      select * into v_type
      from public.conversion_types t
      where pg_catalog.lower(pg_catalog.btrim(t.name)) = pg_catalog.lower(v_name);
      if not found then
        insert into public.conversion_types (
          name, status, notes, created_by, updated_by
        ) values (
          pg_catalog.left(v_name, 160),
          'active',
          'Created with a piecework rate',
          p_actor,
          p_actor
        )
        returning * into v_type;
      elsif v_type.status <> 'active' then
        raise exception using
          errcode = 'P0001',
          message = 'The matching conversion type is inactive';
      end if;
      v_type_id := v_type.id;
    end if;

    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{conversion_type_id}',
      pg_catalog.to_jsonb(v_type_id),
      true
    );
    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{work_type}',
      pg_catalog.to_jsonb(v_type.name),
      true
    );

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'piecework-rate:' || pg_catalog.lower(v_type.name),
        0
      )
    );
    if v_status = 'active' and exists (
      select 1
      from public.piecework_rates r
      where r.conversion_type_id = v_type_id
        and r.status = 'active'
        and r.id <> v_id
        and pg_catalog.daterange(
          r.effective_from,
          coalesce(r.effective_to, 'infinity'::date),
          '[]'
        ) && pg_catalog.daterange(
          v_effective_from,
          coalesce(v_effective_to, 'infinity'::date),
          '[]'
        )
    ) then
      raise exception using
        errcode = '23505',
        message = 'An active conversion rate already covers part of this effective period';
    end if;

    insert into public.piecework_rates (
      id, conversion_type_id, work_type, rate_per_kg,
      effective_from, effective_to, status, notes, created_by, updated_by
    ) values (
      v_id,
      v_type_id,
      pg_catalog.left(v_type.name, 160),
      pg_catalog.round((v_payload ->> 'rate_per_kg')::numeric, 6),
      v_effective_from,
      v_effective_to,
      v_status,
      nullif(pg_catalog.btrim(v_payload ->> 'notes'), ''),
      p_actor,
      p_actor
    )
    on conflict (id) do update
    set conversion_type_id = excluded.conversion_type_id,
        work_type = excluded.work_type,
        rate_per_kg = excluded.rate_per_kg,
        effective_from = excluded.effective_from,
        effective_to = excluded.effective_to,
        status = excluded.status,
        notes = excluded.notes,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'operation', p_operation,
      'id', v_id,
      'reference_no', v_type.name,
      'idempotent', false
    );

  elsif p_operation = 'piecework_rate.delete' then
    if not (select private.has_any_permission(
      array['employees.write', 'inventory.write', 'production.write']::text[]
    )) then
      raise exception using
        errcode = '42501',
        message = 'Conversion rate write permission is required';
    end if;
    v_id := (v_payload ->> 'id')::uuid;
    update public.piecework_rates
    set status = 'inactive',
        effective_to = coalesce(effective_to, current_date),
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id
    returning work_type into v_name;
    if not found then
      raise exception using errcode = 'P0001', message = 'Piecework rate not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'operation', p_operation,
      'id', v_id,
      'reference_no', v_name,
      'idempotent', false
    );
  end if;

  -- conversion.post and conversion.replace share the same normalized inner
  -- payload. A selected master rate is copied from the database; a null rate
  -- id is the explicit manual path.
  perform private.assert_permission('inventory.write');
  v_conversion_payload := case
    when p_operation = 'conversion.replace'
      then coalesce(v_payload -> 'replacement', '{}'::jsonb)
    else v_payload
  end;
  v_conversion_date := (v_conversion_payload ->> 'conversion_date')::date;
  v_type_id := nullif(v_conversion_payload ->> 'conversion_type_id', '')::uuid;

  if v_type_id is not null then
    select * into v_type
    from public.conversion_types t
    where t.id = v_type_id and t.status = 'active';
    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'Active conversion type not found';
    end if;
    v_conversion_payload := pg_catalog.jsonb_set(
      v_conversion_payload,
      '{chip_type}',
      pg_catalog.to_jsonb(v_type.name),
      true
    );
    if nullif(v_conversion_payload ->> 'output_item_id', '') is null
       and nullif(pg_catalog.btrim(v_conversion_payload ->> 'chip_name'), '') is null
       and v_type.default_chip_name is not null then
      v_conversion_payload := pg_catalog.jsonb_set(
        v_conversion_payload,
        '{chip_name}',
        pg_catalog.to_jsonb(v_type.default_chip_name),
        true
      );
    end if;
  elsif nullif(pg_catalog.btrim(v_conversion_payload ->> 'chip_type'), '') is null
        and nullif(pg_catalog.btrim(v_conversion_payload ->> 'chip_name'), '') is not null then
    v_conversion_payload := pg_catalog.jsonb_set(
      v_conversion_payload,
      '{chip_type}',
      pg_catalog.to_jsonb(pg_catalog.btrim(v_conversion_payload ->> 'chip_name')),
      true
    );
  end if;

  v_workers := coalesce(v_conversion_payload -> 'workers', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_workers) <> 'array' then
    raise exception using errcode = '22023', message = 'Conversion workers must be an array';
  end if;

  for v_worker in
    select item.value
    from pg_catalog.jsonb_array_elements(v_workers) item(value)
  loop
    if nullif(v_worker ->> 'rate_id', '') is not null then
      select * into v_rate
      from public.piecework_rates r
      where r.id = (v_worker ->> 'rate_id')::uuid
        and r.status = 'active'
        and v_conversion_date between r.effective_from
          and coalesce(r.effective_to, v_conversion_date);
      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'Piecework rate is not active on the conversion date';
      end if;
      if v_type_id is not null
         and coalesce(v_rate.conversion_type_id, v_type_id) <> v_type_id then
        raise exception using
          errcode = '23514',
          message = 'Piecework rate does not belong to the selected conversion type';
      end if;
      v_worker := v_worker || pg_catalog.jsonb_build_object(
        'task', v_rate.work_type,
        'rate_per_kg', v_rate.rate_per_kg,
        'amount', pg_catalog.round(
          (v_worker ->> 'quantity_kg')::numeric * v_rate.rate_per_kg,
          2
        )
      );
    else
      if nullif(pg_catalog.btrim(v_worker ->> 'task'), '') is null
         or coalesce(nullif(v_worker ->> 'quantity_kg', '')::numeric, 0) <= 0
         or coalesce(nullif(v_worker ->> 'rate_per_kg', '')::numeric, 0) <= 0 then
        raise exception using
          errcode = '22023',
          message = 'Manual worker allocation requires task, quantity, and rate';
      end if;
      v_worker := v_worker || pg_catalog.jsonb_build_object(
        'amount', pg_catalog.round(
          (v_worker ->> 'quantity_kg')::numeric
            * (v_worker ->> 'rate_per_kg')::numeric,
          2
        )
      );
    end if;
    v_normalized_workers := v_normalized_workers
      || pg_catalog.jsonb_build_array(v_worker);
  end loop;

  v_conversion_payload := pg_catalog.jsonb_set(
    v_conversion_payload,
    '{workers}',
    v_normalized_workers,
    true
  );
  if p_operation = 'conversion.replace' then
    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{replacement}',
      v_conversion_payload,
      true
    );
  else
    v_payload := v_conversion_payload;
  end if;

  v_result := private.perform_operation_before_conversion_types(
    p_operation, v_payload, p_actor
  );
  update public.conversions
  set conversion_type_id = v_type_id,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_actor
  where id = (v_result ->> 'id')::uuid;
  return v_result;
end;
$function$;

revoke all on function
  private.perform_operation_before_conversion_types(text, jsonb, uuid),
  private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
