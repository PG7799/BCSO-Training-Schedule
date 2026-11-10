-- BCSO Public Schedule: safe, read-only anonymous access
-- Run this in Supabase SQL Editor for project phfbtspnxfqvdsmsufap.
-- This grants anon SELECT only on the public schedule tables.
-- It does NOT grant anon INSERT, UPDATE, DELETE, access to profiles/members,
-- or access to training overlap request/command tables.

grant usage on schema public to anon;
grant select on public.divisions to anon;
grant select on public.trainings to anon;

drop policy if exists "public_schedule_divisions_read" on public.divisions;
create policy "public_schedule_divisions_read"
on public.divisions for select to anon
using (is_active = true);

drop policy if exists "public_schedule_trainings_read" on public.trainings;
create policy "public_schedule_trainings_read"
on public.trainings for select to anon
using (status = 'scheduled');

-- Realtime publication membership enables live change notifications; SELECT still
-- remains governed by the anon grants and row-level security policies above.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'trainings'
  ) then
    alter publication supabase_realtime add table public.trainings;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'divisions'
  ) then
    alter publication supabase_realtime add table public.divisions;
  end if;
end $$;
