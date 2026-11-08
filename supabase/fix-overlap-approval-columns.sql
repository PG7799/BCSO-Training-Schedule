-- One-time repair for Training Command overlap approvals.
-- Run this in the Supabase SQL Editor for the same project used by the website.
-- Safe to run more than once.

alter table public.trainings
  add column if not exists conflict_override boolean not null default false,
  add column if not exists conflict_approved_by uuid references auth.users(id),
  add column if not exists conflict_approved_at timestamptz;

notify pgrst, 'reload schema';
