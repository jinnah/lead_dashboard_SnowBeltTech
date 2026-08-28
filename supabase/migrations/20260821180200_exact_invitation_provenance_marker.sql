-- =============================================================================
-- Batch 4B corrective hardening, pass 2 (append-only migration).
--
-- The failed-delivery Auth cleanup candidate was selected by inference (email +
-- creation-time window + no profile/membership/other binding). That is not an
-- exact provenance predicate: a clean account created inside the window with
-- the same normalized email could match and be deleted.
--
-- Correction: every invitation now carries an application-owned correlation
-- marker — the invitation's own UUID, passed by the server coordinator into
-- inviteUserByEmail under the narrowly named user-metadata key
-- 'portal_invitation_id' and persisted by GoTrue on the Auth account created
-- by that exact invite attempt. admin_mark_customer_invitation_failed is
-- replaced (signature and return contract unchanged) so a cleanup candidate
-- REQUIRES exact equality with that marker. The previous conditions (email,
-- temporal bound, no profile, no membership, no other-invitation binding)
-- remain as purely defensive additional conditions — none substitutes for the
-- marker. The marker is provenance-for-deletion only: it is never read for
-- authorization anywhere (platform roles still come exclusively from
-- system-managed profiles.platform_role).
--
-- No table, policy, grant or inventory changes; no existing migration changes.
-- =============================================================================

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
  select * into v_actor from private.platform_admin_actor();

  select i.* into v_inv from public.customer_invitations i where i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  if v_inv.status <> 'prepared' then
    raise exception 'invitation is not awaiting delivery' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The Auth account created by THIS invitation attempt, if one was left
  -- behind. Provenance is EXACT: the account must carry this invitation's own
  -- UUID under the application-owned marker key, which only the server
  -- coordinator supplies at invite time. Everything after the marker check is
  -- defense in depth — never a substitute for it.
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
  'Platform administrators only. prepared -> failed when Auth delivery/account creation fails; returns the Auth account created by this exact attempt — identified by the invitation''s own UUID persisted as the portal_invitation_id user-metadata marker at invite time (email/time/profile checks are defensive only) — so the trusted server coordinator can remove it. A failed invitation can never grant membership.';

-- restate the execute posture explicitly
revoke all on function public.admin_mark_customer_invitation_failed(uuid) from public, anon;
grant execute on function public.admin_mark_customer_invitation_failed(uuid) to authenticated;
