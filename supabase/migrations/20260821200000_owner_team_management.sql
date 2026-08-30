-- =============================================================================
-- Customer-owner team management (append-only migration).
--
-- Product decision: the Owner/Manager distinction is ADMINISTRATIVE. An active
-- BUSINESS_OWNER of an ACTIVE business may now manage that business's team
-- through the SAME five reviewed RPCs the platform administrator uses -
-- prepare/mark-sent/mark-failed/revoke invitations and member role/status -
-- with strictly narrower authority than the administrator:
--
--   * owners may invite only BUSINESS_MANAGER / BUSINESS_STAFF (never OWNER)
--   * owners may never change or deactivate their OWN membership
--   * owners may never modify another OWNER's membership (read-only)
--   * platform-administrator targets stay opaque (P0002), as before
--   * suspended/archived businesses grant owners nothing (the actor gate
--     requires an ACTIVE business; administrators keep their existing reach)
--
-- Both callers share one authorization gate and one implementation, so every
-- existing invariant - one live invitation per email, single-business
-- provisioning, first-member-must-be-owner, last-owner protection, exact
-- provenance-marker cleanup, append-only customer_access_events audit rows -
-- applies identically to owner-initiated operations. Function signatures,
-- return contracts, error codes and the public RPC inventory (15) are
-- unchanged; platform-administrator behavior is unchanged.
--
-- SECURITY DEFINER is retained because these functions already are (they must
-- write memberships/invitations/audit rows that no direct policy allows);
-- each pins an empty search_path, fully qualifies objects, revokes PUBLIC and
-- re-checks authorization internally.
--
-- One NEW RLS policy lets an active owner SELECT their own business's
-- invitations (the Team & access page lists pending invitations); the ledger
-- customer_access_events remains administrator-only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- private.team_management_actor: the shared authorization gate.
-- Raises 42501 for anonymous callers. Returns actor_id = NULL (fail closed,
-- caller decides between 42501 and opaque P0002) when the caller is neither an
-- active platform administrator nor an effective active BUSINESS_OWNER
-- (active profile, no platform role, active membership) of the given ACTIVE
-- business.
-- ---------------------------------------------------------------------------
create function private.team_management_actor(
  p_business_id uuid,
  out actor_id uuid,
  out actor_display_name text,
  out is_admin boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select v_uid, p.display_name, true into actor_id, actor_display_name, is_admin
  from public.profiles p
  where p.id = v_uid and p.platform_role = 'PLATFORM_ADMIN' and p.is_active;
  if found then
    return;
  end if;
  select v_uid, p.display_name, false into actor_id, actor_display_name, is_admin
  from public.profiles p
  join public.business_memberships m on m.user_id = p.id
  join public.businesses b on b.id = m.business_id
  where p.id = v_uid
    and p.is_active
    and p.platform_role is null
    and m.business_id = p_business_id
    and m.role = 'BUSINESS_OWNER'
    and m.status = 'active'
    and b.status = 'active';
  if not found then
    actor_id := null;
    actor_display_name := null;
    is_admin := null;
  end if;
end;
$$;
comment on function private.team_management_actor(uuid) is
  'Shared team-management gate: active platform administrator (is_admin) or effective active BUSINESS_OWNER of the given ACTIVE business. 42501 for anonymous; NULL actor for everyone else so callers fail closed with 42501 or an opaque P0002.';
revoke all on function private.team_management_actor(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- private.owner_business_ids: businesses where the caller is an effective
-- active owner (used by the new invitations SELECT policy).
-- ---------------------------------------------------------------------------
create function private.owner_business_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id
  from public.business_memberships m
  join public.profiles p on p.id = m.user_id
  join public.businesses b on b.id = m.business_id
  where m.user_id = auth.uid()
    and m.role = 'BUSINESS_OWNER'
    and m.status = 'active'
    and p.is_active
    and p.platform_role is null
    and b.status = 'active';
$$;
comment on function private.owner_business_ids() is
  'Business ids where auth.uid() is an effective active BUSINESS_OWNER of an ACTIVE business. Empty for admins, managers, staff, inactive identities and suspended/archived businesses.';
revoke all on function private.owner_business_ids() from public, anon;
grant execute on function private.owner_business_ids() to authenticated;

-- Owners can LIST their own business's invitations (statuses/emails they
-- created the provisioning relationship for); everything else stays
-- administrator-only. No INSERT/UPDATE/DELETE policy is added - mutations go
-- exclusively through the reviewed RPCs.
create policy customer_invitations_select_business_owner
  on public.customer_invitations
  for select
  to authenticated
  using (business_id in (select private.owner_business_ids()));

-- ---------------------------------------------------------------------------
-- admin_prepare_customer_invitation: admin OR owner; owners invite M/S only
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
  select * into v_actor from private.team_management_actor(p_business_id);
  if v_actor.actor_id is null then
    raise exception 'platform administrator or business owner required' using errcode = 'insufficient_privilege';
  end if;

  if length(v_email) < 6 or length(v_email) > 320 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invitation email is invalid' using errcode = 'invalid_parameter_value';
  end if;
  if length(v_name) < 1 or length(v_name) > 100 then
    raise exception 'display name must be 1-100 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_role is null or p_role not in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF') then
    raise exception 'unsupported customer role' using errcode = 'invalid_parameter_value';
  end if;
  -- owners never provision ownership: OWNER invitations stay with SnowBeltTech
  if not v_actor.is_admin and p_role = 'BUSINESS_OWNER' then
    raise exception 'unsupported customer role for business owner invitations' using errcode = 'invalid_parameter_value';
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
  'Platform administrators (any customer role) or the business''s own active owners (manager/staff only). Validates and records a customer invitation (prepared) for an active business and audits invitation_prepared. Never returns emails or tokens.';

