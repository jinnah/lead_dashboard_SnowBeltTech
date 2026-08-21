-- =============================================================================
-- Batch 1 / Migration 1: tenancy schema
-- Tables, constraints, indexes, grants and ordinary (non-security) triggers.
-- Tenant ownership key everywhere: business_id.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Non-exposed helper schema (not in PostgREST's exposed schema list).
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon;
grant usage on schema private to authenticated;   -- needed to evaluate RLS helpers
grant usage on schema private to service_role;

-- Shared updated_at maintenance trigger (ordinary, not security definer).
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.set_updated_at() from public;

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
create table public.businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null,
  industry    text not null,
  timezone    text not null default 'America/New_York',
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ck_businesses_name_length check (length(btrim(name)) between 1 and 200),
  -- lowercase DNS-label style slug: no uppercase, no leading/trailing hyphen
  constraint ck_businesses_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  constraint ck_businesses_industry check (industry in (
    'hvac', 'plumbing', 'roofing', 'landscaping', 'cleaning', 'auto_repair',
    'property_maintenance', 'electrical', 'technology_services', 'other')),
  constraint ck_businesses_timezone_format check (timezone = 'UTC' or timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$'),
  constraint ck_businesses_status check (status in ('active', 'suspended', 'archived')),
  constraint uq_businesses_slug unique (slug)
);
comment on table public.businesses is 'Tenant. Every tenant-owned row carries business_id referencing this table.';

create trigger trg_businesses_updated_at
  before update on public.businesses
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users; platform_role is system-managed)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  display_name   text not null default '',
  platform_role  text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ck_profiles_display_name_length check (length(display_name) <= 100),
  constraint ck_profiles_platform_role check (platform_role is null or platform_role = 'PLATFORM_ADMIN')
);
comment on column public.profiles.platform_role is
  'PLATFORM_ADMIN or NULL. System-managed: never derived from user-editable auth metadata; never writable by ordinary users.';

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- business_memberships
-- ---------------------------------------------------------------------------
create table public.business_memberships (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete restrict,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         text not null,
  status       text not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint ck_business_memberships_role check (role in ('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'BUSINESS_STAFF')),
  constraint ck_business_memberships_status check (status in ('active', 'inactive')),
  constraint uq_business_memberships_business_user unique (business_id, user_id)
);
comment on table public.business_memberships is 'User-to-business relationship. Only status = active grants tenant access.';

create index ix_business_memberships_user_active
  on public.business_memberships (user_id, business_id) where status = 'active';

create trigger trg_business_memberships_updated_at
  before update on public.business_memberships
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- integration_sources (trusted routing: external identifier -> business)
-- ---------------------------------------------------------------------------
create table public.integration_sources (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete restrict,
  kind            text not null,
  external_id     text not null,
  label           text,
  allowed_origin  text,
  status          text not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ck_integration_sources_kind check (kind in ('website_form', 'vapi_assistant', 'vapi_phone_number', 'twilio_number')),
  constraint ck_integration_sources_external_id_length check (length(external_id) between 1 and 255),
  constraint ck_integration_sources_label_length check (label is null or length(label) <= 100),
  constraint ck_integration_sources_allowed_origin_format check (allowed_origin is null or allowed_origin ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'),
  constraint ck_integration_sources_status check (status in ('active', 'inactive')),
  -- one external identifier resolves to exactly one business for a given kind
  constraint uq_integration_sources_kind_external_id unique (kind, external_id)
);
comment on table public.integration_sources is
  'Trusted mapping from a provider/source identifier to a business. Never stores secrets or provider API keys.';

create index ix_integration_sources_business on public.integration_sources (business_id);

create trigger trg_integration_sources_updated_at
  before update on public.integration_sources
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
create table public.leads (
  id                        uuid primary key default gen_random_uuid(),
  business_id               uuid not null references public.businesses (id) on delete restrict,
  lead_number               text not null,
  source                    text not null,
  source_event_id           text,
  -- contact and request
  contact_name              text not null default '',
  email                     text,
  phone_e164                text,
  phone_raw                 text,
  service_address           text,
  requested_service         text,
  details                   text,
  urgency                   text not null default 'normal',
  preferred_contact_method  text,
  preferred_callback_at     timestamptz,
  custom_fields             jsonb not null default '{}'::jsonb,
  -- workflow
  status                    text not null default 'new',
  assigned_to               uuid references public.profiles (id) on delete set null,
  follow_up_at              timestamptz,
  -- consent evidence
  email_marketing_consent   boolean not null default false,
  sms_consent               boolean not null default false,
  sms_consent_text          text,
  sms_consent_version       text,
  sms_consent_source        text,
  sms_consent_at            timestamptz,
  -- voice / source evidence
  call_id                   text,
  caller_phone              text,
  call_classification       text,
  call_summary              text,
  review_recommended        boolean not null default false,
  review_reason             text,
  ended_reason              text,
  -- lifecycle
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  archived_at               timestamptz,

  constraint ck_leads_lead_number_format check (lead_number ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  constraint ck_leads_source check (source in ('website_form', 'voice_call', 'manual', 'import')),
  constraint ck_leads_source_event_id_length check (source_event_id is null or length(source_event_id) between 1 and 255),
  constraint ck_leads_contact_name_length check (length(contact_name) <= 200),
  constraint ck_leads_email_format check (email is null or (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(email) <= 320)),
  constraint ck_leads_phone_e164_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint ck_leads_phone_raw_length check (phone_raw is null or length(phone_raw) <= 64),
  constraint ck_leads_service_address_length check (service_address is null or length(service_address) <= 500),
  constraint ck_leads_requested_service_length check (requested_service is null or length(requested_service) <= 300),
  constraint ck_leads_details_length check (details is null or length(details) <= 5000),
  constraint ck_leads_urgency check (urgency in ('normal', 'urgent', 'emergency')),
  constraint ck_leads_preferred_contact_method check (preferred_contact_method is null or preferred_contact_method in ('phone', 'text', 'email')),
  constraint ck_leads_custom_fields_object check (jsonb_typeof(custom_fields) = 'object'),
  constraint ck_leads_status check (status in ('new', 'contacted', 'qualified', 'scheduled', 'won', 'lost', 'spam')),
  constraint ck_leads_sms_consent_source check (sms_consent_source is null or sms_consent_source in ('website_form', 'voice_call', 'manual')),
  constraint ck_leads_sms_consent_text_length check (sms_consent_text is null or length(sms_consent_text) <= 2000),
  constraint ck_leads_sms_consent_version_length check (sms_consent_version is null or length(sms_consent_version) <= 64),
  -- consent = true requires the evidence that proves what was agreed, where and when
  constraint ck_leads_sms_consent_evidence check (
    sms_consent = false
    or (sms_consent_text is not null and sms_consent_version is not null
        and sms_consent_source is not null and sms_consent_at is not null)),
  constraint ck_leads_call_id_length check (call_id is null or length(call_id) between 1 and 255),
  constraint ck_leads_caller_phone_format check (caller_phone is null or caller_phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint ck_leads_call_classification_format check (call_classification is null or call_classification ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint ck_leads_call_summary_length check (call_summary is null or length(call_summary) <= 5000),
  constraint ck_leads_review_reason_length check (review_reason is null or length(review_reason) <= 1000),
  constraint ck_leads_ended_reason_length check (ended_reason is null or length(ended_reason) <= 128),
  -- a voice lead carries its full call id, and that full id IS its idempotency identity
  constraint ck_leads_voice_call_identity check (
    source <> 'voice_call' or (call_id is not null and source_event_id = call_id)),

  constraint uq_leads_business_lead_number unique (business_id, lead_number)
);
comment on table public.leads is 'Contacts / service requests owned by one business. Leads are archived, never deleted.';
comment on column public.leads.source_event_id is
  'Full trusted source event id (complete Vapi call id, form submission id). Replay-protected per business + source.';

-- replay protection: one lead per (business, source, full source event id)
create unique index uq_leads_business_source_event
  on public.leads (business_id, source, source_event_id) where source_event_id is not null;

create index ix_leads_business_created_at on public.leads (business_id, created_at desc);
create index ix_leads_business_status on public.leads (business_id, status);
create index ix_leads_business_follow_up on public.leads (business_id, follow_up_at) where follow_up_at is not null;
create index ix_leads_business_assigned_to on public.leads (business_id, assigned_to) where assigned_to is not null;

create trigger trg_leads_updated_at
  before update on public.leads
  for each row execute function private.set_updated_at();

-- Assignment integrity: assigned_to must be an ACTIVE member of the SAME business.
-- Applies to every role (including future server-side writers). SECURITY DEFINER so
-- the membership check is complete regardless of the caller's RLS visibility.
create or replace function private.enforce_lead_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_to is null then
    return new;
  end if;
  if not exists (
    select 1
    from public.business_memberships m
    join public.profiles p on p.id = m.user_id
    where m.user_id = new.assigned_to
      and m.business_id = new.business_id
      and m.status = 'active'
      and p.is_active
  ) then
    raise exception 'leads.assigned_to must reference an active member of business %', new.business_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_lead_assignee() from public;

create trigger trg_leads_enforce_assignee
  before insert or update of assigned_to, business_id on public.leads
  for each row execute function private.enforce_lead_assignee();

-- ---------------------------------------------------------------------------
-- Grants: a separate control from RLS. Start from zero for anon/authenticated.
-- ---------------------------------------------------------------------------
revoke all on table public.businesses, public.profiles, public.business_memberships,
                public.integration_sources, public.leads
  from public, anon, authenticated;

grant all on table public.businesses, public.profiles, public.business_memberships,
               public.integration_sources, public.leads
  to service_role;

-- authenticated: read-only by default; the minimum writes Batch 1 allows
grant select on table public.businesses to authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;
grant select on table public.business_memberships to authenticated;
grant select on table public.integration_sources to authenticated;   -- rows limited to platform admins by RLS
grant select on table public.leads to authenticated;
grant update (status, follow_up_at) on table public.leads to authenticated;
-- no INSERT or DELETE for authenticated on any Batch 1 table; nothing at all for anon
