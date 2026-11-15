-- BCSO Training Operations Center: edit an existing scheduled training.
-- Run after schema.sql and public-cancellation-migration.sql.
-- Training Command permission is checked server-side; ordinary users must
-- supply the one-time cancellation code issued when the training was posted.

create or replace function public.edit_training_with_code(
  target_training_id uuid,
  supplied_code text,
  training_title text,
  target_division_id uuid,
  training_instructor text,
  training_description text,
  training_starts_at timestamptz,
  training_ends_at timestamptz,
  training_location text,
  training_capacity integer
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  training_row public.trainings%rowtype;
  command_access boolean;
  time_changed boolean;
begin
  command_access := coalesce(public.is_training_command(), false);

  -- Serialize time edits with other schedule writes.
  perform pg_advisory_xact_lock(71924501);

  select *
    into training_row
  from public.trainings
  where id = target_training_id
  for update;

  if not found then
    raise exception 'Training not found.';
  end if;

  if training_row.status <> 'scheduled' then
    raise exception 'Only scheduled trainings can be edited.';
  end if;

  -- Public scheduling uses a one-time code. Training Command can edit
  -- through its authenticated allowlist membership instead.
  if not command_access then
    if training_row.cancellation_code_hash is null
       or supplied_code is null
       or btrim(supplied_code) = ''
       or extensions.crypt(btrim(supplied_code), training_row.cancellation_code_hash)
          <> training_row.cancellation_code_hash then
      raise exception 'Incorrect cancellation code. Enter the code issued when this training was posted.'
        using errcode = '42501';
    end if;
  end if;

  if training_title is null
     or char_length(btrim(training_title)) not between 2 and 120 then
    raise exception 'Training title must be between 2 and 120 characters.';
  end if;

  if training_instructor is null
     or char_length(btrim(training_instructor)) = 0
     or char_length(btrim(training_instructor)) > 100 then
    raise exception 'Instructor is required and must be 100 characters or fewer.';
  end if;

  if training_description is not null
     and char_length(training_description) > 2000 then
    raise exception 'Description must be 2,000 characters or fewer.';
  end if;

  if training_location is not null
     and char_length(training_location) > 150 then
    raise exception 'Location must be 150 characters or fewer.';
  end if;

  if training_starts_at is null
     or training_ends_at is null
     or training_ends_at <= training_starts_at then
    raise exception 'End time must be later than start time.';
  end if;

  if training_capacity is not null
     and training_capacity not between 1 and 500 then
    raise exception 'Maximum participants must be between 1 and 500.';
  end if;

  if not exists (
    select 1
    from public.divisions d
    where d.id = target_division_id
      and d.is_active = true
  ) then
    raise exception 'Select an active division.';
  end if;

  time_changed :=
    training_starts_at is distinct from training_row.starts_at
    or training_ends_at is distinct from training_row.ends_at;

  if time_changed and training_starts_at <= now() then
    raise exception 'A changed training time must be in the future.';
  end if;

  -- An overlap that Training Command previously approved may retain its
  -- existing time for detail edits. Changing those times requires Command.
  if coalesce(training_row.conflict_override, false)
     and time_changed
     and not command_access then
    raise exception 'This training has an approved scheduling overlap. Training Command must change its date or time.';
  end if;

  if time_changed then
    -- The existing database trigger checks for conflicts and rejects
    -- overlaps unless this training already has a Command-approved override.
    update public.trainings
    set division_id = target_division_id,
        title = btrim(training_title),
        instructor = btrim(training_instructor),
        description = nullif(btrim(coalesce(training_description, '')), ''),
        starts_at = training_starts_at,
        ends_at = training_ends_at,
        location = nullif(btrim(coalesce(training_location, '')), ''),
        capacity = training_capacity
    where id = target_training_id;
  else
    -- Avoid firing the time-overlap trigger for a title/description-only edit.
    update public.trainings
    set division_id = target_division_id,
        title = btrim(training_title),
        instructor = btrim(training_instructor),
        description = nullif(btrim(coalesce(training_description, '')), ''),
        location = nullif(btrim(coalesce(training_location, '')), ''),
        capacity = training_capacity
    where id = target_training_id;
  end if;

  return true;
end;
$$;

revoke all on function public.edit_training_with_code(
  uuid, text, text, uuid, text, text, timestamptz, timestamptz, text, integer
) from public;

grant execute on function public.edit_training_with_code(
  uuid, text, text, uuid, text, text, timestamptz, timestamptz, text, integer
) to anon, authenticated;

notify pgrst, 'reload schema';
