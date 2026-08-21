-- =============================================================================
-- Batch 2A corrective: harden the trusted ingestion boundary (append-only).
--   F1  filtered-event metadata restricted to an explicit, bounded allow-list
--       (no review_reason / free text); existing filtered rows corrected.
--   F2  lead numbers: four digits is a MINIMUM width (10000 stays 10000).
--   F3  external timestamps must carry an explicit timezone; parser is STABLE.
--   F4  source_event_id stored byte-for-byte; surrounding whitespace rejected.
-- Signatures, SECURITY DEFINER, empty search_path, ownership and the
-- service_role-only execution model are preserved and restated.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- F3: unambiguous external timestamps
-- ---------------------------------------------------------------------------
create or replace function private.payload_timestamptz(p jsonb, k text)
returns timestamptz
language plpgsql
stable                      -- text -> timestamptz consults session settings; never claim immutability
set search_path = ''
as $$
declare
  t text := private.payload_text(p, k, 64);
begin
  if t is null then
    return null;
  end if;
  -- ISO 8601 / RFC 3339 with an EXPLICIT zone: 'Z' or a numeric offset. Nothing else.
  if t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    raise exception 'payload field "%" must be an ISO 8601 timestamp with an explicit timezone (Z or +/-HH:MM)', k
      using errcode = 'invalid_parameter_value';
  end if;
  begin
    return t::timestamptz;
  exception when others then
    raise exception 'payload field "%" is not a valid timestamp', k using errcode = 'invalid_parameter_value';
  end;
end;
$$;
revoke all on function private.payload_timestamptz(jsonb, text) from public;

