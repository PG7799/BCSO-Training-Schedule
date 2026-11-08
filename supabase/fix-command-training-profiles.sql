-- Repair Training Command approval setup.
-- Run once in Supabase SQL Editor, then retry the pending request.
-- Safe to run more than once.

-- A) Create profile rows for already-authorized Training Command accounts.
-- trainings.created_by references public.profiles(id), not auth.users(id).
insert into public.profiles (id, email, full_name)
select
  u.id,
  lower(u.email),
  coalesce(u.raw_user_meta_data ->> 'full_name', '')
from auth.users u
join public.training_command_members m
  on m.user_id = u.id
where m.active = true
on conflict do nothing;

-- B) Install the approval function with a profile safeguard for future approvals.
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

-- Keep the approval action restricted to authenticated Training Command accounts.
revoke all on function public.approve_training_overlap_request(uuid)
  from public, anon;
grant execute on function public.approve_training_overlap_request(uuid)
  to authenticated;

-- Confirm each active Training Command account has a profile.
select
  lower(u.email) as command_email,
  (p.id is not null) as has_profile
from public.training_command_members m
join auth.users u on u.id = m.user_id
left join public.profiles p on p.id = m.user_id
where m.active = true
order by lower(u.email);

notify pgrst, 'reload schema';
