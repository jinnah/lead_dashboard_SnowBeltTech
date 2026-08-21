-- Ingestion boundary posture: tables, RLS, grants, RPC execution model,
-- immutability. Catalog checks as postgres; access proofs as anon/authenticated.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(45);

-- ---- structure --------------------------------------------------------------------
select has_table('public', 'ingestion_events', 'ingestion_events exists');
select has_table('public', 'lead_number_counters', 'lead_number_counters exists');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.ingestion_events'::regclass), 'ingestion_events: RLS enabled+forced');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.lead_number_counters'::regclass), 'lead_number_counters: RLS enabled+forced');
select col_is_unique('public', 'ingestion_events', array['business_id', 'source', 'source_event_id'], 'event idempotency key is unique');
select has_fk('public', 'ingestion_events', 'ingestion_events has foreign keys');
select ok((select exists (select 1 from pg_constraint where conname = 'fk_ingestion_events_lead_same_business' and contype = 'f')),
  'composite FK (lead_id, business_id) -> leads(id, business_id) enforces same-business leads');
select ok((select exists (select 1 from pg_constraint where conname = 'uq_leads_id_business' and contype = 'u')),
  'leads (id, business_id) composite unique exists');
select has_function('public', 'ingest_lead_event', array['text', 'text', 'text', 'jsonb'], 'ingest_lead_event(text,text,text,jsonb) exists');
select has_function('private', 'allocate_lead_number', array['uuid', 'text'], 'allocate_lead_number exists in private');

-- ---- policies ---------------------------------------------------------------------
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'ingestion_events'), 1::bigint, 'ingestion_events has exactly one policy');
select is((select cmd || ':' || array_to_string(roles, ',') from pg_policies where tablename = 'ingestion_events'), 'SELECT:authenticated', 'that policy is SELECT for authenticated only');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'lead_number_counters'), 0::bigint, 'lead_number_counters has no policies (bypassrls roles only)');
select is((select count(*) from pg_policies where schemaname = 'public' and cmd in ('DELETE', 'ALL')), 0::bigint, 'still no DELETE / ALL policy anywhere');
select is((select count(*) from pg_policies where schemaname = 'public' and cmd in ('INSERT')), 0::bigint, 'still no INSERT policy anywhere');

-- ---- grants -----------------------------------------------------------------------
select is((select bool_or(has_table_privilege('anon', t, p))
           from unnest(array['public.ingestion_events', 'public.lead_number_counters']) t
           cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p)
          or (select bool_or(has_any_column_privilege('anon', t, p))
           from unnest(array['public.ingestion_events', 'public.lead_number_counters']) t
           cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p),
  false, 'anon has no table- or column-level privilege on ingestion_events or lead_number_counters');
select is((select bool_or(has_table_privilege('authenticated', 'public.ingestion_events', p))
           from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p)
          or (select bool_or(has_any_column_privilege('authenticated', 'public.ingestion_events', p))
           from unnest(array['INSERT', 'UPDATE', 'REFERENCES']) p),
  false, 'authenticated has no table- or column-level write privilege on ingestion_events');
select is(has_table_privilege('authenticated', 'public.ingestion_events', 'SELECT'), true, 'authenticated may SELECT ingestion_events (rows limited to platform admins by RLS)');
select is((select bool_or(has_table_privilege('authenticated', 'public.lead_number_counters', p))
           from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p)
          or (select bool_or(has_any_column_privilege('authenticated', 'public.lead_number_counters', p))
           from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p),
  false, 'authenticated has no privilege at all on lead_number_counters');
select is(has_table_privilege('service_role', 'public.ingestion_events', 'INSERT'), true, 'service_role can write ingestion_events');

-- ---- RPC execution model --------------------------------------------------------------
select is(has_function_privilege('anon', 'public.ingest_lead_event(text,text,text,jsonb)', 'EXECUTE'), false, 'anon cannot execute ingest_lead_event');
select is(has_function_privilege('authenticated', 'public.ingest_lead_event(text,text,text,jsonb)', 'EXECUTE'), false, 'authenticated cannot execute ingest_lead_event');
select is(has_function_privilege('public', 'public.ingest_lead_event(text,text,text,jsonb)', 'EXECUTE'), false, 'PUBLIC cannot execute ingest_lead_event');
select is(has_function_privilege('service_role', 'public.ingest_lead_event(text,text,text,jsonb)', 'EXECUTE'), true, 'service_role can execute ingest_lead_event');
select is((select prosecdef from pg_proc where oid = 'public.ingest_lead_event(text,text,text,jsonb)'::regprocedure), true, 'ingest_lead_event is SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'public.ingest_lead_event(text,text,text,jsonb)'::regprocedure), 'ingest_lead_event pins an empty search_path');
select is((select rolbypassrls from pg_roles where oid = (select proowner from pg_proc where oid = 'public.ingest_lead_event(text,text,text,jsonb)'::regprocedure)), true, 'ingest_lead_event owner is a bypassrls role');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and not exists (select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))), 0::bigint,
  'every private function (incl. new payload/allocator helpers) pins an empty search_path');
