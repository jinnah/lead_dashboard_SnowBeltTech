-- =============================================================================
-- Batch 1 / Migration 2: tenant security
-- Security-definer RLS helpers (private schema), defensive immutability
-- triggers, and Row Level Security policies on the five tenancy tables.
-- Grants (migration 1) and RLS (here) are two independent layers.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- RLS helper functions. SECURITY DEFINER, owned by postgres (bypassrls), empty
-- search_path, fully-qualified names, user always derived from auth.uid().
-- Owned-by-bypassrls is what prevents policy recursion (memberships policies
-- call active_business_ids(), which reads memberships).
-- ---------------------------------------------------------------------------
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
  where m.user_id = auth.uid()
    and m.status = 'active'
    and p.is_active;
$$;
comment on function private.active_business_ids() is
  'Businesses the current auth.uid() actively belongs to. Inactive membership or inactive profile yields nothing.';
revoke all on function private.active_business_ids() from public;
grant execute on function private.active_business_ids() to authenticated;

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'PLATFORM_ADMIN'
      and p.is_active
  );
$$;
comment on function private.is_platform_admin() is
  'True only for an ACTIVE profile whose system-managed platform_role is PLATFORM_ADMIN.';
revoke all on function private.is_platform_admin() from public;
grant execute on function private.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Defensive immutability triggers (defense-in-depth behind column grants).
-- ---------------------------------------------------------------------------

-- Universal invariants, every role: id, business_id (tenant key) and created_at
-- never change after insert.
create or replace function private.protect_row_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
begin
  if n ->> 'id' is distinct from o ->> 'id' then
    raise exception '%.id is immutable', tg_table_name using errcode = 'check_violation';
  end if;
  if (o ? 'business_id') and (n ->> 'business_id' is distinct from o ->> 'business_id') then
    raise exception '%.business_id is the tenant key and is immutable', tg_table_name using errcode = 'check_violation';
  end if;
  if n ->> 'created_at' is distinct from o ->> 'created_at' then
    raise exception '%.created_at is immutable', tg_table_name using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_row_identity() from public;

-- Ordinary (anon/authenticated) roles may change only an allow-listed set of
-- columns; everything else is system-managed. Privileged roles (service_role,
-- postgres) are not restricted here so migrations, seeds and future reviewed
-- server-side writers keep working.
create or replace function private.protect_system_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed text[] := tg_argv;      -- column names ordinary roles may change
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  changed text[];
  blocked text[];
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  select coalesce(array_agg(key order by key), '{}')
    into changed
  from jsonb_object_keys(n) as k(key)
  where n -> key is distinct from o -> key;
  select coalesce(array_agg(c order by c), '{}')
    into blocked
  from unnest(changed) as c
  where c <> 'updated_at' and not (c = any (allowed));
  if array_length(blocked, 1) > 0 then
    raise exception '%: system-managed column(s) % cannot be changed by business users',
      tg_table_name, array_to_string(blocked, ', ')
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_system_fields() from public;

-- Trigger names are prefixed so they fire AFTER trg_*_updated_at (alphabetical
-- firing order); updated_at is always tolerated by protect_system_fields.
create trigger trg_z_businesses_protect_identity
  before update on public.businesses
  for each row execute function private.protect_row_identity();

create trigger trg_z_profiles_protect_identity
  before update on public.profiles
  for each row execute function private.protect_row_identity();
create trigger trg_z_profiles_protect_system_fields
  before update on public.profiles
  for each row execute function private.protect_system_fields('display_name');

create trigger trg_z_business_memberships_protect_identity
  before update on public.business_memberships
  for each row execute function private.protect_row_identity();

create trigger trg_z_integration_sources_protect_identity
  before update on public.integration_sources
  for each row execute function private.protect_row_identity();

create trigger trg_z_leads_protect_identity
  before update on public.leads
  for each row execute function private.protect_row_identity();
create trigger trg_z_leads_protect_system_fields
  before update on public.leads
  for each row execute function private.protect_system_fields('status', 'follow_up_at');

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled AND forced on every tenancy table.
-- No INSERT policy and no DELETE policy exists for any role in Batch 1.
-- ---------------------------------------------------------------------------
alter table public.businesses            enable row level security;
alter table public.businesses            force  row level security;
alter table public.profiles              enable row level security;
alter table public.profiles              force  row level security;
alter table public.business_memberships  enable row level security;
alter table public.business_memberships  force  row level security;
alter table public.integration_sources   enable row level security;
alter table public.integration_sources   force  row level security;
alter table public.leads                 enable row level security;
alter table public.leads                 force  row level security;

-- businesses: members read their own business; platform admins read all
create policy businesses_select_member_or_admin
  on public.businesses
  for select
  to authenticated
  using (
    id in (select private.active_business_ids())
    or (select private.is_platform_admin())
  );

-- profiles: self, members of a business you actively belong to, or platform admin
create policy profiles_select_self_cobusiness_or_admin
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or (select private.is_platform_admin())
    or exists (
      select 1
      from public.business_memberships m
      where m.user_id = public.profiles.id
        and m.business_id in (select private.active_business_ids())
    )
  );

-- profiles: a user may update only their own row (column grant limits it to display_name)
create policy profiles_update_self
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- memberships: visible within your own active businesses, or to platform admins
create policy business_memberships_select_same_business_or_admin
  on public.business_memberships
  for select
  to authenticated
  using (
    business_id in (select private.active_business_ids())
    or (select private.is_platform_admin())
  );

-- integration sources: platform administrators only (Batch 1)
create policy integration_sources_select_platform_admin
  on public.integration_sources
  for select
  to authenticated
  using ((select private.is_platform_admin()));

-- leads: every active member sees every lead of their business; admins see all
create policy leads_select_member_or_admin
  on public.leads
  for select
  to authenticated
  using (
    business_id in (select private.active_business_ids())
    or (select private.is_platform_admin())
  );

-- leads: members update their own business's leads; the row must stay in that business
create policy leads_update_member
  on public.leads
  for update
  to authenticated
  using (business_id in (select private.active_business_ids()))
  with check (business_id in (select private.active_business_ids()));
