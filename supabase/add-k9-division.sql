-- Add the K9 division to an existing BCSO Training Operations database.
-- Safe to run more than once. Re-activates K9 if it already exists.

insert into public.divisions (name, description, is_active)
values (
  'K9',
  'Canine operations and K9 unit training',
  true
)
on conflict (name) do update
set description = excluded.description,
    is_active = true;

-- Verify the division is present and active.
select id, name, description, is_active
from public.divisions
where name = 'K9';
