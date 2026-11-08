-- Repair missing BCSO profile rows for authorized Training Command accounts.
-- Run this once in the Supabase SQL Editor, then retry the pending approval.
-- This does not change anyone's Training Command allowlist membership or role.

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

-- Confirm every active Training Command account now has a matching profile.
select
  lower(u.email) as command_email,
  (p.id is not null) as has_profile
from public.training_command_members m
join auth.users u on u.id = m.user_id
left join public.profiles p on p.id = m.user_id
where m.active = true
order by lower(u.email);

notify pgrst, 'reload schema';
