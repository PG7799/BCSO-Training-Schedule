-- BCSO Training Operations Center
-- Run the entire script in Supabase SQL Editor using the project owner account.
-- This script creates tables, RLS policies, conflict prevention, and starter divisions.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  role text not null default 'personnel' check (role in ('personnel','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.divisions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.division_members (
  id uuid primary key default gen_random_uuid(),
  division_id uuid not null references public.divisions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  access_level text not null default 'scheduler'
    check (access_level in ('scheduler','commander','co_commander')),
  created_at timestamptz not null default now(),
  unique (division_id,user_id)
);

create table if not exists public.trainings (
  id uuid primary key default gen_random_uuid(),
  division_id uuid not null references public.divisions(id),
  title text not null check (char_length(title) between 2 and 120),
  description text,
  instructor text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text,
  capacity integer check (capacity is null or capacity between 1 and 500),
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists trainings_start_idx on public.trainings(starts_at);
create index if not exists trainings_division_idx on public.trainings(division_id);
create index if not exists division_members_user_idx on public.division_members(user_id);

-- Automatically create a profile whenever an Auth account is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id,email,full_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do update set email=excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Keep profile email synchronized if the Auth email changes.
create or replace function public.sync_user_email()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  update public.profiles set email=lower(new.email) where id=new.id;
  return new;
end;
$$;
drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated after update of email on auth.users
for each row execute procedure public.sync_user_email();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(select 1 from public.profiles where id=auth.uid() and role='admin');
$$;

create or replace function public.can_schedule_for(target_division uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.division_members
    where user_id=auth.uid() and division_id=target_division
  );
$$;

create or replace function public.can_manage_division(target_division uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.division_members
    where user_id=auth.uid() and division_id=target_division
      and access_level in ('commander','co_commander')
  );
$$;

-- Serialize booking writes, then reject any time overlap across ALL divisions.
-- A command administrator can deliberately bypass the check by setting
-- conflict_override=true through the privileged SQL process below.
alter table public.trainings add column if not exists conflict_override boolean not null default false;

create or replace function public.prevent_training_overlap()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status <> 'scheduled' or new.conflict_override then
    return new;
  end if;

  perform pg_advisory_xact_lock(71924501);

  if exists (
    select 1 from public.trainings t
    where t.id is distinct from new.id
      and t.status='scheduled'
      and not t.conflict_override
      and t.starts_at < new.ends_at
      and t.ends_at > new.starts_at
  ) then
    raise exception 'TRAINING_CONFLICT: this time overlaps another scheduled training'
      using errcode='23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists trainings_no_overlap on public.trainings;
create trigger trainings_no_overlap before insert or update of starts_at,ends_at,status,conflict_override
on public.trainings for each row execute function public.prevent_training_overlap();

create or replace function public.set_training_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end; $$;
drop trigger if exists trainings_updated_at on public.trainings;
create trigger trainings_updated_at before update on public.trainings
for each row execute function public.set_training_updated_at();

-- Admin-only RPC: grant an existing account access to a division by email.
create or replace function public.admin_grant_division_access(
  target_email text, target_division uuid, target_access text
) returns text language plpgsql security definer set search_path = public
as $$
declare target_user uuid;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  if target_access not in ('scheduler','commander','co_commander') then raise exception 'Invalid access level'; end if;
  select id into target_user from public.profiles where lower(email)=lower(target_email);
  if target_user is null then raise exception 'No account found for that email. Ask the user to sign up first.'; end if;
  insert into public.division_members(division_id,user_id,access_level)
  values(target_division,target_user,target_access)
  on conflict(division_id,user_id) do update set access_level=excluded.access_level;
  return 'Division access granted.';
end;
$$;

alter table public.profiles enable row level security;
alter table public.divisions enable row level security;
alter table public.division_members enable row level security;
alter table public.trainings enable row level security;

-- Profiles: users can read their own profile; administrators can read all profiles.
drop policy if exists "profiles_read" on public.profiles;
create policy "profiles_read" on public.profiles for select to authenticated
using (id=auth.uid() or public.is_admin());
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles for update to authenticated
using (id=auth.uid()) with check (id=auth.uid() and role='personnel');

-- Divisions are visible to authenticated users; only admins manage them.
drop policy if exists "divisions_read" on public.divisions;
create policy "divisions_read" on public.divisions for select to authenticated using (true);
drop policy if exists "divisions_admin_insert" on public.divisions;
create policy "divisions_admin_insert" on public.divisions for insert to authenticated with check (public.is_admin());
drop policy if exists "divisions_admin_update" on public.divisions;
create policy "divisions_admin_update" on public.divisions for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "divisions_admin_delete" on public.divisions;
create policy "divisions_admin_delete" on public.divisions for delete to authenticated using (public.is_admin());

-- Membership list is visible to signed-in users; only admins may change it.
drop policy if exists "members_read" on public.division_members;
create policy "members_read" on public.division_members for select to authenticated using (true);
drop policy if exists "members_admin_insert" on public.division_members;
create policy "members_admin_insert" on public.division_members for insert to authenticated with check (public.is_admin());
drop policy if exists "members_admin_update" on public.division_members;
create policy "members_admin_update" on public.division_members for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "members_admin_delete" on public.division_members;
create policy "members_admin_delete" on public.division_members for delete to authenticated using (public.is_admin());

-- All authenticated personnel can see the shared schedule.
drop policy if exists "trainings_read" on public.trainings;
create policy "trainings_read" on public.trainings for select to authenticated using (true);
drop policy if exists "trainings_insert" on public.trainings;
create policy "trainings_insert" on public.trainings for insert to authenticated
with check (created_by=auth.uid() and public.can_schedule_for(division_id));
drop policy if exists "trainings_update" on public.trainings;
create policy "trainings_update" on public.trainings for update to authenticated
using (public.is_admin() or created_by=auth.uid() or public.can_manage_division(division_id))
with check (
  (public.is_admin() or created_by=auth.uid() or public.can_manage_division(division_id))
  and (conflict_override=false or public.is_admin())
);
drop policy if exists "trainings_delete" on public.trainings;
create policy "trainings_delete" on public.trainings for delete to authenticated
using (public.is_admin() or created_by=auth.uid() or public.can_manage_division(division_id));

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.divisions to authenticated;
grant select, insert, update, delete on public.division_members to authenticated;
grant select, insert, update, delete on public.trainings to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.can_schedule_for(uuid) to authenticated;
grant execute on function public.can_manage_division(uuid) to authenticated;
grant execute on function public.admin_grant_division_access(text,uuid,text) to authenticated;

-- Starter divisions. Rename/add/remove these to match your server.
insert into public.divisions(name,description) values
 ('Training Division','Department-wide training coordination'),
 ('TEU','Traffic Enforcement Unit'),
 ('SWAT','Special Weapons and Tactics'),
 ('VICE','Vice and narcotics investigations'),
 ('CIU','Criminal Investigations Unit'),
 ('Dispatch','Emergency communications and dispatch operations'),
 ('K9','Canine operations and K9 unit training')
on conflict(name) do nothing;

-- AFTER creating your first account, promote it to system administrator:
-- update public.profiles set role='admin' where email='YOUR-EMAIL-HERE';
--
-- Admin-approved conflict override (run only after reviewing the conflict):
-- update public.trainings set conflict_override=true where id='TRAINING-UUID';
-- This override is intentionally not exposed as a normal user-facing form control.
