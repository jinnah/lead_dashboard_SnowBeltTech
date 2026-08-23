-- =============================================================================
-- Batch 3C: audited lead assignment (append-only migration).
--   * lead_activities gains the `assignment_changed` type plus nullable
--     display-name snapshots for the old/new assignee (no FK to profiles).
--   * The leads audit trigger also fires on assigned_to changes.
--   * public.set_lead_assignee(lead, assignee) — the ONLY way application users
--     change assignment (authenticated only, owner/manager of the lead's active
--     business, assignee must be an active member with an active profile).
--   * Index for tenant-scoped workload filtering.
-- Customers keep NO direct UPDATE on leads.assigned_to; RLS, grants, note
-- idempotency and the append-only ledger are unchanged; no history rewritten.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Activity model: new type + assignee display snapshots
-- ---------------------------------------------------------------------------
alter table public.lead_activities
  add column old_display_value text,
  add column new_display_value text;
comment on column public.lead_activities.old_display_value is
  'Best-effort display-name snapshot of the previous assignee (assignment_changed only). Historical; never updated; may be null.';
comment on column public.lead_activities.new_display_value is
  'Best-effort display-name snapshot of the new assignee (assignment_changed only). Historical; never updated; may be null.';

alter table public.lead_activities drop constraint ck_lead_activities_type;
alter table public.lead_activities add constraint ck_lead_activities_type
  check (activity_type in ('status_changed', 'follow_up_changed', 'assignment_changed', 'note_added'));

alter table public.lead_activities add constraint ck_lead_activities_display_length
  check ((old_display_value is null or length(old_display_value) <= 100)
     and (new_display_value is null or length(new_display_value) <= 100));

-- display snapshots exist only on assignment rows; assignment old/new are UUID text
alter table public.lead_activities drop constraint ck_lead_activities_shape;
alter table public.lead_activities add constraint ck_lead_activities_shape
  check (
    (activity_type in ('status_changed', 'follow_up_changed')
       and note is null and request_id is null
       and old_display_value is null and new_display_value is null
       and old_value is distinct from new_value)
    or
    (activity_type = 'assignment_changed'
       and note is null and request_id is null
       and old_value is distinct from new_value
       and (old_value is null or old_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       and (new_value is null or new_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    or
    (activity_type = 'note_added'
       and note is not null and request_id is not null
       and old_value is null and new_value is null
       and old_display_value is null and new_display_value is null));

-- ---------------------------------------------------------------------------
-- Audit trigger now covers assigned_to (same signature/posture as before)
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
  v_old_assignee_name text;
  v_new_assignee_name text;
begin
  if new.status is not distinct from old.status
     and new.follow_up_at is not distinct from old.follow_up_at
     and new.assigned_to is not distinct from old.assigned_to then
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
  if new.assigned_to is distinct from old.assigned_to then
    -- best-effort snapshots: a profile being deleted in this statement yields null
    if old.assigned_to is not null then
      select p.display_name into v_old_assignee_name from public.profiles p where p.id = old.assigned_to;
    end if;
    if new.assigned_to is not null then
      select p.display_name into v_new_assignee_name from public.profiles p where p.id = new.assigned_to;
    end if;
    insert into public.lead_activities (business_id, lead_id, actor_id, actor_display_name, activity_type, old_value, new_value, old_display_value, new_display_value)
    values (new.business_id, new.id, v_actor, v_name, 'assignment_changed',
            old.assigned_to::text, new.assigned_to::text, v_old_assignee_name, v_new_assignee_name);
  end if;
  return new;
end;
$$;
revoke all on function private.audit_lead_changes() from public;

drop trigger if exists trg_zz_leads_audit_changes on public.leads;
create trigger trg_zz_leads_audit_changes
  after update of status, follow_up_at, assigned_to on public.leads
  for each row execute function private.audit_lead_changes();

-- ---------------------------------------------------------------------------
-- Workload filtering index (tenant, assignee, received time)
-- ---------------------------------------------------------------------------
create index ix_leads_business_assignee_created
  on public.leads (business_id, assigned_to, created_at desc);

-- ---------------------------------------------------------------------------
-- set_lead_assignee: the only assignment path for application users
-- ---------------------------------------------------------------------------
create or replace function public.set_lead_assignee(p_lead_id uuid, p_assignee_id uuid)
returns table (lead_id uuid, assigned_to uuid, changed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_lead  public.leads%rowtype;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  -- Serialize concurrent changes: lock the lead row first, then authorize.
  select l.* into v_lead from public.leads l where l.id = p_lead_id for update;
  if not found or v_lead.archived_at is not null then
    raise exception 'not available' using errcode = 'no_data_found';
  end if;

  -- Caller: active owner/manager membership + active profile + active business, for THIS lead's business.
  if not exists (
    select 1
    from public.business_memberships m
    join public.profiles p on p.id = m.user_id
    join public.businesses b on b.id = m.business_id
    where m.user_id = v_actor
      and m.business_id = v_lead.business_id
      and m.status = 'active'
      and m.role in ('BUSINESS_OWNER', 'BUSINESS_MANAGER')
      and p.is_active
      and b.status = 'active'
  ) then
    raise exception 'not available' using errcode = 'no_data_found';   -- opaque: same as unknown lead
  end if;

  -- Assignee (when given): active member with an active profile in the SAME business.
  if p_assignee_id is not null and not exists (
    select 1
    from public.business_memberships m
    join public.profiles p on p.id = m.user_id
    where m.user_id = p_assignee_id
      and m.business_id = v_lead.business_id
      and m.status = 'active'
      and p.is_active
  ) then
    raise exception 'not available' using errcode = 'no_data_found';
  end if;

  if v_lead.assigned_to is not distinct from p_assignee_id then
    return query select v_lead.id, v_lead.assigned_to, false;   -- no-op: no update, no activity
    return;
  end if;

  update public.leads l set assigned_to = p_assignee_id where l.id = v_lead.id;   -- audited by trigger
  return query select v_lead.id, p_assignee_id, true;
end;
$$;
comment on function public.set_lead_assignee(uuid, uuid) is
  'Assign (or unassign with NULL) a lead of the caller''s active business. Caller must be an active owner/manager; assignee must be an active member. Audited as assignment_changed.';

revoke all on function public.set_lead_assignee(uuid, uuid) from public;
revoke all on function public.set_lead_assignee(uuid, uuid) from anon;
grant execute on function public.set_lead_assignee(uuid, uuid) to authenticated;
