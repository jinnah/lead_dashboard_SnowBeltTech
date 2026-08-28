-- =============================================================================
-- Batch 4A corrective hardening (append-only): platform administrators are
-- read-only on customer leads even when they ALSO hold active business
-- memberships.
--
-- Defect: private.active_business_ids() — the shared authorization helper used
-- by the customer RLS policies (leads UPDATE, note/assignment RPCs re-derive
-- from memberships separately) — still returned business ids for a profile
-- with platform_role = 'PLATFORM_ADMIN' that also held an active membership.
-- The application routes hide these actions from administrators, but a direct
-- authenticated Supabase request could UPDATE leads.status / follow_up_at and
-- call add_lead_note under the leads_update_member / membership-derived paths.
-- (set_lead_assignee was already hardened in 20260821160100.)
--
-- Correction: the helper now excludes callers whose profile carries a platform
-- role (ck_profiles_platform_role allows only NULL or 'PLATFORM_ADMIN', so
-- `p.platform_role is null` is exactly "not a platform administrator").
-- Administrators keep their global READ access through private.is_platform_admin()
-- and their platform operations through private.platform_admin_actor(); customer
-- membership-derived authorization no longer applies to them anywhere this
-- helper is consulted. Everything else about the helper — name, zero-argument
-- signature, SETOF uuid, SQL, STABLE, SECURITY DEFINER, postgres owner, empty
-- fixed search_path, fully qualified references, authenticated-only EXECUTE —
-- is preserved verbatim. No RLS policy text changes; no grant changes; no
-- public RPC changes; no existing migration is modified.
-- =============================================================================

create or replace function private.active_business_ids()
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
    and m.status = 'active'
    and p.is_active
    and p.platform_role is null
    and b.status = 'active';
$$;
comment on function private.active_business_ids() is
  'Businesses the current auth.uid() actively belongs to AS A CUSTOMER: active membership, active profile, business status = active, and NO platform role. Platform administrators are intentionally excluded even when they hold active business memberships — their access is read-only via is_platform_admin() and platform operations via platform_admin_actor(); they never gain customer mutation rights. Suspended/archived businesses yield nothing.';

-- restate the execute model explicitly (create or replace preserves it; this keeps intent visible)
revoke all on function private.active_business_ids() from public;
revoke all on function private.active_business_ids() from anon;
grant execute on function private.active_business_ids() to authenticated;
