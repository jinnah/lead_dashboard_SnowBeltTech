-- =============================================================================
-- Batch 1A: tenant access requires an ACTIVE business.
-- Append-only correction to private.active_business_ids(): a membership now
-- confers tenant access only while the business itself has status = 'active'.
-- Members of a suspended or archived business lose all tenant-scoped access;
-- platform administrators keep access through private.is_platform_admin().
-- Signature, volatility, SECURITY DEFINER, empty search_path, ownership and
-- execute grants are unchanged from Batch 1.
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
    and b.status = 'active';
$$;
comment on function private.active_business_ids() is
  'Businesses the current auth.uid() actively belongs to: active membership, active profile AND business status = active. Suspended/archived businesses yield nothing.';

-- restate the execute model explicitly (create or replace preserves it; this keeps intent visible)
revoke all on function private.active_business_ids() from public;
grant execute on function private.active_business_ids() to authenticated;
