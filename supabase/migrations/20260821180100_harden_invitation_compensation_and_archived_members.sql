-- =============================================================================
-- Batch 4B corrective hardening (append-only migration). Two defects:
--
-- 1. Delivery-failure compensation could strand an Auth account. When
--    inviteUserByEmail fails AFTER GoTrue created the invited account, the
--    email stayed registered in auth.users, admin_prepare_customer_invitation
--    kept rejecting it ('email already registered') and no application-level
--    recovery existed. admin_mark_customer_invitation_failed is REPLACED
--    (return contract minimally extended) so that, while marking the prepared
--    invitation failed, it positively identifies the Auth account created by
--    THIS invitation attempt — exact normalized email, created no earlier than
--    the invitation, no profile, no membership, not bound to any other
--    invitation — binds its historical UUID on the invitation row and returns
--    it (cleanup_auth_user_id) so the trusted server coordinator can delete
--    exactly that account through the Auth Admin boundary. Fails closed: any
--    pre-existing, accepted, profiled or unrelated account yields NULL and is
--    never touched.
--
-- 2. Archived businesses were promised non-operable but
--    admin_set_business_member_role / admin_set_business_member_status locked
--    the business row without inspecting its status, so a direct authenticated
--    administrator RPC call could still mutate memberships of an archived
--    business. Both functions are REPLACED (signatures, return types, locking,
--    validation, platform-admin target denial, last-owner protection, no-op and
--    audit behavior all preserved) with an explicit archived rejection (55000)
--    taken under the business row lock, before any membership decision.
--
-- No existing migration is modified; no other function, table, policy or grant
-- changes; the public RPC inventory keeps the same fourteen names.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- admin_mark_customer_invitation_failed: return contract gains the cleanup
-- candidate (DROP required — CREATE OR REPLACE cannot change a return type).
-- ---------------------------------------------------------------------------
drop function public.admin_mark_customer_invitation_failed(uuid);

create function public.admin_mark_customer_invitation_failed(p_invitation_id uuid)
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
  select * into v_actor from private.platform_admin_actor();

  select i.* into v_inv from public.customer_invitations i where i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  if v_inv.status <> 'prepared' then
    raise exception 'invitation is not awaiting delivery' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The Auth account created by THIS invitation attempt, if the pinned Auth
  -- stack left one behind after the delivery failure. Exact and fail-closed:
  --   * exact normalized email match;
  --   * created no earlier than this invitation (prepare already proved the
  --     email was unregistered at preparation time; a small grace bounds skew);
  --   * no application profile and no membership (never an accepted customer
  --     or a platform administrator);
  --   * not bound to any other invitation.
  -- Anything else yields NULL and is never deleted.
  select u.id into v_candidate
  from auth.users u
  where lower(u.email) = v_inv.email
    and u.created_at >= v_inv.created_at - interval '5 seconds'
    and not exists (select 1 from public.profiles p where p.id = u.id)
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
  'Platform administrators only. prepared -> failed when Auth delivery/account creation fails; binds and returns the Auth account created by this exact attempt (or NULL) so the trusted server coordinator can remove it. A failed invitation can never grant membership.';

revoke all on function public.admin_mark_customer_invitation_failed(uuid) from public, anon;
grant execute on function public.admin_mark_customer_invitation_failed(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_set_business_member_role: archived businesses are non-operable
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
  select * into v_actor from private.platform_admin_actor();

  if p_role is null or p_role not in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF') then
    raise exception 'unsupported customer role' using errcode = 'invalid_parameter_value';
  end if;

  -- serialize owner-count decisions per business; the status decision happens under this lock
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
  'Platform administrators only. Changes a customer membership role within its ACTIVE or SUSPENDED business (archived is non-operable, 55000). The last effective active owner can never be demoted; no-ops audit nothing.';

-- ---------------------------------------------------------------------------
-- admin_set_business_member_status: archived businesses are non-operable
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
  select * into v_actor from private.platform_admin_actor();

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
  'Platform administrators only. active <-> inactive for a customer membership of an ACTIVE or SUSPENDED business (archived is non-operable, 55000); deactivation revokes tenant access on the next request. The last effective active owner can never be deactivated; no-ops audit nothing.';

-- restate the execute posture explicitly for the replaced member functions
revoke all on function public.admin_set_business_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.admin_set_business_member_status(uuid, uuid, text) from public, anon;
grant execute on function public.admin_set_business_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.admin_set_business_member_status(uuid, uuid, text) to authenticated;
