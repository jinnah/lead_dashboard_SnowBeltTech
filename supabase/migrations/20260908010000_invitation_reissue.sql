-- Reissue claims a SENT invitation once, by revoking it under the same row
-- lock acceptance uses. No token is revived. The server cleans the positively
-- verified old Auth identity, then uses the EXISTING prepare/deliver/finalize
-- coordinator. A crash leaves the old invitation revoked, never usable.
-- Five minutes since sent_at is the database cooldown (including expired
-- invitations). Prepared/failed/revoked/accepted records are ineligible.
-- No table write grants or RLS policies change; one justified public RPC.

alter table public.customer_access_events drop constraint ck_customer_access_events_type;
alter table public.customer_access_events add constraint ck_customer_access_events_type check (event_type in (
  'invitation_prepared', 'invitation_sent', 'invitation_failed', 'invitation_revoked', 'invitation_accepted',
  'invitation_reissue_requested', 'membership_role_changed', 'membership_status_changed'));
alter table public.customer_access_events drop constraint ck_customer_access_events_shape;
alter table public.customer_access_events add constraint ck_customer_access_events_shape check (
  (event_type in ('invitation_prepared', 'invitation_failed', 'invitation_revoked', 'invitation_reissue_requested')
    and invitation_id is not null and target_user_id is null and old_value is null and new_value is null)
  or (event_type in ('invitation_sent', 'invitation_accepted')
    and invitation_id is not null and target_user_id is not null and old_value is null and new_value is null)
  or (event_type = 'membership_role_changed' and invitation_id is null and target_user_id is not null
    and old_value in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF')
    and new_value in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF') and old_value <> new_value)
  or (event_type = 'membership_status_changed' and invitation_id is null and target_user_id is not null
    and old_value in ('active', 'inactive') and new_value in ('active', 'inactive') and old_value <> new_value));

create function public.admin_begin_customer_invitation_reissue(p_business_id uuid, p_invitation_id uuid)
returns table (email text, display_name text, role text, cleanup_auth_user_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv public.customer_invitations%rowtype;
  v_actor record;
  v_cleanup uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  -- Same lock as accept_customer_invitation: acceptance wins OR revocation
  -- wins. State is checked after waiting, so only one reissue may claim it.
  select i.* into v_inv from public.customer_invitations i
    where i.id = p_invitation_id and i.business_id = p_business_id for update;
  if not found then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;
  select * into v_actor from private.team_management_actor(v_inv.business_id);
  if v_actor.actor_id is null or (not v_actor.is_admin and v_inv.role = 'BUSINESS_OWNER') then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;
  -- Match acceptance's invitation -> business lock order. Hold the active
  -- business stable through revocation; prepare independently rechecks later.
  perform 1 from public.businesses b where b.id = v_inv.business_id and b.status = 'active' for share;
  if not found then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;
  if v_inv.status <> 'sent' then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;
  if v_inv.sent_at > clock_timestamp() - interval '5 minutes' then
    raise exception 'invitation not available' using errcode = 'no_data_found';
  end if;
  -- Exact provenance, never inferred from email. A missing account needs no
  -- deletion; any existing mismatched/profiled/otherwise-bound account fails
  -- closed without changing the invitation or attempting Auth deletion.
  if exists (select 1 from auth.users u where u.id = v_inv.auth_user_id) then
    select u.id into v_cleanup from auth.users u
      where u.id = v_inv.auth_user_id
        and lower(u.email) = v_inv.email
        and u.raw_user_meta_data ->> 'portal_invitation_id' = v_inv.id::text
        and u.created_at >= v_inv.created_at - interval '5 seconds'
        and not exists (select 1 from public.profiles p where p.id = u.id)
        and not exists (select 1 from public.business_memberships m where m.user_id = u.id)
        and not exists (select 1 from public.customer_invitations i where i.auth_user_id = u.id and i.id <> v_inv.id);
    if v_cleanup is null then
      raise exception 'invitation not available' using errcode = 'no_data_found';
    end if;
  end if;
  -- Reuse the reviewed revocation and its immutable audit entry.
  perform * from public.admin_revoke_customer_invitation(v_inv.business_id, v_inv.id);
  insert into public.customer_access_events (business_id, invitation_id, actor_id, actor_display_name, event_type)
    values (v_inv.business_id, v_inv.id, v_actor.actor_id, v_actor.actor_display_name, 'invitation_reissue_requested');
  return query select v_inv.email, v_inv.display_name, v_inv.role, v_cleanup;
end;
$$;
comment on function public.admin_begin_customer_invitation_reissue(uuid, uuid) is
  'Active administrator or active business owner (Manager/Staff targets only). Claims a sent invitation once after a five-minute cooldown, revokes under the acceptance lock, audits the replacement request and returns authorized details plus exact-provenance cleanup identity to the existing server-only coordinator. Failures never revive links.';
revoke all on function public.admin_begin_customer_invitation_reissue(uuid, uuid) from public, anon, service_role;
grant execute on function public.admin_begin_customer_invitation_reissue(uuid, uuid) to authenticated;