select is((select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname in ('payload_text', 'payload_bool', 'payload_timestamptz', 'allocate_lead_number', 'protect_ingestion_event_identity')),
  false, 'new private helpers are not executable by anon or authenticated');

-- ---- live access proofs -----------------------------------------------------------------
select pg_temp.login_anon();
select throws_ok('select count(*) from public.ingestion_events', '42501', null, 'anon cannot read ingestion_events');
select throws_ok('select count(*) from public.lead_number_counters', '42501', null, 'anon cannot read lead_number_counters');
select throws_ok($$select * from public.ingest_lead_event('website_form', 'x', 'y', '{}')$$, '42501', null, 'anon cannot call the RPC');
select pg_temp.logout();

select pg_temp.login_as(:'a_owner');
select is((select count(*) from public.ingestion_events), 0::bigint, 'business owner sees no ingestion events (operational data)');
select throws_ok('select count(*) from public.lead_number_counters', '42501', null, 'business owner cannot read lead_number_counters');
select throws_ok($$select * from public.ingest_lead_event('website_form', 'site-alpha-synthetic', 'y', '{}')$$, '42501', null, 'business owner cannot call the RPC');
select throws_ok($$insert into public.ingestion_events (business_id, integration_source_id, source, source_event_id, outcome) values (gen_random_uuid(), gen_random_uuid(), 'website_form', 'x', 'filtered')$$, '42501', null, 'business owner cannot insert ingestion events');
select pg_temp.logout();

-- ---- immutability (as postgres; bypassrls, so only the triggers/constraints answer) ----------
select pg_temp.login_service();
select lives_ok($$select * from public.ingest_lead_event('website_form', 'site-alpha-synthetic', 'posture-evt-1', '{"contact_name":"Posture"}')$$, 'service_role can call the RPC');
select pg_temp.logout();
select throws_ok(format($$update public.ingestion_events set business_id = %L where source_event_id = 'posture-evt-1'$$, :'biz_b'), '23514', null, 'event business_id is immutable');
select throws_ok($$update public.ingestion_events set source_event_id = 'other' where source_event_id = 'posture-evt-1'$$, '23514', null, 'event source_event_id is immutable');
select throws_ok($$update public.ingestion_events set source = 'voice_call' where source_event_id = 'posture-evt-1'$$, '23514', null, 'event source is immutable');
select throws_ok($$update public.ingestion_events set id = gen_random_uuid() where source_event_id = 'posture-evt-1'$$, '23514', null, 'event id is immutable');
select throws_ok(
  format($$insert into public.ingestion_events (business_id, integration_source_id, source, source_event_id, outcome, lead_id)
           values (%L, (select id from public.integration_sources where external_id = 'site-bravo-synthetic'), 'website_form', 'cross-biz', 'lead_created', %L)$$, :'biz_b', :'lead_a1'),
  '23503', null, 'an event cannot reference a lead of a different business (composite FK)');
select throws_ok(
  format($$insert into public.ingestion_events (business_id, integration_source_id, source, source_event_id, outcome, lead_id)
           values (%L, (select id from public.integration_sources where external_id = 'site-alpha-synthetic'), 'website_form', 'no-lead', 'lead_created', null)$$, :'biz_a'),
  '23514', null, 'outcome lead_created requires a lead_id');
select throws_ok(
  format($$insert into public.ingestion_events (business_id, integration_source_id, source, source_event_id, outcome, lead_id)
           values (%L, (select id from public.integration_sources where external_id = 'site-alpha-synthetic'), 'website_form', 'filtered-with-lead', 'filtered', %L)$$, :'biz_a', :'lead_a1'),
  '23514', null, 'outcome filtered must not carry a lead_id');
select throws_ok(
  format($$insert into public.ingestion_events (business_id, integration_source_id, source, source_event_id, outcome)
           values (%L, (select id from public.integration_sources where external_id = 'site-alpha-synthetic'), 'website_form', 'posture-evt-1', 'filtered')$$, :'biz_a'),
  '23505', null, 'duplicate (business, source, source_event_id) event is rejected');

select * from finish();
rollback;
