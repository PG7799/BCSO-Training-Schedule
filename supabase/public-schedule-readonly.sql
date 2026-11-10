-- BCSO Public Schedule: safe, read-only anonymous access
-- Run this in Supabase SQL Editor for project phfbtspnxfqvdsmsufap.
-- This grants the anonymous browser role SELECT only on schedule tables.
-- It does NOT grant access to profiles, division memberships, overlap requests,
-- or Training Command records.

grant usage on schema public to anon;

-- Remove any pre-existing direct privileges first, then grant SELECT only.
revoke all privileges on table public.divisions from anon;
revoke all privileges on table public.trainings from anon;
grant select on table public.divisions to anon;
grant select on table public.trainings to anon;

drop policy if exists "public_schedule_divisions_read" on public.divisions;
create policy "public_schedule_divisions_read"
on public.divisions for select to anon
using (is_active = true);

drop policy if exists "public_schedule_trainings_read" on public.trainings;
create policy "public_schedule_trainings_read"
on public.trainings for select to anon
using (status = 'scheduled');

-- Enable live database change notifications for the public viewer.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
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
  else
    raise notice 'supabase_realtime publication not found; enable Realtime for trainings and divisions in Supabase.';
  end if;
end $$;
