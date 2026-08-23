-- =============================================================================
-- Batch 4A: audited platform-administrator operations (append-only migration).
--   * public.platform_admin_events — immutable ledger of platform operations
--     (business created / status changed, integration source created / status
--     changed). Readable only by active platform administrators; never written
--     directly by application users; UPDATE refused for every role; DELETE only
--     by privileged roles (same posture as lead_activities).
--   * private.platform_admin_actor() — the single database-side authorization
--     gate for administrator RPCs: caller = auth.uid(), must be an ACTIVE
--     profile with platform_role = 'PLATFORM_ADMIN'; fails closed.
--   * Four narrowly scoped SECURITY DEFINER RPCs (authenticated-only execute,
--     postgres owner, empty search_path, fully qualified names):
--       admin_create_business(name, slug, industry, timezone)
--       admin_set_business_status(business_id, status)        active <-> suspended
--       admin_create_integration_source(business_id, kind, external_id, label, origin)
--       admin_set_integration_source_status(business_id, source_id, status)  active <-> inactive
--     Each writes its audit row in the same transaction; no-op transitions write
--     nothing; rows are locked FOR UPDATE before any status decision.
-- Customers keep NO direct INSERT/UPDATE/DELETE on businesses, integration_sources
-- or the ledger. Existing RLS policies, lead RLS, assignment rules and the
-- ingestion RPC are untouched. No existing migration is modified.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- platform_admin_events: immutable platform-operations ledger
-- ---------------------------------------------------------------------------
create table public.platform_admin_events (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete restrict,
  integration_source_id  uuid references public.integration_sources (id) on delete restrict,
  event_type             text not null,
  -- historical actor: auth.uid() at the time. Deliberately NOT a foreign key so
  -- removing an administrator account never rewrites or blocks history.
  actor_id               uuid not null,
  actor_display_name     text,
  old_value              text,
  new_value              text,
  created_at             timestamptz not null default now(),
  constraint ck_platform_admin_events_type check (event_type in (
    'business_created', 'business_status_changed', 'integration_source_created', 'integration_source_status_changed')),
  constraint ck_platform_admin_events_actor_name_length check (actor_display_name is null or length(actor_display_name) <= 100),
  constraint ck_platform_admin_events_values_length check (
    (old_value is null or length(old_value) <= 64) and (new_value is null or length(new_value) <= 64)),
  -- shape per type: creation rows carry the initial status; change rows carry a genuine old->new status pair
  constraint ck_platform_admin_events_shape check (
    (event_type = 'business_created'
       and integration_source_id is null and old_value is null and new_value = 'active')
    or
    (event_type = 'business_status_changed'
       and integration_source_id is null
       and old_value in ('active', 'suspended') and new_value in ('active', 'suspended') and old_value <> new_value)
    or
    (event_type = 'integration_source_created'
       and integration_source_id is not null and old_value is null and new_value = 'active')
    or
    (event_type = 'integration_source_status_changed'
       and integration_source_id is not null
       and old_value in ('active', 'inactive') and new_value in ('active', 'inactive') and old_value <> new_value))
);
comment on table public.platform_admin_events is
  'Append-only ledger of platform-administrator operations on businesses and integration sources. Status values only; never identifiers, contact data or secrets. Never updated.';
comment on column public.platform_admin_events.actor_id is
  'Historical administrator identifier (auth.uid() at the time). Not a foreign key: history survives account removal.';

create index ix_platform_admin_events_business_created on public.platform_admin_events (business_id, created_at desc);
create index ix_platform_admin_events_source on public.platform_admin_events (integration_source_id) where integration_source_id is not null;

-- Immutable: every UPDATE refused for every role; DELETE only by privileged roles
-- (migrations/resets/test cleanup) — identical to lead_activities.
create or replace function private.platform_admin_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'platform_admin_events is append-only' using errcode = 'check_violation';
  end if;
  if current_user in ('anon', 'authenticated') then
    raise exception 'platform_admin_events rows cannot be deleted by application users' using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;
revoke all on function private.platform_admin_events_append_only() from public;

create trigger trg_platform_admin_events_append_only
  before update or delete on public.platform_admin_events
  for each row execute function private.platform_admin_events_append_only();

revoke all on table public.platform_admin_events from public, anon, authenticated;
grant all on table public.platform_admin_events to service_role;
grant select on table public.platform_admin_events to authenticated;   -- rows limited to platform admins by RLS

alter table public.platform_admin_events enable row level security;
alter table public.platform_admin_events force  row level security;

create policy platform_admin_events_select_platform_admin
  on public.platform_admin_events
  for select
  to authenticated
  using ((select private.is_platform_admin()));
-- no INSERT / UPDATE / DELETE policy for any role

