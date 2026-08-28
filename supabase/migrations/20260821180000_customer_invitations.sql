-- =============================================================================
-- Batch 4B: invitation-only customer provisioning (append-only migration).
--   * public.customer_invitations — durable invitation records
--     (prepared -> sent -> accepted, prepared -> failed, prepared/sent -> revoked).
--   * public.customer_access_events — immutable customer-access administration
--     ledger (no emails, no tokens, no PII beyond historical UUIDs/snapshots).
--   * Administrator RPCs: prepare / mark sent / mark failed / revoke invitation,
--     set member role, set member status (last-owner protected).
--   * accept_customer_invitation(): the ONLY path that turns an invitation into
--     a profile + membership, driven entirely by auth.uid() and auth.users.
-- Public signup stays disabled; PLATFORM_ADMIN can never be invited or targeted;
-- customers hold no direct writes anywhere here. No existing migration changes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- customer_invitations
-- ---------------------------------------------------------------------------
create table public.customer_invitations (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null references public.businesses (id) on delete restrict,
  email                    text not null,
  display_name             text not null,
  role                     text not null,
  status                   text not null default 'prepared',
  -- Supabase Auth account created for this invitation. Historical: no FK, so
  -- removing an auth user never rewrites or blocks invitation history.
  auth_user_id             uuid,
  expires_at               timestamptz not null,
  created_at               timestamptz not null default now(),
  sent_at                  timestamptz,
  accepted_at              timestamptz,
  closed_at                timestamptz,   -- failed or revoked time
  -- historical creating administrator (auth.uid() at the time; no FK)
  created_by               uuid not null,
  created_by_display_name  text,
  constraint ck_customer_invitations_email check (
    email = lower(btrim(email)) and length(email) between 6 and 320
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint ck_customer_invitations_display_name check (display_name = btrim(display_name) and length(display_name) between 1 and 100),
  constraint ck_customer_invitations_role check (role in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF')),
  constraint ck_customer_invitations_status check (status in ('prepared', 'sent', 'accepted', 'failed', 'revoked')),
  constraint ck_customer_invitations_creator_name check (created_by_display_name is null or length(created_by_display_name) <= 100),
  -- per-state shape: timestamps and the bound auth user follow the lifecycle
  constraint ck_customer_invitations_shape check (
    (status = 'prepared' and auth_user_id is null and sent_at is null and accepted_at is null and closed_at is null)
    or (status = 'sent'     and auth_user_id is not null and sent_at is not null and accepted_at is null and closed_at is null)
    or (status = 'accepted' and auth_user_id is not null and sent_at is not null and accepted_at is not null and closed_at is null)
    or (status = 'failed'   and accepted_at is null and closed_at is not null)
    or (status = 'revoked'  and accepted_at is null and closed_at is not null))
);
comment on table public.customer_invitations is
  'Invitation-only customer provisioning. Never stores passwords, tokens, hashes, links or Auth responses. Rows are never deleted by application users.';

-- one LIVE invitation per normalized email, race-safe (partial unique index)
create unique index uq_customer_invitations_live_email
  on public.customer_invitations (email) where status in ('prepared', 'sent');
create index ix_customer_invitations_business_created on public.customer_invitations (business_id, created_at desc);
create index ix_customer_invitations_auth_user on public.customer_invitations (auth_user_id) where auth_user_id is not null;

-- app roles hold no write grants; this trigger is defense in depth
create or replace function private.customer_invitations_protect()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'customer_invitations rows can only change through reviewed RPCs' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function private.customer_invitations_protect() from public;

create trigger trg_customer_invitations_protect
  before update or delete on public.customer_invitations
  for each row execute function private.customer_invitations_protect();

revoke all on table public.customer_invitations from public, anon, authenticated;
grant all on table public.customer_invitations to service_role;
grant select on table public.customer_invitations to authenticated;   -- rows limited to platform admins by RLS

alter table public.customer_invitations enable row level security;
alter table public.customer_invitations force  row level security;

create policy customer_invitations_select_platform_admin
  on public.customer_invitations
  for select
  to authenticated
  using ((select private.is_platform_admin()));
-- no INSERT / UPDATE / DELETE policy for any role

-- ---------------------------------------------------------------------------
-- customer_access_events: immutable access-administration ledger
-- ---------------------------------------------------------------------------
create table public.customer_access_events (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete restrict,
  invitation_id       uuid references public.customer_invitations (id) on delete restrict,
  -- historical identifiers: intentionally NOT foreign keys to profiles
  target_user_id      uuid,
  actor_id            uuid not null,
  actor_display_name  text,
  event_type          text not null,
  old_value           text,
  new_value           text,
  created_at          timestamptz not null default now(),
  constraint ck_customer_access_events_type check (event_type in (
    'invitation_prepared', 'invitation_sent', 'invitation_failed', 'invitation_revoked', 'invitation_accepted',
    'membership_role_changed', 'membership_status_changed')),
  constraint ck_customer_access_events_actor_name check (actor_display_name is null or length(actor_display_name) <= 100),
  -- values are allow-listed roles/statuses only — never emails, names or free text
  constraint ck_customer_access_events_shape check (
    (event_type in ('invitation_prepared', 'invitation_failed', 'invitation_revoked')
       and invitation_id is not null and target_user_id is null and old_value is null and new_value is null)
    or
    (event_type in ('invitation_sent', 'invitation_accepted')
       and invitation_id is not null and target_user_id is not null and old_value is null and new_value is null)
    or
    (event_type = 'membership_role_changed'
       and invitation_id is null and target_user_id is not null
       and old_value in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF')
       and new_value in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF')
       and old_value <> new_value)
    or
    (event_type = 'membership_status_changed'
       and invitation_id is null and target_user_id is not null
       and old_value in ('active', 'inactive') and new_value in ('active', 'inactive')
       and old_value <> new_value))
);
comment on table public.customer_access_events is
  'Append-only customer-access administration history. Allow-listed role/status values and historical UUIDs/snapshots only; never emails, tokens or request bodies. Never updated.';

create index ix_customer_access_events_business_created on public.customer_access_events (business_id, created_at desc);

-- UPDATE refused for EVERY role (postgres included); DELETE only privileged
create or replace function private.customer_access_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'customer_access_events is append-only' using errcode = 'check_violation';
  end if;
  if current_user in ('anon', 'authenticated') then
    raise exception 'customer_access_events rows cannot be deleted by application users' using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;
revoke all on function private.customer_access_events_append_only() from public;

create trigger trg_customer_access_events_append_only
  before update or delete on public.customer_access_events
  for each row execute function private.customer_access_events_append_only();

revoke all on table public.customer_access_events from public, anon, authenticated;
grant all on table public.customer_access_events to service_role;
grant select on table public.customer_access_events to authenticated;

alter table public.customer_access_events enable row level security;
alter table public.customer_access_events force  row level security;

create policy customer_access_events_select_platform_admin
  on public.customer_access_events
  for select
  to authenticated
  using ((select private.is_platform_admin()));
-- no INSERT / UPDATE / DELETE policy for any role

-- ---------------------------------------------------------------------------
-- helper: does the business have an effective active owner (other than p_except)?
-- ---------------------------------------------------------------------------
create or replace function private.has_other_effective_owner(p_business_id uuid, p_except uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_memberships m
    join public.profiles p on p.id = m.user_id
    where m.business_id = p_business_id
      and m.role = 'BUSINESS_OWNER'
      and m.status = 'active'
      and p.is_active
      and p.platform_role is null
      and m.user_id is distinct from p_except
  );
$$;
comment on function private.has_other_effective_owner(uuid, uuid) is
  'True when the business keeps at least one effective active BUSINESS_OWNER (active membership + active customer profile) besides the given user.';
revoke all on function private.has_other_effective_owner(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_prepare_customer_invitation
-- ---------------------------------------------------------------------------
create or replace function public.admin_prepare_customer_invitation(p_business_id uuid, p_email text, p_display_name text, p_role text)
returns table (invitation_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_biz   public.businesses%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_id    uuid;
begin
  select * into v_actor from private.platform_admin_actor();

  if length(v_email) < 6 or length(v_email) > 320 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invitation email is invalid' using errcode = 'invalid_parameter_value';
  end if;
  if length(v_name) < 1 or length(v_name) > 100 then
    raise exception 'display name must be 1-100 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_role is null or p_role not in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF') then
    raise exception 'unsupported customer role' using errcode = 'invalid_parameter_value';
  end if;

  select b.* into v_biz from public.businesses b where b.id = p_business_id for share;
  if not found then
    raise exception 'business not found' using errcode = 'no_data_found';
  end if;
  if v_biz.status <> 'active' then
    raise exception 'business is not active' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- one live invitation per email, checked FIRST so a sent invitation reports as
  -- duplicate rather than already-registered (the partial unique index also
  -- enforces this under concurrent requests)
  if exists (select 1 from public.customer_invitations i where i.email = v_email and i.status in ('prepared', 'sent')) then
    raise exception 'invitation already active for this email' using errcode = 'unique_violation';
  end if;
  -- single-business provisioning: the email must not already hold an Auth account
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'email already registered' using errcode = 'invalid_parameter_value';
  end if;
  -- an unprovisioned business (no effective active owner) starts with its owner
  if p_role <> 'BUSINESS_OWNER' and not private.has_other_effective_owner(v_biz.id, null) then
    raise exception 'first member must be a business owner' using errcode = 'invalid_parameter_value';
  end if;

  -- expiry mirrors the local Supabase invitation-token lifetime ([auth.email] otp_expiry = 3600)
  insert into public.customer_invitations (business_id, email, display_name, role, status, expires_at, created_by, created_by_display_name)
  values (v_biz.id, v_email, v_name, p_role, 'prepared', now() + interval '1 hour', v_actor.actor_id, v_actor.actor_display_name)
  returning id into v_id;

  insert into public.customer_access_events (business_id, invitation_id, actor_id, actor_display_name, event_type)
  values (v_biz.id, v_id, v_actor.actor_id, v_actor.actor_display_name, 'invitation_prepared');

  return query select v_id;
end;
$$;
comment on function public.admin_prepare_customer_invitation(uuid, text, text, text) is
  'Platform administrators only. Validates and records a customer invitation (prepared) for an active business and audits invitation_prepared. Never returns emails or tokens.';

-- ---------------------------------------------------------------------------
-- admin_mark_customer_invitation_sent
-- ---------------------------------------------------------------------------
create or replace function public.admin_mark_customer_invitation_sent(p_invitation_id uuid, p_auth_user_id uuid)
returns table (invitation_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_inv   public.customer_invitations%rowtype;
begin
  select * into v_actor from private.platform_admin_actor();

  select i.* into v_inv from public.customer_invitations i where i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  if v_inv.status <> 'prepared' then
    raise exception 'invitation is not awaiting delivery' using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- never trust the supplied Auth user id: it must exist and carry this exact email
  if p_auth_user_id is null or not exists (
    select 1 from auth.users u where u.id = p_auth_user_id and lower(u.email) = v_inv.email
  ) then
    raise exception 'auth user does not match invitation' using errcode = 'invalid_parameter_value';
  end if;

  update public.customer_invitations i
     set status = 'sent', auth_user_id = p_auth_user_id, sent_at = now()
   where i.id = v_inv.id;

  insert into public.customer_access_events (business_id, invitation_id, target_user_id, actor_id, actor_display_name, event_type)
  values (v_inv.business_id, v_inv.id, p_auth_user_id, v_actor.actor_id, v_actor.actor_display_name, 'invitation_sent');

  return query select v_inv.id, 'sent'::text;
end;
$$;
comment on function public.admin_mark_customer_invitation_sent(uuid, uuid) is
  'Platform administrators only. prepared -> sent after Supabase Auth created the invited account; binds the historical Auth user after database-side email verification.';

-- ---------------------------------------------------------------------------
-- admin_mark_customer_invitation_failed
-- ---------------------------------------------------------------------------
create or replace function public.admin_mark_customer_invitation_failed(p_invitation_id uuid)
returns table (invitation_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_inv   public.customer_invitations%rowtype;
begin
  select * into v_actor from private.platform_admin_actor();

  select i.* into v_inv from public.customer_invitations i where i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  if v_inv.status <> 'prepared' then
    raise exception 'invitation is not awaiting delivery' using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.customer_invitations i set status = 'failed', closed_at = now() where i.id = v_inv.id;

  insert into public.customer_access_events (business_id, invitation_id, actor_id, actor_display_name, event_type)
  values (v_inv.business_id, v_inv.id, v_actor.actor_id, v_actor.actor_display_name, 'invitation_failed');

  return query select v_inv.id, 'failed'::text;
end;
$$;
comment on function public.admin_mark_customer_invitation_failed(uuid) is
  'Platform administrators only. prepared -> failed when Auth delivery/account creation fails. A failed invitation can never grant membership.';

-- ---------------------------------------------------------------------------
-- admin_revoke_customer_invitation
-- ---------------------------------------------------------------------------
create or replace function public.admin_revoke_customer_invitation(p_business_id uuid, p_invitation_id uuid)
returns table (auth_user_id uuid, changed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_inv   public.customer_invitations%rowtype;
begin
  select * into v_actor from private.platform_admin_actor();

  select i.* into v_inv
  from public.customer_invitations i
  where i.id = p_invitation_id and i.business_id = p_business_id
  for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  if v_inv.status = 'revoked' then
    return query select v_inv.auth_user_id, false;   -- safe no-op: no duplicate audit event
    return;
  end if;
  if v_inv.status not in ('prepared', 'sent') then
    raise exception 'invitation is not revocable' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- effective immediately: acceptance checks status under the same row lock
  update public.customer_invitations i set status = 'revoked', closed_at = now() where i.id = v_inv.id;

  insert into public.customer_access_events (business_id, invitation_id, actor_id, actor_display_name, event_type)
  values (v_inv.business_id, v_inv.id, v_actor.actor_id, v_actor.actor_display_name, 'invitation_revoked');

  return query select v_inv.auth_user_id, true;
end;
$$;
comment on function public.admin_revoke_customer_invitation(uuid, uuid) is
  'Platform administrators only. prepared/sent -> revoked (accepted is never revocable here). Returns the bound Auth user id so the trusted server route can clean up the unaccepted Auth account AFTER the database revocation.';

-- ---------------------------------------------------------------------------
-- accept_customer_invitation: the only path from invitation to membership
-- ---------------------------------------------------------------------------
create or replace function public.accept_customer_invitation()
returns table (business_id uuid, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_inv   public.customer_invitations%rowtype;
  v_biz   public.businesses%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;
  -- platform administrators are never provisioned as customers
  if exists (select 1 from public.profiles p where p.id = v_uid and p.platform_role is not null) then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;

  -- the invitation bound to THIS auth user and THIS email (locked)
  select i.* into v_inv
  from public.customer_invitations i
  where i.auth_user_id = v_uid and i.email = v_email and i.status in ('sent', 'accepted')
  order by i.created_at desc
  limit 1
  for update;
  if not found then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;

  if v_inv.status = 'accepted' then
    return query select v_inv.business_id, true;   -- idempotent replay for the same account
    return;
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;

  select b.* into v_biz from public.businesses b where b.id = v_inv.business_id for share;
  if not found or v_biz.status <> 'active' then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;

  -- conflict targets by constraint name: plpgsql would otherwise try to resolve
  -- the column list against this function's OUT parameters
  insert into public.profiles (id, display_name, platform_role, is_active)
  values (v_uid, v_inv.display_name, null, true)
  on conflict on constraint profiles_pkey do nothing;

  insert into public.business_memberships (business_id, user_id, role, status)
  values (v_inv.business_id, v_uid, v_inv.role, 'active')
  on conflict on constraint uq_business_memberships_business_user do nothing;

  update public.customer_invitations i set status = 'accepted', accepted_at = now() where i.id = v_inv.id;

  insert into public.customer_access_events (business_id, invitation_id, target_user_id, actor_id, actor_display_name, event_type)
  values (v_inv.business_id, v_inv.id, v_uid, v_uid, v_inv.display_name, 'invitation_accepted');

  return query select v_inv.business_id, false;
end;
$$;
comment on function public.accept_customer_invitation() is
  'Authenticated invited user only. Verifies the sent, unexpired invitation bound to auth.uid() and the auth.users email, then atomically creates the customer profile + active membership and records invitation_accepted. Idempotent for the same account; opaque P0002 otherwise.';

-- ---------------------------------------------------------------------------
-- admin_set_business_member_role
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_business_member_role(p_business_id uuid, p_user_id uuid, p_role text)
returns table (user_id uuid, role text, changed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_m     public.business_memberships%rowtype;
begin
  select * into v_actor from private.platform_admin_actor();

  if p_role is null or p_role not in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF') then
    raise exception 'unsupported customer role' using errcode = 'invalid_parameter_value';
  end if;

  -- serialize owner-count decisions per business
  perform 1 from public.businesses b where b.id = p_business_id for update;
  if not found then
    raise exception 'membership not found' using errcode = 'no_data_found';
  end if;

  select m.* into v_m
  from public.business_memberships m
  where m.business_id = p_business_id and m.user_id = p_user_id
  for update;
  if not found then
    raise exception 'membership not found' using errcode = 'no_data_found';
  end if;
  -- platform administrators are not customer-manageable targets
  if exists (select 1 from public.profiles p where p.id = v_m.user_id and p.platform_role is not null) then
    raise exception 'membership not found' using errcode = 'no_data_found';
  end if;

  if v_m.role = p_role then
    return query select v_m.user_id, v_m.role, false;   -- no-op: no audit row
    return;
  end if;
  -- never demote the last effective active owner
  if v_m.role = 'BUSINESS_OWNER' and v_m.status = 'active'
     and exists (select 1 from public.profiles p where p.id = v_m.user_id and p.is_active)
     and not private.has_other_effective_owner(p_business_id, v_m.user_id) then
    raise exception 'cannot demote the last active owner' using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.business_memberships m set role = p_role where m.id = v_m.id;

  insert into public.customer_access_events (business_id, target_user_id, actor_id, actor_display_name, event_type, old_value, new_value)
  values (p_business_id, v_m.user_id, v_actor.actor_id, v_actor.actor_display_name, 'membership_role_changed', v_m.role, p_role);

  return query select v_m.user_id, p_role, true;
end;
$$;
comment on function public.admin_set_business_member_role(uuid, uuid, text) is
  'Platform administrators only. Changes a customer membership role within its business. The last effective active owner can never be demoted; no-ops audit nothing.';

-- ---------------------------------------------------------------------------
-- admin_set_business_member_status
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_business_member_status(p_business_id uuid, p_user_id uuid, p_status text)
returns table (user_id uuid, status text, changed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_m     public.business_memberships%rowtype;
begin
  select * into v_actor from private.platform_admin_actor();

  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception 'unsupported membership status' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.businesses b where b.id = p_business_id for update;
  if not found then
    raise exception 'membership not found' using errcode = 'no_data_found';
  end if;

  select m.* into v_m
  from public.business_memberships m
  where m.business_id = p_business_id and m.user_id = p_user_id
  for update;
  if not found then
    raise exception 'membership not found' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_m.user_id and p.platform_role is not null) then
    raise exception 'membership not found' using errcode = 'no_data_found';
  end if;

  if v_m.status = p_status then
    return query select v_m.user_id, v_m.status, false;   -- no-op: no audit row
    return;
  end if;
  -- never deactivate the last effective active owner
  if p_status = 'inactive' and v_m.role = 'BUSINESS_OWNER' and v_m.status = 'active'
     and exists (select 1 from public.profiles p where p.id = v_m.user_id and p.is_active)
     and not private.has_other_effective_owner(p_business_id, v_m.user_id) then
    raise exception 'cannot deactivate the last active owner' using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.business_memberships m set status = p_status where m.id = v_m.id;

  insert into public.customer_access_events (business_id, target_user_id, actor_id, actor_display_name, event_type, old_value, new_value)
  values (p_business_id, v_m.user_id, v_actor.actor_id, v_actor.actor_display_name, 'membership_status_changed', v_m.status, p_status);

  return query select v_m.user_id, p_status, true;
end;
$$;
comment on function public.admin_set_business_member_status(uuid, uuid, text) is
  'Platform administrators only. active <-> inactive for a customer membership; deactivation revokes tenant access on the next request. The last effective active owner can never be deactivated; no-ops audit nothing.';

-- ---------------------------------------------------------------------------
-- Execute posture
-- ---------------------------------------------------------------------------
revoke all on function public.admin_prepare_customer_invitation(uuid, text, text, text) from public, anon;
revoke all on function public.admin_mark_customer_invitation_sent(uuid, uuid) from public, anon;
revoke all on function public.admin_mark_customer_invitation_failed(uuid) from public, anon;
revoke all on function public.admin_revoke_customer_invitation(uuid, uuid) from public, anon;
revoke all on function public.accept_customer_invitation() from public, anon;
revoke all on function public.admin_set_business_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.admin_set_business_member_status(uuid, uuid, text) from public, anon;
grant execute on function public.admin_prepare_customer_invitation(uuid, text, text, text) to authenticated;
grant execute on function public.admin_mark_customer_invitation_sent(uuid, uuid) to authenticated;
grant execute on function public.admin_mark_customer_invitation_failed(uuid) to authenticated;
grant execute on function public.admin_revoke_customer_invitation(uuid, uuid) to authenticated;
grant execute on function public.accept_customer_invitation() to authenticated;
grant execute on function public.admin_set_business_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.admin_set_business_member_status(uuid, uuid, text) to authenticated;
