-- =============================================================================
-- Batch 3B: append-only lead activity ledger + automatic audit + note RPC.
-- Append-only migration; existing committed migrations are untouched.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- lead_activities: immutable history of customer-facing lead changes
-- ---------------------------------------------------------------------------
create table public.lead_activities (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete restrict,
  lead_id             uuid not null,
  -- actor: the authenticated user (auth.uid()) at the time; NULL for non-user (service) writers.
  -- ON DELETE SET NULL keeps history if the profile is ever removed; the snapshot keeps the name.
  actor_id            uuid references public.profiles (id) on delete set null,
  actor_display_name  text,
  activity_type       text not null,
  old_value           text,
  new_value           text,
  note                text,
  request_id          uuid,
  created_at          timestamptz not null default now(),
  constraint ck_lead_activities_type check (activity_type in ('status_changed', 'follow_up_changed', 'note_added')),
  constraint ck_lead_activities_actor_name_length check (actor_display_name is null or length(actor_display_name) <= 100),
  constraint ck_lead_activities_values_length check (
    (old_value is null or length(old_value) <= 64) and (new_value is null or length(new_value) <= 64)),
  constraint ck_lead_activities_note_length check (note is null or (length(note) between 1 and 2000 and btrim(note) <> '')),
  -- shape per type: a change carries old/new and a genuine difference; a note carries text + request id
  constraint ck_lead_activities_shape check (
    (activity_type in ('status_changed', 'follow_up_changed')
       and note is null and request_id is null
       and old_value is distinct from new_value)
    or
    (activity_type = 'note_added'
       and note is not null and request_id is not null
       and old_value is null and new_value is null)),
  -- the lead must belong to the SAME business (composite FK onto leads(id, business_id))
  constraint fk_lead_activities_lead_same_business
    foreign key (lead_id, business_id) references public.leads (id, business_id) on delete restrict
);
comment on table public.lead_activities is
  'Append-only lead history: status/follow-up changes (written by trigger) and customer notes (written by add_lead_note). Never updated.';

-- idempotent note submission: one note per (business, lead, actor, client request id)
create unique index uq_lead_activities_note_request
  on public.lead_activities (business_id, lead_id, actor_id, request_id)
  where request_id is not null;
create index ix_lead_activities_lead_created on public.lead_activities (lead_id, created_at desc);
create index ix_lead_activities_business_created on public.lead_activities (business_id, created_at desc);

-- Immutable: every UPDATE is refused for every role; DELETE only by privileged roles
-- (migrations/resets/test cleanup), never by anon/authenticated.
create or replace function private.lead_activities_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'lead_activities is append-only' using errcode = 'check_violation';
  end if;
  if current_user in ('anon', 'authenticated') then
    raise exception 'lead_activities rows cannot be deleted by application users' using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;
revoke all on function private.lead_activities_append_only() from public;

create trigger trg_lead_activities_append_only
  before update or delete on public.lead_activities
  for each row execute function private.lead_activities_append_only();

-- grants: anon nothing; authenticated read-only (rows limited by RLS); no direct insert for users
revoke all on table public.lead_activities from public, anon, authenticated;
grant all on table public.lead_activities to service_role;
grant select on table public.lead_activities to authenticated;

alter table public.lead_activities enable row level security;
alter table public.lead_activities force  row level security;

create policy lead_activities_select_member_or_admin
  on public.lead_activities
  for select
  to authenticated
  using (
    business_id in (select private.active_business_ids())
    or (select private.is_platform_admin())
  );
-- no INSERT / UPDATE / DELETE policy for any role

-- ---------------------------------------------------------------------------
-- Automatic audit of leads.status / leads.follow_up_at changes.
-- AFTER UPDATE in the same transaction: a failing insert rolls the update back.
-- Actor = auth.uid() (NULL for non-user writers); name snapshot from profiles.
-- SECURITY DEFINER because application users hold no INSERT on the ledger.
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
            to_char(old.follow_up_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            to_char(new.follow_up_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  end if;
  return new;
end;
$$;
revoke all on function private.audit_lead_changes() from public;

create trigger trg_zz_leads_audit_changes
  after update of status, follow_up_at on public.leads
  for each row execute function private.audit_lead_changes();

-- ---------------------------------------------------------------------------
-- add_lead_note: the ONLY way an application user writes to the ledger.
-- authenticated-only; actor from auth.uid(); lead/business resolved internally;
-- authorization = active membership + active profile + active business
-- (private.active_business_ids()); idempotent on (business, lead, actor, request id).
-- ---------------------------------------------------------------------------
create or replace function public.add_lead_note(p_lead_id uuid, p_note text, p_request_id uuid)
returns table (activity_id uuid, created_at timestamptz, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := auth.uid();
  v_name     text;
  v_business uuid;
  v_note     text;
  v_existing public.lead_activities%rowtype;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'invalid_parameter_value';
  end if;
  v_note := btrim(coalesce(p_note, ''));
  if v_note = '' or length(v_note) > 2000 then
    raise exception 'note must be 1-2000 characters' using errcode = 'invalid_parameter_value';
  end if;

  -- opaque: nonexistent, archived, other-tenant and revoked-access leads all look the same
  select l.business_id into v_business
  from public.leads l
  where l.id = p_lead_id
    and l.archived_at is null
    and l.business_id in (select private.active_business_ids());
  if not found then
    raise exception 'lead not found' using errcode = 'no_data_found';
  end if;

  select a.* into v_existing
  from public.lead_activities a
  where a.business_id = v_business and a.lead_id = p_lead_id and a.actor_id = v_actor and a.request_id = p_request_id;
  if found then
    return query select v_existing.id, v_existing.created_at, true;
    return;
  end if;

  select p.display_name into v_name from public.profiles p where p.id = v_actor;
  begin
    insert into public.lead_activities (business_id, lead_id, actor_id, actor_display_name, activity_type, note, request_id)
    values (v_business, p_lead_id, v_actor, v_name, 'note_added', v_note, p_request_id)
    returning public.lead_activities.id, public.lead_activities.created_at into v_existing.id, v_existing.created_at;
  exception when unique_violation then
    select a.* into v_existing from public.lead_activities a
    where a.business_id = v_business and a.lead_id = p_lead_id and a.actor_id = v_actor and a.request_id = p_request_id;
    if not found then raise; end if;
    return query select v_existing.id, v_existing.created_at, true;
    return;
  end;
  return query select v_existing.id, v_existing.created_at, false;
end;
$$;
comment on function public.add_lead_note(uuid, text, uuid) is
  'Append a customer note to an accessible lead of the caller''s active business. Idempotent per client request id.';

revoke all on function public.add_lead_note(uuid, text, uuid) from public;
revoke all on function public.add_lead_note(uuid, text, uuid) from anon;
grant execute on function public.add_lead_note(uuid, text, uuid) to authenticated;
