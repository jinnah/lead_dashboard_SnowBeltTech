-- =============================================================================
-- Corrective pass for owner team management (append-only migration).
--
-- Profile activation is a PLATFORM-level control. A business owner could
-- previously stage role/status changes against a Manager/Staff member whose
-- profile SnowBeltTech had deactivated - the UI keyed its controls on the
-- membership status alone, and the owner path of the two member RPCs never
-- required the target profile to be active. Owners must not be able to (or be
-- told they can) act on an account SnowBeltTech has deactivated.
--
-- Correction: in the OWNER path of admin_set_business_member_role and
-- admin_set_business_member_status, the target's profile must be active. The
-- check sits with the other owner-target rules - BEFORE any state comparison
-- or no-op return - so a deactivated-profile target is always rejected with a
-- distinct 22023 (mapped app-side to the allow-listed `account_deactivated`
-- result), the membership stays unchanged, and no audit event is written.
-- The check runs only after the membership row was found inside the caller's
-- own authorized business, so foreign/unknown targets keep their existing
-- opaque P0002 and learn nothing from the new distinction.
--
-- Platform-administrator behavior is UNCHANGED: administrators keep their
-- existing authority to manage the membership state of profile-deactivated
-- users through the admin surface. Signatures, return contracts, error-code
-- families, grants, audit rows, last-owner protection, self/owner-target
-- protection, the actor gate, and the public RPC inventory (15) are unchanged.
-- =============================================================================

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
  -- owner path: never self, never another owner, never INTO ownership, and
  -- never a target whose PROFILE SnowBeltTech has deactivated
  if not v_actor.is_admin then
    if v_m.user_id = v_actor.actor_id then
      raise exception 'own membership cannot be changed through team management' using errcode = 'invalid_parameter_value';
    end if;
    if v_m.role = 'BUSINESS_OWNER' or p_role = 'BUSINESS_OWNER' then
      raise exception 'owner memberships are managed by SnowBeltTech' using errcode = 'invalid_parameter_value';
    end if;
    if not exists (select 1 from public.profiles p where p.id = v_m.user_id and p.is_active) then
      raise exception 'account is deactivated and managed by SnowBeltTech' using errcode = 'invalid_parameter_value';
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
  'Platform administrators (any change) or the business''s own active owners (Manager <-> Staff only; never self, never owner targets, never profile-deactivated targets). Archived businesses are non-operable (55000); the last effective active owner can never be demoted; no-ops audit nothing.';

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
  -- owner path: never self, never another owner, never a deactivated profile
  if not v_actor.is_admin then
    if v_m.user_id = v_actor.actor_id then
      raise exception 'own membership cannot be changed through team management' using errcode = 'invalid_parameter_value';
    end if;
    if v_m.role = 'BUSINESS_OWNER' then
      raise exception 'owner memberships are managed by SnowBeltTech' using errcode = 'invalid_parameter_value';
    end if;
    if not exists (select 1 from public.profiles p where p.id = v_m.user_id and p.is_active) then
      raise exception 'account is deactivated and managed by SnowBeltTech' using errcode = 'invalid_parameter_value';
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
  'Platform administrators (any target) or the business''s own active owners (Manager/Staff targets only; never self, never owner targets, never profile-deactivated targets). active <-> inactive within an ACTIVE or SUSPENDED business (archived is non-operable, 55000); deactivation revokes tenant access on the next request. The last effective active owner can never be deactivated; no-ops audit nothing.';

-- restate the execute posture explicitly for the replaced functions
revoke all on function public.admin_set_business_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.admin_set_business_member_status(uuid, uuid, text) from public, anon;
grant execute on function public.admin_set_business_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.admin_set_business_member_status(uuid, uuid, text) to authenticated;