-- ---------------------------------------------------------------------------
-- private.platform_admin_actor(): the authorization gate for administrator RPCs
-- ---------------------------------------------------------------------------
create or replace function private.platform_admin_actor(out actor_id uuid, out actor_display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  actor_id := auth.uid();
  if actor_id is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select p.display_name into actor_display_name
  from public.profiles p
  where p.id = actor_id
    and p.platform_role = 'PLATFORM_ADMIN'
    and p.is_active;
  if not found then
    raise exception 'platform administrator required' using errcode = 'insufficient_privilege';
  end if;
end;
$$;
comment on function private.platform_admin_actor() is
  'Returns the calling ACTIVE platform administrator (auth.uid()) and a display-name snapshot, or raises 42501. Fails closed for anonymous, customers and deactivated administrators.';
revoke all on function private.platform_admin_actor() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_create_business
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_business(p_name text, p_slug text, p_industry text, p_timezone text)
returns table (business_id uuid, slug text, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_name  text := btrim(coalesce(p_name, ''));
  v_id    uuid;
begin
  select * into v_actor from private.platform_admin_actor();

  if length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'name must be 1-200 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' then
    raise exception 'slug must be a lowercase DNS-label style identifier' using errcode = 'invalid_parameter_value';
  end if;
  if p_industry is null or p_industry not in (
    'hvac', 'plumbing', 'roofing', 'landscaping', 'cleaning', 'auto_repair',
    'property_maintenance', 'electrical', 'technology_services', 'other') then
    raise exception 'unsupported industry' using errcode = 'invalid_parameter_value';
  end if;
  -- a real zone known to this server, in canonical Area/Location form (or UTC) — not merely a pattern match
  if p_timezone is null
     or not (p_timezone = 'UTC' or p_timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$')
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    raise exception 'unsupported timezone' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.businesses b where b.slug = p_slug) then
    raise exception 'slug already exists' using errcode = 'unique_violation';
  end if;

  insert into public.businesses (name, slug, industry, timezone, status)
  values (v_name, p_slug, p_industry, p_timezone, 'active')
  returning id into v_id;

  insert into public.platform_admin_events (business_id, event_type, actor_id, actor_display_name, old_value, new_value)
  values (v_id, 'business_created', v_actor.actor_id, v_actor.actor_display_name, null, 'active');

  return query select v_id, p_slug, 'active'::text;
end;
$$;
comment on function public.admin_create_business(text, text, text, text) is
  'Platform administrators only. Creates an active business (validated name/slug/industry/real timezone, unique slug) and records business_created in the same transaction.';

-- ---------------------------------------------------------------------------
-- admin_set_business_status: active <-> suspended only
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_business_status(p_business_id uuid, p_status text)
returns table (business_id uuid, status text, changed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_biz   public.businesses%rowtype;
begin
  select * into v_actor from private.platform_admin_actor();

  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'status must be active or suspended' using errcode = 'invalid_parameter_value';
  end if;

  -- Lock the business row: serializes concurrent status changes (and no-ops) and
  -- conflicts with the FOR SHARE taken by ingest_lead_event.
  select b.* into v_biz from public.businesses b where b.id = p_business_id for update;
  if not found then
    raise exception 'business not found' using errcode = 'no_data_found';
  end if;
  if v_biz.status = 'archived' then
    raise exception 'archived businesses cannot be changed' using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_biz.status = p_status then
    return query select v_biz.id, v_biz.status, false;   -- no-op: no update, no audit row
    return;
  end if;

  update public.businesses b set status = p_status where b.id = v_biz.id;
  insert into public.platform_admin_events (business_id, event_type, actor_id, actor_display_name, old_value, new_value)
  values (v_biz.id, 'business_status_changed', v_actor.actor_id, v_actor.actor_display_name, v_biz.status, p_status);

  return query select v_biz.id, p_status, true;
end;
$$;
comment on function public.admin_set_business_status(uuid, text) is
  'Platform administrators only. active -> suspended or suspended -> active (archived is not operable). Repeating the current status is a no-op without an audit row.';

-- ---------------------------------------------------------------------------
-- admin_create_integration_source
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_integration_source(
  p_business_id uuid, p_kind text, p_external_id text, p_label text, p_allowed_origin text)
returns table (source_id uuid, business_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  record;
  v_biz    public.businesses%rowtype;
  v_label  text := nullif(btrim(coalesce(p_label, '')), '');
  v_origin text := nullif(p_allowed_origin, '');
  v_id     uuid;
begin
  select * into v_actor from private.platform_admin_actor();

  -- only kinds the ingestion endpoint actually accepts (twilio_number is not ingestible yet)
  if p_kind is null or p_kind not in ('website_form', 'vapi_assistant', 'vapi_phone_number') then
    raise exception 'unsupported integration source kind' using errcode = 'invalid_parameter_value';
  end if;
  -- identifiers are preserved byte-for-byte: no surrounding whitespace, no control characters
  if p_external_id is null
     or length(p_external_id) < 1 or length(p_external_id) > 255
     or p_external_id <> btrim(p_external_id, E' \t\r\n')
     or p_external_id ~ '[[:cntrl:]]' then
    raise exception 'external identifier must be 1-255 characters without surrounding whitespace' using errcode = 'invalid_parameter_value';
  end if;
  if v_label is not null and length(v_label) > 100 then
    raise exception 'label must be at most 100 characters' using errcode = 'invalid_parameter_value';
  end if;
  if v_origin is not null then
    if p_kind <> 'website_form' then
      raise exception 'voice sources do not accept a website origin' using errcode = 'invalid_parameter_value';
    end if;
    -- canonical HTTPS origin: lowercase host, optional non-default port, no path/query/fragment/credentials/trailing slash
    if v_origin !~ '^https://[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*(:[1-9][0-9]{0,4})?$'
       or length(v_origin) > 253 + 8 + 6
       or (v_origin ~ ':[0-9]+$' and (substring(v_origin from ':([0-9]+)$')::int > 65535 or substring(v_origin from ':([0-9]+)$') = '443')) then
      raise exception 'allowed origin must be a canonical https origin' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- the target business must exist and be active (shared lock: a concurrent suspension waits)
  select b.* into v_biz from public.businesses b where b.id = p_business_id for share;
  if not found then
    raise exception 'business not found' using errcode = 'no_data_found';
  end if;
  if v_biz.status <> 'active' then
    raise exception 'business is not active' using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- (kind, external_id) is globally unique: an identifier already routed to ANY business is never re-claimed
  if exists (select 1 from public.integration_sources s where s.kind = p_kind and s.external_id = p_external_id) then
    raise exception 'integration source identifier already registered' using errcode = 'unique_violation';
  end if;

  insert into public.integration_sources (business_id, kind, external_id, label, allowed_origin, status)
  values (v_biz.id, p_kind, p_external_id, v_label, v_origin, 'active')
  returning id into v_id;

  insert into public.platform_admin_events (business_id, integration_source_id, event_type, actor_id, actor_display_name, old_value, new_value)
  values (v_biz.id, v_id, 'integration_source_created', v_actor.actor_id, v_actor.actor_display_name, null, 'active');

  return query select v_id, v_biz.id, 'active'::text;
end;
$$;
comment on function public.admin_create_integration_source(uuid, text, text, text, text) is
  'Platform administrators only. Registers an active website_form / vapi_assistant / vapi_phone_number source for an active business; (kind, external_id) stays globally unique; records integration_source_created.';

-- ---------------------------------------------------------------------------
-- admin_set_integration_source_status: active <-> inactive for ONE business/source pair
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_integration_source_status(p_business_id uuid, p_source_id uuid, p_status text)
returns table (source_id uuid, status text, changed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_src   public.integration_sources%rowtype;
begin
  select * into v_actor from private.platform_admin_actor();

  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception 'status must be active or inactive' using errcode = 'invalid_parameter_value';
  end if;

  -- The source must belong to the supplied business (tenant is never reassigned). Locked FOR UPDATE:
  -- serializes concurrent changes and conflicts with ingest_lead_event's FOR SHARE.
  select s.* into v_src
  from public.integration_sources s
  where s.id = p_source_id and s.business_id = p_business_id
  for update;
  if not found then
    raise exception 'integration source not found' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.businesses b where b.id = v_src.business_id and b.status = 'archived') then
    raise exception 'archived businesses cannot be changed' using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_src.status = p_status then
    return query select v_src.id, v_src.status, false;   -- no-op: no update, no audit row
    return;
  end if;

  update public.integration_sources s set status = p_status where s.id = v_src.id;
  insert into public.platform_admin_events (business_id, integration_source_id, event_type, actor_id, actor_display_name, old_value, new_value)
  values (v_src.business_id, v_src.id, 'integration_source_status_changed', v_actor.actor_id, v_actor.actor_display_name, v_src.status, p_status);

  return query select v_src.id, p_status, true;
end;
$$;
comment on function public.admin_set_integration_source_status(uuid, uuid, text) is
  'Platform administrators only. active <-> inactive for a source of the given business; mismatched pairs are rejected; repeating the current status is a no-op without an audit row.';

-- ---------------------------------------------------------------------------
-- Execute posture: authenticated only (authorization happens inside each RPC).
-- ---------------------------------------------------------------------------
revoke all on function public.admin_create_business(text, text, text, text) from public, anon;
revoke all on function public.admin_set_business_status(uuid, text) from public, anon;
revoke all on function public.admin_create_integration_source(uuid, text, text, text, text) from public, anon;
revoke all on function public.admin_set_integration_source_status(uuid, uuid, text) from public, anon;
grant execute on function public.admin_create_business(text, text, text, text) to authenticated;
grant execute on function public.admin_set_business_status(uuid, text) to authenticated;
grant execute on function public.admin_create_integration_source(uuid, text, text, text, text) to authenticated;
grant execute on function public.admin_set_integration_source_status(uuid, uuid, text) to authenticated;
