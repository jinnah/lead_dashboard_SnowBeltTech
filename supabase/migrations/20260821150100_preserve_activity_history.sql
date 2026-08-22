-- =============================================================================
-- Batch 3B-H (corrective, append-only): immutable lead history must survive
-- account removal, and follow-up audit values must keep full precision.
--
--   F1  lead_activities.actor_id referenced profiles(id) ON DELETE SET NULL.
--       That referential action is an UPDATE, which the append-only trigger
--       refuses, so removing a profile (or its auth user) failed with 23514.
--       Fix: drop ONLY that foreign key. actor_id is a HISTORICAL actor
--       identifier captured from auth.uid() by reviewed code (audit trigger,
--       add_lead_note); it is not a live referential dependency. The
--       actor_display_name snapshot and the row itself never change.
--   F2  follow-up audit values were formatted to whole seconds, collapsing
--       distinct timestamptz values inside one second into identical strings
--       and tripping the genuine-change constraint. Fix: microsecond UTC
--       representation YYYY-MM-DD"T"HH24:MI:SS.US"Z" (fixed width, unambiguous).
--
-- Unchanged: append-only trigger for every role, RLS policies, grants, the
-- composite same-business FK to leads, note idempotency, function signatures,
-- SECURITY DEFINER, empty search_path, ownership, execution restrictions.
-- Historical rows are not rewritten.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- F1: drop only the actor_id -> profiles foreign key
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.lead_activities'::regclass
    and c.contype = 'f'
    and c.confrelid = 'public.profiles'::regclass
    and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.lead_activities'::regclass and attname = 'actor_id')];
  if v_name is null then
    raise exception 'expected actor_id foreign key on public.lead_activities not found';
  end if;
  execute format('alter table public.lead_activities drop constraint %I', v_name);
end;
$$;

comment on column public.lead_activities.actor_id is
  'Historical actor identifier (auth.uid() at the time of the activity). Intentionally NOT a foreign key: the value is preserved unchanged after the profile/account is removed. Set only by reviewed code (audit trigger, add_lead_note).';
comment on column public.lead_activities.actor_display_name is
  'Display name snapshot taken when the activity was recorded; never updated.';

-- ---------------------------------------------------------------------------
-- F2: microsecond-precision UTC audit values (same signature and posture)
-- ---------------------------------------------------------------------------
create or replace function private.audit_lead_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name  text;
begin
  if new.status is not distinct from old.status and new.follow_up_at is not distinct from old.follow_up_at then
    return new;  -- no-op: nothing to record
  end if;
  if v_actor is not null then
    select p.display_name into v_name from public.profiles p where p.id = v_actor;
  end if;
  if new.status is distinct from old.status then
    insert into public.lead_activities (business_id, lead_id, actor_id, actor_display_name, activity_type, old_value, new_value)
    values (new.business_id, new.id, v_actor, v_name, 'status_changed', old.status, new.status);
  end if;
  if new.follow_up_at is distinct from old.follow_up_at then
    insert into public.lead_activities (business_id, lead_id, actor_id, actor_display_name, activity_type, old_value, new_value)
    values (new.business_id, new.id, v_actor, v_name, 'follow_up_changed',
            to_char(old.follow_up_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            to_char(new.follow_up_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  end if;
  return new;
end;
$$;
revoke all on function private.audit_lead_changes() from public;
