-- =============================================================================
-- Batch 2A / Migration 1: operational ingestion events + lead-number allocator
-- Append-only. Existing committed migrations are never altered.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- leads: composite key so a referencing row can be forced to the SAME business
-- ---------------------------------------------------------------------------
alter table public.leads
  add constraint uq_leads_id_business unique (id, business_id);

-- ---------------------------------------------------------------------------
-- lead_number_counters: minimal per-business, per-business-local-year allocator.
-- Written only by the privileged ingestion path; no ordinary-user access.
-- ---------------------------------------------------------------------------
create table public.lead_number_counters (
  business_id  uuid not null references public.businesses (id) on delete restrict,
  year         integer not null,
  last_value   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint pk_lead_number_counters primary key (business_id, year),
  constraint ck_lead_number_counters_year check (year between 2000 and 2999),
  constraint ck_lead_number_counters_last_value check (last_value >= 0)
);
comment on table public.lead_number_counters is
  'Internal allocator for human-readable lead numbers (INQ-<year>-<n>) per business. Not user-accessible.';

create trigger trg_lead_number_counters_updated_at
  before update on public.lead_number_counters
  for each row execute function private.set_updated_at();
create trigger trg_z_lead_number_counters_protect_identity
  before update on public.lead_number_counters
  for each row execute function private.protect_row_identity();

revoke all on table public.lead_number_counters from public, anon, authenticated;
grant all on table public.lead_number_counters to service_role;

alter table public.lead_number_counters enable row level security;
alter table public.lead_number_counters force  row level security;
-- no policies at all: only bypassrls roles (postgres/service_role) can touch it

-- ---------------------------------------------------------------------------
-- ingestion_events: one row per (business, source, complete source event id).
-- Operational audit of every delivery, including filtered (non-lead) calls.
-- ---------------------------------------------------------------------------
create table public.ingestion_events (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete restrict,
  integration_source_id  uuid not null references public.integration_sources (id) on delete restrict,
  source                 text not null,
  source_event_id        text not null,
  outcome                text not null,
  lead_id                uuid,
  attempt_count          integer not null default 1,
  first_received_at      timestamptz not null default now(),
  last_received_at       timestamptz not null default now(),
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint ck_ingestion_events_source check (source in ('website_form', 'voice_call')),
  constraint ck_ingestion_events_source_event_id_length check (length(source_event_id) between 1 and 255),
  constraint ck_ingestion_events_outcome check (outcome in ('lead_created', 'filtered')),
  constraint ck_ingestion_events_lead_presence check (
    (outcome = 'lead_created' and lead_id is not null) or (outcome = 'filtered' and lead_id is null)),
  constraint ck_ingestion_events_attempt_count check (attempt_count >= 1),
  constraint ck_ingestion_events_received_order check (last_received_at >= first_received_at),
  constraint ck_ingestion_events_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint ck_ingestion_events_metadata_size check (length(metadata::text) <= 4000),
  -- event idempotency: one row per business + source + COMPLETE source event id
  constraint uq_ingestion_events_business_source_event unique (business_id, source, source_event_id),
  -- a referenced lead must belong to the SAME business (database-level invariant)
  constraint fk_ingestion_events_lead_same_business
    foreign key (lead_id, business_id) references public.leads (id, business_id) on delete restrict
);
comment on table public.ingestion_events is
  'Operational ingestion ledger. Never stores credentials, raw webhook bodies, transcripts or duplicate customer data.';
comment on column public.ingestion_events.metadata is
  'Minimal sanitized operational facts (e.g. filter_reason, call_classification). Bounded to 4000 chars.';

create index ix_ingestion_events_business_received on public.ingestion_events (business_id, last_received_at desc);
create index ix_ingestion_events_business_outcome on public.ingestion_events (business_id, outcome);
create index ix_ingestion_events_lead on public.ingestion_events (lead_id) where lead_id is not null;

create trigger trg_ingestion_events_updated_at
  before update on public.ingestion_events
  for each row execute function private.set_updated_at();
-- identity (id, business_id, created_at) immutable for every role
create trigger trg_z_ingestion_events_protect_identity
  before update on public.ingestion_events
  for each row execute function private.protect_row_identity();
-- ordinary roles may change nothing at all (they also hold no UPDATE grant)
create trigger trg_z_ingestion_events_protect_system_fields
  before update on public.ingestion_events
  for each row execute function private.protect_system_fields();

-- event identity (source, source_event_id, integration_source_id) immutable for every role
create or replace function private.protect_ingestion_event_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source is distinct from old.source
     or new.source_event_id is distinct from old.source_event_id
     or new.integration_source_id is distinct from old.integration_source_id then
    raise exception 'ingestion_events: source, source_event_id and integration_source_id are immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_ingestion_event_identity() from public;

create trigger trg_z_ingestion_events_protect_event_identity
  before update on public.ingestion_events
  for each row execute function private.protect_ingestion_event_identity();

-- grants: nothing for anon; authenticated may SELECT (rows limited to platform admins by RLS)
revoke all on table public.ingestion_events from public, anon, authenticated;
grant all on table public.ingestion_events to service_role;
grant select on table public.ingestion_events to authenticated;

alter table public.ingestion_events enable row level security;
alter table public.ingestion_events force  row level security;

create policy ingestion_events_select_platform_admin
  on public.ingestion_events
  for select
  to authenticated
  using ((select private.is_platform_admin()));
-- no INSERT / UPDATE / DELETE policy for any role
