-- BCSO Training Command overlap-approval migration
-- Run once in Supabase SQL Editor AFTER the existing scheduling and cancellation setup.
-- Public visitors can still schedule normally without signing in. Only explicitly
-- allowlisted Supabase Auth accounts can use the overlap-approval RPC.

-- 1) Private allowlist for Training Command accounts.
create table if not exists public.training_command_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  added_at timestamptz not null default now(),
  notes text
);

alter table public.training_command_members enable row level security;
revoke all on table public.training_command_members from anon, authenticated;

-- 2) A safe membership check. The table itself is never exposed to browser users.
create or replace function public.is_training_command()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.training_command_members m
    where m.user_id = auth.uid()
      and m.active = true
  );
$$;

revoke all on function public.is_training_command() from public;
grant execute on function public.is_training_command() to authenticated;

-- Keep the legacy authenticated insert policy from allowing users to set the
-- conflict_override flag directly. Only the command RPC below may set it.
drop policy if exists "trainings_insert" on public.trainings;
create policy "trainings_insert" on public.trainings
for insert to authenticated
with check (
  created_by = auth.uid()
  and public.can_schedule_for(division_id)
  and conflict_override = false
);

-- Store who approved an overlap and when, for an auditable calendar record.
alter table public.trainings
  add column if not exists conflict_approved_by uuid references auth.users(id),
  add column if not exists conflict_approved_at timestamptz;

-- 3) Update conflict detection so an already-approved overlap still blocks
-- additional ordinary bookings. Only the NEW row can bypass this trigger.
create or replace function public.prevent_training_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'scheduled' or new.conflict_override then
    return new;
  end if;

  perform pg_advisory_xact_lock(71924501);

  if exists (
    select 1
    from public.trainings t
    where t.id is distinct from new.id
      and t.status = 'scheduled'
      and t.starts_at < new.ends_at
      and t.ends_at > new.starts_at
  ) then
    raise exception 'TRAINING_CONFLICT: this time overlaps another scheduled training'
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

-- 4) Command-only create function. It requires a real authenticated account
-- that is present in training_command_members. It only permits an overlap
-- when the conflicting scheduled training belongs to a different division.
create or replace function public.create_training_with_cancel_code_override(
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
  if not public.is_training_command() then
    raise exception 'Training Command authorization required.' using errcode = '42501';
  end if;

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
  if not exists (
    select 1 from public.divisions d
    where d.id = target_division_id and d.is_active = true
  ) then
    raise exception 'Select an active division.';
  end if;

  -- Serialize against ordinary schedule submissions and other command approvals.
  perform pg_advisory_xact_lock(71924501);

  if not exists (
    select 1
    from public.trainings t
    where t.status = 'scheduled'
      and t.division_id <> target_division_id
      and t.starts_at < training_ends_at
      and t.ends_at > training_starts_at
  ) then
    raise exception 'No cross-division scheduling conflict exists for this time. Use normal scheduling.';
  end if;

  new_code := upper(encode(extensions.gen_random_bytes(4), 'hex'));

  insert into public.trainings (
    division_id, title, description, instructor, starts_at, ends_at,
    location, capacity, status, created_by, conflict_override,
    conflict_approved_by, conflict_approved_at, cancellation_code_hash
  ) values (
    target_division_id, trim(training_title), training_description,
    trim(training_instructor), training_starts_at, training_ends_at,
    training_location, training_capacity, 'scheduled', auth.uid(), true,
    auth.uid(), now(), extensions.crypt(new_code, extensions.gen_salt('bf'))
  ) returning id into new_id;

  return query select new_id, new_code;
end;
$$;

revoke all on function public.create_training_with_cancel_code_override(
  text, uuid, text, text, timestamptz, timestamptz, text, integer
) from public, anon;
grant execute on function public.create_training_with_cancel_code_override(
  text, uuid, text, text, timestamptz, timestamptz, text, integer
) to authenticated;

notify pgrst, 'reload schema';

-- 5) Add authorized command accounts AFTER they have been created in
-- Supabase Dashboard > Authentication > Users. Run one insert per person:
--
-- insert into public.training_command_members (user_id, notes)
-- select id, 'BCSO Training Command'
-- from auth.users
-- where lower(email) = lower('COMMAND-MEMBER-EMAIL@example.com')
-- on conflict (user_id) do update set active = true, notes = excluded.notes;
--
-- To revoke access:
-- update public.training_command_members m
-- set active = false
-- from auth.users u
-- where u.id = m.user_id
--   and lower(u.email) = lower('COMMAND-MEMBER-EMAIL@example.com');