-- ---------------------------------------------------------------------------
-- F2: four-digit MINIMUM width for the sequence part
-- ---------------------------------------------------------------------------
create or replace function private.allocate_lead_number(p_business_id uuid, p_timezone text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_year   integer := extract(year from (now() at time zone p_timezone))::integer;
  v_prefix text;
  v_n      integer;
begin
  v_prefix := 'INQ-' || v_year::text || '-';
  insert into public.lead_number_counters as c (business_id, year, last_value)
  values (
    p_business_id,
    v_year,
    (select coalesce(max(substring(l.lead_number from length(v_prefix) + 1)::integer), 0)
       from public.leads l
      where l.business_id = p_business_id
        and l.lead_number ~ ('^' || v_prefix || '[0-9]+$')) + 1)
  on conflict (business_id, year) do update
    set last_value = c.last_value + 1
  returning c.last_value into v_n;
  -- lpad truncates beyond the requested width; pad only when shorter than 4 digits
  return v_prefix || case when length(v_n::text) < 4 then lpad(v_n::text, 4, '0') else v_n::text end;
end;
$$;
revoke all on function private.allocate_lead_number(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- F1 + F4: the RPC (identical to Batch 2A except the marked corrections)
-- ---------------------------------------------------------------------------
create or replace function public.ingest_lead_event(
  p_source_kind        text,   -- registered integration_sources.kind
  p_source_external_id text,   -- registered integration_sources.external_id
  p_source_event_id    text,   -- complete, stable upstream event id (full Vapi call id / form submission id)
  p_payload            jsonb   -- validated normalized lead/call data (allow-listed keys only)
)
returns table (
  outcome              text,     -- lead_created | duplicate_lead | filtered | duplicate_filtered
  should_notify        boolean,  -- true only when a lead was newly created by THIS call
  customer_sms_allowed boolean,  -- true only when newly created AND sms_consent AND a valid phone_e164
  business_id          uuid,
  lead_id              uuid,
  lead_number          text,
  ingestion_event_id   uuid,
  attempt_count        integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_forbidden constant text[] := array[
    'id', 'business_id', 'lead_number', 'source', 'source_event_id', 'status', 'assigned_to',
    'archived_at', 'created_at', 'updated_at', 'follow_up_at', 'platform_role', 'integration_source_id'];
  c_allowed_common constant text[] := array[
    'contact_name', 'email', 'phone_e164', 'phone_raw', 'service_address', 'requested_service', 'details',
    'urgency', 'preferred_contact_method', 'preferred_callback_at', 'custom_fields',
    'email_marketing_consent', 'sms_consent', 'sms_consent_text', 'sms_consent_version',
    'sms_consent_source', 'sms_consent_at'];
  c_allowed_voice constant text[] := array[
    'call_id', 'caller_phone', 'call_classification', 'call_summary', 'review_recommended',
    'review_reason', 'ended_reason', 'is_lead'];

  v_event_id        text;
  v_lead_source     text;
  v_source          public.integration_sources%rowtype;
  v_business        public.businesses%rowtype;
  v_existing        public.ingestion_events%rowtype;
  v_key             text;
  v_constraint      text;

  v_sms_consent     boolean;
  v_phone           text;
  v_caller_phone    text;
  v_email           text;
  v_custom          jsonb;
  v_call_id         text;
  v_is_lead         boolean;
  v_classification  text;
  v_ended_reason    text;
  v_metadata        jsonb := '{}'::jsonb;

  v_new_lead_id     uuid;
  v_new_lead_number text;
  v_new_event_id    uuid;
begin
  -- ---- 1. required identifiers --------------------------------------------------
  v_event_id := p_source_event_id;   -- stored byte-for-byte; never transformed
  if v_event_id is null or v_event_id = '' or length(v_event_id) > 255 then
    raise exception 'source_event_id is required (1-255 characters)' using errcode = 'invalid_parameter_value';
  end if;
  if v_event_id <> btrim(v_event_id) then
    raise exception 'source_event_id must not have leading or trailing whitespace' using errcode = 'invalid_parameter_value';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  -- ---- 2. source kind -> lead source ----------------------------------------------
  v_lead_source := case p_source_kind
    when 'website_form'      then 'website_form'
    when 'vapi_assistant'    then 'voice_call'
    when 'vapi_phone_number' then 'voice_call'
    else null end;
  if v_lead_source is null then
    raise exception 'unsupported integration source kind' using errcode = 'invalid_parameter_value';
  end if;

  -- ---- 3. payload allow-list: system-managed fields are never caller-controlled ----
  for v_key in select jsonb_object_keys(p_payload) loop
    if v_key = any (c_forbidden) then
      raise exception 'payload must not contain system-managed field "%"', v_key using errcode = 'insufficient_privilege';
    end if;
    if not (v_key = any (c_allowed_common) or (v_lead_source = 'voice_call' and v_key = any (c_allowed_voice))) then
      raise exception 'unsupported payload field "%"', v_key using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  -- ---- 4. trusted tenant resolution (locked against concurrent status changes) -----
  select s.* into v_source
  from public.integration_sources s
  where s.kind = p_source_kind
    and s.external_id = btrim(coalesce(p_source_external_id, ''))
  for share;
  if not found then
    raise exception 'unknown integration source' using errcode = 'no_data_found';
  end if;
  if v_source.status <> 'active' then
    raise exception 'integration source is inactive' using errcode = 'object_not_in_prerequisite_state';
  end if;
  select b.* into v_business
  from public.businesses b
  where b.id = v_source.business_id
  for share;
  if not found or v_business.status <> 'active' then
    raise exception 'business is not active' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- ---- 5. replay of an already-processed event ------------------------------------------
  select e.* into v_existing
  from public.ingestion_events e
  where e.business_id = v_business.id and e.source = v_lead_source and e.source_event_id = v_event_id;
  if found then
    update public.ingestion_events e
       set attempt_count = e.attempt_count + 1, last_received_at = now()
     where e.id = v_existing.id
    returning e.attempt_count into v_existing.attempt_count;
    return query
      select case v_existing.outcome when 'lead_created' then 'duplicate_lead' else 'duplicate_filtered' end,
             false, false, v_existing.business_id, v_existing.lead_id,
             (select l.lead_number from public.leads l where l.id = v_existing.lead_id),
             v_existing.id, v_existing.attempt_count;
    return;
  end if;

  -- ---- 6. validation common to both sources ----------------------------------------------
  v_sms_consent := private.payload_bool(p_payload, 'sms_consent', false);
  v_phone := private.payload_text(p_payload, 'phone_e164', 32);
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'phone_e164 is not a valid E.164 number' using errcode = 'invalid_parameter_value';
  end if;
  v_email := lower(private.payload_text(p_payload, 'email', 320));
  v_custom := coalesce(p_payload -> 'custom_fields', '{}'::jsonb);
  if jsonb_typeof(v_custom) <> 'object' then
    raise exception 'custom_fields must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from jsonb_object_keys(v_custom)) > 32 or length(v_custom::text) > 8000 then
    raise exception 'custom_fields is too large (max 32 keys / 8000 characters)' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from jsonb_each(v_custom) as kv where jsonb_typeof(kv.value) in ('object', 'array')) then
    raise exception 'custom_fields values must be scalars' using errcode = 'invalid_parameter_value';
  end if;

  -- ---- 7. voice-specific rules and the legitimate-lead filter ----------------------------
  if v_lead_source = 'voice_call' then
    if v_sms_consent
       or private.payload_text(p_payload, 'sms_consent_text', 2000) is not null
       or private.payload_text(p_payload, 'sms_consent_version', 64) is not null
       or private.payload_text(p_payload, 'sms_consent_source', 32) is not null
       or private.payload_timestamptz(p_payload, 'sms_consent_at') is not null then
      raise exception 'voice SMS consent is not supported; sms_consent must be false with no evidence'
        using errcode = 'feature_not_supported';
    end if;
    v_call_id := private.payload_text(p_payload, 'call_id', 255);
    if v_call_id is null then
      raise exception 'call_id is required for voice events' using errcode = 'invalid_parameter_value';
    end if;
    if v_call_id <> v_event_id then
      raise exception 'call_id must equal the complete source_event_id (no truncation)' using errcode = 'invalid_parameter_value';
    end if;
    v_caller_phone := private.payload_text(p_payload, 'caller_phone', 32);
    if v_caller_phone is not null and v_caller_phone !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception 'caller_phone is not a valid E.164 number' using errcode = 'invalid_parameter_value';
    end if;
    v_is_lead := private.payload_bool(p_payload, 'is_lead', false);
    v_classification := private.payload_text(p_payload, 'call_classification', 64);
    if v_classification is not null and v_classification !~ '^[a-z][a-z0-9_]{0,63}$' then
      raise exception 'call_classification must be a machine-readable code (lowercase snake_case)' using errcode = 'invalid_parameter_value';
    end if;
    v_ended_reason := private.payload_text(p_payload, 'ended_reason', 128);
    if v_ended_reason is not null and v_ended_reason !~ '^[a-z0-9][a-z0-9._-]{0,127}$' then
      raise exception 'ended_reason must be a machine-readable provider code' using errcode = 'invalid_parameter_value';
    end if;

    if not v_is_lead or v_classification is distinct from 'legitimate_lead' then
      -- filtered: auditable operational event, no lead, no notification
      -- Allow-listed, bounded, machine-readable values ONLY. Never free text
      -- (review_reason, summary, details), never contact data, never raw payload.
      v_metadata := jsonb_strip_nulls(jsonb_build_object(
        'filter_reason', case when not v_is_lead then 'not_a_lead' else 'classification_not_legitimate' end,
        'is_lead', v_is_lead,
        'call_classification', v_classification,
        'review_recommended', private.payload_bool(p_payload, 'review_recommended', false),
        'ended_reason', v_ended_reason));
      begin
        insert into public.ingestion_events (business_id, integration_source_id, source, source_event_id, outcome, lead_id, metadata)
        values (v_business.id, v_source.id, v_lead_source, v_event_id, 'filtered', null, v_metadata)
        returning id into v_new_event_id;
      exception when unique_violation then
        -- a concurrent delivery of the same call won; report it as the duplicate it is
        select e.* into v_existing from public.ingestion_events e
         where e.business_id = v_business.id and e.source = v_lead_source and e.source_event_id = v_event_id;
        if not found then raise; end if;
        update public.ingestion_events e set attempt_count = e.attempt_count + 1, last_received_at = now()
         where e.id = v_existing.id returning e.attempt_count into v_existing.attempt_count;
        return query select 'duplicate_filtered', false, false, v_existing.business_id, null::uuid, null::text, v_existing.id, v_existing.attempt_count;
        return;
      end;
      return query select 'filtered', false, false, v_business.id, null::uuid, null::text, v_new_event_id, 1;
      return;
    end if;
    v_metadata := jsonb_strip_nulls(jsonb_build_object('call_classification', v_classification));
  end if;

  -- ---- 8. consent evidence (never fabricated) ----------------------------------------------
  if v_sms_consent and (
       private.payload_text(p_payload, 'sms_consent_text', 2000) is null
    or private.payload_text(p_payload, 'sms_consent_version', 64) is null
    or private.payload_text(p_payload, 'sms_consent_source', 32) is null
    or private.payload_timestamptz(p_payload, 'sms_consent_at') is null) then
    raise exception 'sms_consent = true requires complete evidence: text, version, source and timestamp'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ---- 9. create lead + event atomically ----------------------------------------------------
  -- A concurrent duplicate loses on a unique constraint inside this subtransaction,
  -- which rolls back its lead-number allocation (nothing consumed) and is then
  -- answered from the winner's committed row.
  begin
    v_new_lead_number := private.allocate_lead_number(v_business.id, v_business.timezone);
    insert into public.leads (
      business_id, lead_number, source, source_event_id,
      contact_name, email, phone_e164, phone_raw, service_address, requested_service, details,
      urgency, preferred_contact_method, preferred_callback_at, custom_fields,
      status,
      email_marketing_consent, sms_consent, sms_consent_text, sms_consent_version, sms_consent_source, sms_consent_at,
      call_id, caller_phone, call_classification, call_summary, review_recommended, review_reason, ended_reason
    ) values (
      v_business.id, v_new_lead_number, v_lead_source, v_event_id,
      coalesce(private.payload_text(p_payload, 'contact_name', 200), ''),
      v_email,
      v_phone,
      private.payload_text(p_payload, 'phone_raw', 64),
      private.payload_text(p_payload, 'service_address', 500),
      private.payload_text(p_payload, 'requested_service', 300),
      private.payload_text(p_payload, 'details', 5000),
      coalesce(private.payload_text(p_payload, 'urgency', 16), 'normal'),
      private.payload_text(p_payload, 'preferred_contact_method', 16),
      private.payload_timestamptz(p_payload, 'preferred_callback_at'),
      v_custom,
      'new',
      private.payload_bool(p_payload, 'email_marketing_consent', false),
      v_sms_consent,
      case when v_sms_consent then private.payload_text(p_payload, 'sms_consent_text', 2000) end,
      case when v_sms_consent then private.payload_text(p_payload, 'sms_consent_version', 64) end,
      case when v_sms_consent then private.payload_text(p_payload, 'sms_consent_source', 32) end,
      case when v_sms_consent then private.payload_timestamptz(p_payload, 'sms_consent_at') end,
      v_call_id,
      v_caller_phone,
      v_classification,
      private.payload_text(p_payload, 'call_summary', 5000),
      private.payload_bool(p_payload, 'review_recommended', false),
      private.payload_text(p_payload, 'review_reason', 1000),
      v_ended_reason
    )
    returning id into v_new_lead_id;

    insert into public.ingestion_events (business_id, integration_source_id, source, source_event_id, outcome, lead_id, metadata)
    values (v_business.id, v_source.id, v_lead_source, v_event_id, 'lead_created', v_new_lead_id, v_metadata)
    returning id into v_new_event_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint not in ('uq_leads_business_source_event', 'uq_ingestion_events_business_source_event') then
      raise;  -- some other uniqueness problem: surface it
    end if;
    select e.* into v_existing from public.ingestion_events e
     where e.business_id = v_business.id and e.source = v_lead_source and e.source_event_id = v_event_id;
    if not found then raise; end if;
    update public.ingestion_events e set attempt_count = e.attempt_count + 1, last_received_at = now()
     where e.id = v_existing.id returning e.attempt_count into v_existing.attempt_count;
    return query
      select case v_existing.outcome when 'lead_created' then 'duplicate_lead' else 'duplicate_filtered' end,
             false, false, v_existing.business_id, v_existing.lead_id,
             (select l.lead_number from public.leads l where l.id = v_existing.lead_id),
             v_existing.id, v_existing.attempt_count;
    return;
  end;

  return query
    select 'lead_created', true, (v_sms_consent and v_phone is not null),
           v_business.id, v_new_lead_id, v_new_lead_number, v_new_event_id, 1;
end;
$$;


comment on function public.ingest_lead_event(text, text, text, jsonb) is
  'Privileged (service_role only) idempotent lead ingestion. Tenant resolved solely from integration_sources(kind, external_id). '
  'Outcome: lead_created | duplicate_lead | filtered | duplicate_filtered; should_notify is true only for lead_created. '
  'source_event_id is stored exactly as received; filtered metadata is an allow-listed set of machine-readable values.';

-- execution model restated: server-side privileged role only
revoke all on function public.ingest_lead_event(text, text, text, jsonb) from public;
revoke all on function public.ingest_lead_event(text, text, text, jsonb) from anon;
revoke all on function public.ingest_lead_event(text, text, text, jsonb) from authenticated;
grant execute on function public.ingest_lead_event(text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- F1 data correction: strip free text already stored on FILTERED events only
-- ---------------------------------------------------------------------------
update public.ingestion_events
   set metadata = metadata - 'review_reason'
 where outcome = 'filtered'
   and metadata ? 'review_reason';