-- ---------------------------------------------------------------------------
-- admin_mark_customer_invitation_sent: admin OR owner of the invitation's
-- business; every other authenticated caller gets the same opaque P0002 as an
-- unknown invitation id.
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
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select i.* into v_inv from public.customer_invitations i where i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  select * into v_actor from private.team_management_actor(v_inv.business_id);
  if v_actor.actor_id is null then
    -- opaque: foreign and unknown invitations are indistinguishable
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
  'Platform administrators or the business''s own active owners. prepared -> sent after Supabase Auth created the invited account; binds the historical Auth user after database-side email verification. Unauthorized callers receive the same opaque P0002 as an unknown invitation.';

-- ---------------------------------------------------------------------------
-- admin_mark_customer_invitation_failed: admin OR owner of the invitation's
-- business; the exact provenance-marker cleanup contract is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.admin_mark_customer_invitation_failed(p_invitation_id uuid)
returns table (invitation_id uuid, status text, cleanup_auth_user_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor     record;
  v_inv       public.customer_invitations%rowtype;
  v_candidate uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select i.* into v_inv from public.customer_invitations i where i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  select * into v_actor from private.team_management_actor(v_inv.business_id);
  if v_actor.actor_id is null then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  if v_inv.status <> 'prepared' then
    raise exception 'invitation is not awaiting delivery' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The Auth account created by THIS invitation attempt, if one was left
  -- behind. Provenance is EXACT: the account must carry this invitation's own
  -- UUID under the application-owned marker key, which only the server
  -- coordinator supplies at invite time. Everything after the marker check is
  -- defense in depth - never a substitute for it.
  select u.id into v_candidate
  from auth.users u
  where u.raw_user_meta_data ->> 'portal_invitation_id' = v_inv.id::text     -- exact provenance marker (required)
    and lower(u.email) = v_inv.email                                          -- defensive
    and u.created_at >= v_inv.created_at - interval '5 seconds'               -- defensive
    and not exists (select 1 from public.profiles p where p.id = u.id)        -- defensive
    and not exists (select 1 from public.business_memberships m where m.user_id = u.id)
    and not exists (select 1 from public.customer_invitations i2 where i2.auth_user_id = u.id and i2.id <> v_inv.id);

  update public.customer_invitations i
     set status = 'failed', closed_at = now(), auth_user_id = coalesce(v_candidate, i.auth_user_id)
   where i.id = v_inv.id;

  insert into public.customer_access_events (business_id, invitation_id, actor_id, actor_display_name, event_type)
  values (v_inv.business_id, v_inv.id, v_actor.actor_id, v_actor.actor_display_name, 'invitation_failed');

  return query select v_inv.id, 'failed'::text, v_candidate;
end;
$$;
comment on function public.admin_mark_customer_invitation_failed(uuid) is
  'Platform administrators or the business''s own active owners. prepared -> failed when Auth delivery/account creation fails; returns the Auth account created by this exact attempt - identified by the invitation''s own UUID persisted as the portal_invitation_id user-metadata marker at invite time (email/time/profile checks are defensive only) - so the trusted server coordinator can remove it. A failed invitation can never grant membership.';

-- ---------------------------------------------------------------------------
-- admin_revoke_customer_invitation: admin OR owner of the addressed business
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
  select * into v_actor from private.team_management_actor(p_business_id);
  if v_actor.actor_id is null then
    raise exception 'platform administrator or business owner required' using errcode = 'insufficient_privilege';
  end if;

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
  'Platform administrators or the business''s own active owners. prepared/sent -> revoked (accepted is never revocable here). Returns the bound Auth user id so the trusted server route can clean up the unaccepted Auth account AFTER the database revocation.';

-- ---------------------------------------------------------------------------
-- admin_set_business_member_role: admin OR owner; owner restrictions enforced
-- BEFORE any state comparison so self/owner targets learn nothing.
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
  v_biz   public.businesses%rowtype;
  v_m     public.business_memberships%rowtype;
begin
  select * into v_actor from private.team_management_actor(p_business_id);
  if v_actor.actor_id is null then
    raise exception 'platform administrator or business owner required' using errcode = 'insufficient_privilege';
  end if;

  if p_role is null or p_role not in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF') then
    raise exception 'unsupported customer role' using errcode = 'invalid_parameter_value';
  end if;

  -- serialize owner-count decisions per business; the role decision happens under this lock
  select b.* into v_biz from public.businesses b where b.id = p_business_id for update;
  if not found then
    raise exception 'membership not found' using errcode = 'no_data_found';
  end if;
  if v_biz.status = 'archived' then
    raise exception 'archived businesses cannot be changed' using errcode = 'object_not_in_prerequisite_state';
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
  -- owner path: never self, never another owner, never INTO ownership
  if not v_actor.is_admin then
    if v_m.user_id = v_actor.actor_id then
      raise exception 'own membership cannot be changed through team management' using errcode = 'invalid_parameter_value';
    end if;
    if v_m.role = 'BUSINESS_OWNER' or p_role = 'BUSINESS_OWNER' then
      raise exception 'owner memberships are managed by SnowBeltTech' using errcode = 'invalid_parameter_value';
    end if;
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
  'Platform administrators (any change) or the business''s own active owners (Manager <-> Staff only; never self, never owner targets). Archived businesses are non-operable (55000); the last effective active owner can never be demoted; no-ops audit nothing.';

-- ---------------------------------------------------------------------------
-- admin_set_business_member_status: admin OR owner, same owner restrictions
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
  v_biz   public.businesses%rowtype;
  v_m     public.business_memberships%rowtype;
begin
  select * into v_actor from private.team_management_actor(p_business_id);
  if v_actor.actor_id is null then
    raise exception 'platform administrator or business owner required' using errcode = 'insufficient_privilege';
  end if;

  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception 'unsupported membership status' using errcode = 'invalid_parameter_value';
  end if;

  select b.* into v_biz from public.businesses b where b.id = p_business_id for update;
  if not found then
    raise exception 'membership not found' using errcode = 'no_data_found';
  end if;
  if v_biz.status = 'archived' then
    raise exception 'archived businesses cannot be changed' using errcode = 'object_not_in_prerequisite_state';
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
  -- owner path: never self, never another owner
  if not v_actor.is_admin then
    if v_m.user_id = v_actor.actor_id then
      raise exception 'own membership cannot be changed through team management' using errcode = 'invalid_parameter_value';
    end if;
    if v_m.role = 'BUSINESS_OWNER' then
      raise exception 'owner memberships are managed by SnowBeltTech' using errcode = 'invalid_parameter_value';
    end if;
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
  'Platform administrators (any target) or the business''s own active owners (Manager/Staff targets only; never self, never owner targets). active <-> inactive within an ACTIVE or SUSPENDED business (archived is non-operable, 55000); deactivation revokes tenant access on the next request. The last effective active owner can never be deactivated; no-ops audit nothing.';

-- restate the execute posture explicitly for every replaced function
revoke all on function public.admin_prepare_customer_invitation(uuid, text, text, text) from public, anon;
revoke all on function public.admin_mark_customer_invitation_sent(uuid, uuid) from public, anon;
revoke all on function public.admin_mark_customer_invitation_failed(uuid) from public, anon;
revoke all on function public.admin_revoke_customer_invitation(uuid, uuid) from public, anon;
revoke all on function public.admin_set_business_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.admin_set_business_member_status(uuid, uuid, text) from public, anon;
grant execute on function public.admin_prepare_customer_invitation(uuid, text, text, text) to authenticated;
grant execute on function public.admin_mark_customer_invitation_sent(uuid, uuid) to authenticated;
grant execute on function public.admin_mark_customer_invitation_failed(uuid) to authenticated;
grant execute on function public.admin_revoke_customer_invitation(uuid, uuid) to authenticated;
grant execute on function public.admin_set_business_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.admin_set_business_member_status(uuid, uuid, text) to authenticated;
