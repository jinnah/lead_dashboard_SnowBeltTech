-- =============================================================================
-- Corrective hardening (append-only): platform administrators are read-only
-- for lead assignment even when they ALSO hold an active owner/manager
-- membership in the lead's business.
--
-- Before this migration public.set_lead_assignee authorized the caller purely
-- from business_memberships (active owner/manager + active profile + active
-- business). The schema permits a profile with platform_role = 'PLATFORM_ADMIN'
-- to hold such a membership; the application classifies that user as an
-- administrator and blocks the customer route, but the SECURITY DEFINER RPC is
-- exposed to every authenticated session and could be called directly.
--
-- Change: the caller's profile must not carry a platform role
-- (profiles.platform_role is null — the only other value the constraint
-- ck_profiles_platform_role allows is 'PLATFORM_ADMIN'). Rejection stays opaque
-- (P0002) so an administrator learns nothing a non-member would not.
-- Everything else — signature, return shape, SECURITY DEFINER, owner, empty
-- search_path, lead locking before authorization, assignee eligibility, no-op
-- handling, trigger auditing, grants — is preserved verbatim. No existing
-- migration is modified; no RLS policy changes; no history rewritten.
-- =============================================================================

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

  -- Caller: active owner/manager membership + active profile + active business,
  -- for THIS lead's business — and NO platform role (administrators are read-only
  -- regardless of any membership they also hold).
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
      and p.platform_role is null
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
  'Assign (or unassign with NULL) a lead of the caller''s active business. Caller must be an active owner/manager without a platform role (platform administrators are read-only); assignee must be an active member. Audited as assignment_changed.';

-- Reassert the execute posture explicitly (CREATE OR REPLACE keeps existing ACLs; this makes the intent reviewable).
revoke all on function public.set_lead_assignee(uuid, uuid) from public;
revoke all on function public.set_lead_assignee(uuid, uuid) from anon;
grant execute on function public.set_lead_assignee(uuid, uuid) to authenticated;
