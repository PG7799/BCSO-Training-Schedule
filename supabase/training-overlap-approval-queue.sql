-- BCSO Training Operations Center: command-reviewed overlap requests
-- Run this migration in Supabase SQL Editor AFTER:
--   1. supabase/public-cancellation-migration.sql
--   2. supabase/training-command-overrides.sql
-- This migration does not alter existing training records.

-- Ensure the training table has all approval-audit fields required below.
-- These are additive and safe to run on an existing database.
alter table public.trainings
  add column if not exists conflict_override boolean not null default false,
  add column if not exists conflict_approved_by uuid references auth.users(id),
  add column if not exists conflict_approved_at timestamptz;


create table if not exists public.training_overlap_requests (
  id uuid primary key default gen_random_uuid(),
  division_id uuid not null references public.divisions(id),
  title text not null check (char_length(title) between 2 and 120),
  instructor text not null check (char_length(trim(instructor)) > 0),
  requester_name text,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text,
  capacity integer check (capacity is null or capacity between 1 and 500),
  requested_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','approved','denied')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_by_label text,
  reviewed_at timestamptz,
  review_note text,
  overlap_at_review boolean not null default false,
  approved_training_id uuid references public.trainings(id) on delete set null,
  check (ends_at > starts_at)
);

create index if not exists training_overlap_requests_status_created_idx
  on public.training_overlap_requests(status, created_at desc);
create index if not exists training_overlap_requests_division_idx
  on public.training_overlap_requests(division_id);

-- Keep cancellation-code hashes separate from the command review queue.
-- The browser can read request details, but can never read code hashes.
create table if not exists public.training_overlap_request_secrets (
  request_id uuid primary key
    references public.training_overlap_requests(id) on delete cascade,
  cancellation_code_hash text not null
);

alter table public.training_overlap_requests enable row level security;
alter table public.training_overlap_request_secrets enable row level security;

revoke all on table public.training_overlap_requests from anon, authenticated;
revoke all on table public.training_overlap_request_secrets from anon, authenticated;
grant select on table public.training_overlap_requests to authenticated;

drop policy if exists "training_overlap_requests_command_read"
  on public.training_overlap_requests;
create policy "training_overlap_requests_command_read"
  on public.training_overlap_requests
  for select to authenticated
  using (public.is_training_command());

