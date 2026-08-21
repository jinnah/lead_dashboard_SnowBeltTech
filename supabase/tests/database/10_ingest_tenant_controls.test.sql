-- Tenant routing and source controls for ingestion, plus visibility of the
-- results through existing RLS (business users vs platform admin).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(26);

select pg_temp.login_service();

-- ---- routing is by registered source, never by payload -------------------------------------
create temp table ra as select * from public.ingest_lead_event('website_form', :'src_a_web', 'shared-evt-1', '{"contact_name":"Via A source"}'::jsonb);
create temp table rb as select * from public.ingest_lead_event('website_form', :'src_b_web', 'shared-evt-1', '{"contact_name":"Via B source"}'::jsonb);
select is((select business_id from ra), :'biz_a'::uuid, 'A source routes to Business A');
select is((select business_id from rb), :'biz_b'::uuid, 'B source routes to Business B');
select is((select outcome from rb), 'lead_created', 'the same event id is an independent lead for a different business');
select is((select count(*) from public.leads where source_event_id = 'shared-evt-1'), 2::bigint, 'two leads, one per business');
select is((select lead_number from rb), 'INQ-2026-0003', 'Business B numbering continues from its own seeded max');
select is((select count(distinct business_id) from public.ingestion_events where source_event_id = 'shared-evt-1'), 2::bigint, 'two independent events');

-- same event id across distinct source types (website vs voice) in one business
create temp table rv as select * from public.ingest_lead_event('vapi_assistant', :'src_a_vapi', 'shared-evt-1', '{"call_id":"shared-evt-1","is_lead":true,"call_classification":"legitimate_lead"}'::jsonb);
select is((select outcome from rv), 'lead_created', 'same event id under a different source type is a separate identity');
select is((select count(*) from public.leads where business_id = :'biz_a' and source_event_id = 'shared-evt-1'), 2::bigint, 'Business A now has a web lead and a voice lead with that id');

-- ---- source / business controls --------------------------------------------------------------
select throws_ok(format($$select * from public.ingest_lead_event('website_form', 'site-does-not-exist', 'evt-x', '{"contact_name":"x"}')$$), 'P0002', null, 'unknown source identifier rejected');
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'evt-x', '{"contact_name":"x"}')$$, :'src_a_web'), 'P0002', null, 'identifier registered under another kind is not resolved');
select throws_ok(format($$select * from public.ingest_lead_event('twilio_number', '+15550100000', 'evt-x', '{"contact_name":"x"}')$$), '22023', null, 'unsupported source kind rejected');

select pg_temp.logout();
update public.integration_sources set status = 'inactive' where external_id = :'src_a_web';
select pg_temp.login_service();
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'evt-inactive', '{"contact_name":"x"}')$$, :'src_a_web'), '55000', null, 'inactive integration source rejected');
select pg_temp.logout();
update public.integration_sources set status = 'active' where external_id = :'src_a_web';

update public.businesses set status = 'suspended' where id = :'biz_a';
select pg_temp.login_service();
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'evt-suspended', '{"contact_name":"x"}')$$, :'src_a_web'), '55000', null, 'suspended business rejected');
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'evt-suspended-v', '{"call_id":"evt-suspended-v","is_lead":false}')$$, :'src_a_vapi'), '55000', null, 'suspended business rejects even filtered calls (no event written)');
select pg_temp.logout();
update public.businesses set status = 'archived' where id = :'biz_a';
select pg_temp.login_service();
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'evt-archived', '{"contact_name":"x"}')$$, :'src_a_web'), '55000', null, 'archived business rejected');
select pg_temp.logout();
update public.businesses set status = 'active' where id = :'biz_a';
select is((select count(*) from public.leads where source_event_id like 'evt-%'), 0::bigint, 'no lead was created by any rejected attempt');
select is((select count(*) from public.ingestion_events where source_event_id like 'evt-%'), 0::bigint, 'no event was written by any rejected attempt');

-- ---- visibility through existing RLS ----------------------------------------------------------
select pg_temp.login_as(:'a_staff');
select is((select count(*) from public.leads where source_event_id = 'shared-evt-1'), 2::bigint, 'Business A staff sees its two ingested leads');
select is((select count(*) from public.leads where business_id = :'biz_b' and source_event_id = 'shared-evt-1'), 0::bigint, 'Business A staff cannot see the Business B ingested lead');
select is((select count(*) from public.ingestion_events), 0::bigint, 'Business A staff sees no operational events');
select pg_temp.logout();

select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.leads where source_event_id = 'shared-evt-1'), 1::bigint, 'Business B owner sees only its own ingested lead');
select is((select contact_name from public.leads where source_event_id = 'shared-evt-1'), 'Via B source', 'and it is the one routed through the B source');
select pg_temp.logout();

select pg_temp.login_service();
select lives_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'admin-vis-filtered', '{"call_id":"admin-vis-filtered","is_lead":false,"call_classification":"uncertain"}')$$, :'src_a_vapi'), 'setup: one filtered event');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select is((select count(*) from public.ingestion_events where source_event_id in ('shared-evt-1', 'admin-vis-filtered')), 4::bigint, 'platform admin sees events across both businesses incl. the filtered one');
select is((select count(distinct business_id) from public.ingestion_events), 2::bigint, 'platform admin operational visibility spans both businesses');
select is((select count(*) from public.leads where source_event_id = 'shared-evt-1'), 3::bigint, 'platform admin sees all three ingested leads');
select pg_temp.logout();

select * from finish();
rollback;
