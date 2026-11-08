-- Public cancellation for no-login scheduling.
-- Run this migration in Supabase SQL Editor AFTER the existing schema and public scheduling policies.
-- Each new training receives a one-time cancellation code. Only its hash is stored.

create extension if not exists pgcrypto;

alter table public.trainings
  add column if not exists cancellation_code_hash text,
  add column if not exists cancellation_reason text;

create or replace function public.create_training_with_cancel_code(
  training_title text,
  target_division_id uuid,
  training_instructor text,
  training_description text,
  training_starts_at timestamptz,
  training_ends_at timestamptz,
  training_location text,
  training_capacity integer
)
returns table(training_id uuid, cancellation_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  new_code text;
begin
  if training_title is null or char_length(trim(training_title)) not between 2 and 120 then
    raise exception 'Training title must be between 2 and 120 characters.';
  end if;
  if training_instructor is null or char_length(trim(training_instructor)) = 0 then
    raise exception 'Instructor is required.';
  end if;
  if training_starts_at is null or training_ends_at is null or training_ends_at <= training_starts_at then
    raise exception 'End time must be later than start time.';
  end if;
  if training_starts_at <= now() then
    raise exception 'Choose a future start time.';
  end if;
  if training_capacity is not null and training_capacity not between 1 and 500 then
    raise exception 'Capacity must be between 1 and 500.';
  end if;
  if not exists (select 1 from public.divisions d where d.id = target_division_id and d.is_active = true) then
    raise exception 'Select an active division.';
  end if;

  new_code := upper(encode(gen_random_bytes(4), 'hex'));
  insert into public.trainings (
    division_id, title, description, instructor, starts_at, ends_at,
    location, capacity, status, created_by, conflict_override,
    cancellation_code_hash
  ) values (
    target_division_id, trim(training_title), training_description,
    trim(training_instructor), training_starts_at, training_ends_at,
    training_location, training_capacity, 'scheduled', null, false,
    crypt(new_code, gen_salt('bf'))
  ) returning id into new_id;

  return query select new_id, new_code;
end;
$$;

create or replace function public.cancel_training_with_code(
  target_training_id uuid,
  supplied_code text,
  cancellation_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  stored_hash text;
  current_status text;
begin
  select t.cancellation_code_hash, t.status
    into stored_hash, current_status
  from public.trainings t
  where t.id = target_training_id
  for update;

  if not found then raise exception 'Training not found.'; end if;
  if current_status <> 'scheduled' then raise exception 'This training is no longer scheduled.'; end if;
  if stored_hash is null or supplied_code is null or supplied_code = '' or crypt(supplied_code, stored_hash) <> stored_hash then
    raise exception 'Incorrect cancellation code.';
  end if;

  update public.trainings
  set status = 'cancelled',
      cancellation_reason = nullif(left(trim(coalesce(cancellation_reason, '')), 500), '')
  where id = target_training_id;

  return true;
end;
$$;

-- Do not allow direct anonymous updates; cancellation must go through the code-checking RPC.
revoke all on function public.create_training_with_cancel_code(text,uuid,text,text,timestamptz,timestamptz,text,integer) from public;
revoke all on function public.cancel_training_with_code(uuid,text,text) from public;
grant execute on function public.create_training_with_cancel_code(text,uuid,text,text,timestamptz,timestamptz,text,integer) to anon, authenticated;
grant execute on function public.cancel_training_with_code(uuid,text,text) to anon, authenticated;

-- Remove any broad anonymous update policy if one was added during troubleshooting.
drop policy if exists "trainings_public_update" on public.trainings;
revoke update on public.trainings from anon;

notify pgrst, 'reload schema';