-- Public / signed-in scheduling users can submit a request only through this
-- validated RPC. The function requires a real, current scheduled overlap.
create or replace function public.submit_training_overlap_request(
  p_training_title text,
  p_target_division_id uuid,
  p_training_instructor text,
  p_training_description text,
  p_training_starts_at timestamptz,
  p_training_ends_at timestamptz,
  p_training_location text,
  p_training_capacity integer,
  p_requester_name text default null
)
returns table(request_id uuid, cancellation_code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_request_id uuid;
  new_code text;
begin
  if p_training_title is null
     or char_length(trim(p_training_title)) not between 2 and 120 then
    raise exception 'Training title must be between 2 and 120 characters.';
  end if;

  if p_training_instructor is null
     or char_length(trim(p_training_instructor)) = 0 then
    raise exception 'Instructor is required.';
  end if;

  if p_requester_name is null
     or char_length(trim(p_requester_name)) not between 1 and 100 then
    raise exception 'Your name or callsign is required (100 characters maximum).';
  end if;

  if p_training_starts_at is null
     or p_training_ends_at is null
     or p_training_ends_at <= p_training_starts_at then
    raise exception 'End time must be later than start time.';
  end if;

  if p_training_starts_at <= now() then
    raise exception 'Choose a future start time.';
  end if;

  if p_training_capacity is not null
     and p_training_capacity not between 1 and 500 then
    raise exception 'Capacity must be between 1 and 500.';
  end if;

  if not exists (
    select 1 from public.divisions d
    where d.id = p_target_division_id and d.is_active = true
  ) then
    raise exception 'Select an active division.';
  end if;

  -- Serialize request validation against schedule creation and approvals.
  perform pg_advisory_xact_lock(71924501);

  if not exists (
    select 1
    from public.trainings t
    where t.status = 'scheduled'
      and t.starts_at < p_training_ends_at
      and t.ends_at > p_training_starts_at
  ) then
    raise exception 'No scheduled training overlap exists now. Please submit this as a normal training.';
  end if;

  new_code := upper(encode(extensions.gen_random_bytes(4), 'hex'));

  insert into public.training_overlap_requests (
    division_id, title, instructor, requester_name, description,
    starts_at, ends_at, location, capacity, requested_by
  ) values (
    p_target_division_id, trim(p_training_title), trim(p_training_instructor),
    nullif(left(trim(coalesce(p_requester_name, '')), 100), ''),
    nullif(trim(coalesce(p_training_description, '')), ''),
    p_training_starts_at, p_training_ends_at,
    nullif(trim(coalesce(p_training_location, '')), ''),
    p_training_capacity, auth.uid()
  )
  returning id into new_request_id;

  insert into public.training_overlap_request_secrets (
    request_id, cancellation_code_hash
  ) values (
    new_request_id, extensions.crypt(new_code, extensions.gen_salt('bf'))
  );

  return query select new_request_id, new_code;
end;
$$;

revoke all on function public.submit_training_overlap_request(
  text, uuid, text, text, timestamptz, timestamptz, text, integer, text
) from public;
grant execute on function public.submit_training_overlap_request(
  text, uuid, text, text, timestamptz, timestamptz, text, integer, text
) to anon, authenticated;

-- Training Command approval is atomic: it re-checks the schedule while
-- holding the same advisory lock, creates the training, and records the
-- reviewer. If the collision has disappeared, it creates a normal session.
create or replace function public.approve_training_overlap_request(
  p_request_id uuid
)
returns table(training_id uuid, conflict_overridden boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  request_row public.training_overlap_requests%rowtype;
  code_hash text;
  has_overlap boolean;
  new_training_id uuid;
begin
  if not public.is_training_command() then
    raise exception 'Training Command authorization required.'
      using errcode = '42501';
  end if;

  -- The trainings.created_by column references public.profiles(id).
  -- Repair a missing profile for this authenticated command user before
  -- creating the approved training. New profiles receive the safe default
  -- role of 'personnel'; Training Command permissions remain in the
  -- separate private training_command_members allowlist.
  insert into public.profiles (id, email, full_name)
  select u.id, lower(u.email),
         coalesce(u.raw_user_meta_data ->> 'full_name', '')
  from auth.users u
  where u.id = auth.uid()
  on conflict do nothing;

  if not exists (
    select 1 from public.profiles p where p.id = auth.uid()
  ) then
    raise exception 'Your Training Command account is missing its BCSO profile. Run the command-profile repair SQL and try again.';
  end if;

  perform pg_advisory_xact_lock(71924501);

  select * into request_row
  from public.training_overlap_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Overlap request not found.';
  end if;

  if request_row.status <> 'pending' then
    raise exception 'This overlap request has already been reviewed.';
  end if;

  if request_row.starts_at <= now() then
    raise exception 'The requested start time has passed. Deny this request and ask the scheduler to submit a new one.';
  end if;

  if not exists (
    select 1 from public.divisions d
    where d.id = request_row.division_id and d.is_active = true
  ) then
    raise exception 'The requested division is no longer active.';
  end if;

  select s.cancellation_code_hash into code_hash
  from public.training_overlap_request_secrets s
  where s.request_id = p_request_id;

  if code_hash is null then
    raise exception 'The request cancellation-code record is missing. Contact the database administrator.';
  end if;

  select exists (
    select 1 from public.trainings t
    where t.status = 'scheduled'
      and t.starts_at < request_row.ends_at
      and t.ends_at > request_row.starts_at
  ) into has_overlap;

  insert into public.trainings (
    division_id, title, description, instructor, starts_at, ends_at,
    location, capacity, status, created_by, conflict_override,
    conflict_approved_by, conflict_approved_at, cancellation_code_hash
  ) values (
    request_row.division_id, request_row.title, request_row.description,
    request_row.instructor, request_row.starts_at, request_row.ends_at,
    request_row.location, request_row.capacity, 'scheduled', auth.uid(),
    has_overlap,
    case when has_overlap then auth.uid() else null end,
    case when has_overlap then now() else null end,
    code_hash
  )
  returning id into new_training_id;

  update public.training_overlap_requests
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_by_label = coalesce(
        nullif(left(auth.jwt() ->> 'email', 150), ''),
        'Training Command'
      ),
      reviewed_at = now(),
      overlap_at_review = has_overlap,
      approved_training_id = new_training_id
  where id = p_request_id;

  delete from public.training_overlap_request_secrets
  where request_id = p_request_id;

  return query select new_training_id, has_overlap;
end;
$$;

revoke all on function public.approve_training_overlap_request(uuid)
  from public, anon;
grant execute on function public.approve_training_overlap_request(uuid)
  to authenticated;

create or replace function public.deny_training_overlap_request(
  p_request_id uuid,
  p_review_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_count integer;
begin
  if not public.is_training_command() then
    raise exception 'Training Command authorization required.'
      using errcode = '42501';
  end if;

  update public.training_overlap_requests
  set status = 'denied',
      reviewed_by = auth.uid(),
      reviewed_by_label = coalesce(
        nullif(left(auth.jwt() ->> 'email', 150), ''),
        'Training Command'
      ),
      reviewed_at = now(),
      review_note = nullif(left(trim(coalesce(p_review_note, '')), 1000), '')
  where id = p_request_id
    and status = 'pending';

  get diagnostics changed_count = row_count;

  if changed_count = 0 then
    raise exception 'This pending overlap request was not found or has already been reviewed.';
  end if;

  delete from public.training_overlap_request_secrets
  where request_id = p_request_id;

  return true;
end;
$$;

revoke all on function public.deny_training_overlap_request(uuid, text)
  from public, anon;
grant execute on function public.deny_training_overlap_request(uuid, text)
  to authenticated;

notify pgrst, 'reload schema';
