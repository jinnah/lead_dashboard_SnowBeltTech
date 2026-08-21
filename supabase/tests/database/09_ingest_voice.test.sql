-- Voice ingestion: complete Vapi call id, legitimate-lead filter, filtered
-- audit events, unsupported voice SMS consent. Executed as service_role.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(32);

select pg_temp.login_service();
\set call1 'vapi-call-0123456789abcdef-0123456789abcdef-full-length-id-0001'

-- ---- legitimate voice lead -----------------------------------------------------------------
create temp table v1 as
select * from public.ingest_lead_event('vapi_assistant', :'src_a_vapi', :'call1', $j${
  "call_id": "vapi-call-0123456789abcdef-0123456789abcdef-full-length-id-0001",
  "caller_phone": "+15550100088",
  "phone_e164": "+15550100089",
  "contact_name": "Voice Caller",
  "requested_service": "Boiler repair",
  "details": "Synthetic inquiry details from the call.",
  "urgency": "urgent",
  "preferred_contact_method": "phone",
  "is_lead": true,
  "call_classification": "legitimate_lead",
  "call_summary": "Synthetic summary.",
  "review_recommended": true,
  "review_reason": "Callback number not confirmed.",
  "ended_reason": "customer-ended-call",
  "sms_consent": false
}$j$::jsonb);
select is((select outcome from v1), 'lead_created', 'legitimate voice call creates a lead');
select is((select should_notify from v1), true, 'new voice lead is notification-eligible');
select is((select customer_sms_allowed from v1), false, 'no customer SMS for voice (no consent model)');
select is((select count(*) from public.leads where source_event_id = :'call1'), 1::bigint, 'exactly one voice lead');
select is((select source from public.leads where id = (select lead_id from v1)), 'voice_call', 'lead source is voice_call');
select is((select call_id from public.leads where id = (select lead_id from v1)), :'call1', 'complete call id retained, untruncated');
select is((select source_event_id from public.leads where id = (select lead_id from v1)), :'call1', 'source_event_id equals the complete call id');
select is((select length(call_id) from public.leads where id = (select lead_id from v1)), 63, 'call id length preserved (63 chars)');
select is((select caller_phone || '|' || phone_e164 from public.leads where id = (select lead_id from v1)), '+15550100088|+15550100089', 'caller phone and confirmed callback phone preserved');
select is((select call_classification || '|' || call_summary || '|' || review_recommended::text || '|' || review_reason || '|' || ended_reason from public.leads where id = (select lead_id from v1)),
  'legitimate_lead|Synthetic summary.|true|Callback number not confirmed.|customer-ended-call', 'voice metadata preserved');
select is((select urgency || '|' || preferred_contact_method || '|' || requested_service from public.leads where id = (select lead_id from v1)), 'urgent|phone|Boiler repair', 'request fields preserved');
select is((select sms_consent from public.leads where id = (select lead_id from v1)), false, 'voice sms_consent defaults to false');
select is((select sms_consent_text is null and sms_consent_at is null from public.leads where id = (select lead_id from v1)), true, 'no fabricated consent evidence');
select is((select metadata from public.ingestion_events where source_event_id = :'call1'), '{"call_classification": "legitimate_lead"}'::jsonb, 'lead event carries minimal metadata only');

-- ---- replay of the voice call --------------------------------------------------------------------
create temp table v2 as
select * from public.ingest_lead_event('vapi_assistant', :'src_a_vapi', :'call1', '{"call_id":"vapi-call-0123456789abcdef-0123456789abcdef-full-length-id-0001","is_lead":true,"call_classification":"legitimate_lead"}'::jsonb);
select is((select outcome || '|' || should_notify::text from v2), 'duplicate_lead|false', 'voice replay is a non-notifying duplicate');
select is((select count(*) from public.leads where source_event_id = :'call1'), 1::bigint, 'still one voice lead');

-- ---- rejections -------------------------------------------------------------------------------------
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'vapi-call-full-0002', '{"call_id":"full-0002","is_lead":true,"call_classification":"legitimate_lead"}')$$, :'src_a_vapi'),
  '22023', null, 'call_id that is a truncated/mismatched version of the event id is rejected');
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'vapi-call-full-0003', '{"is_lead":true,"call_classification":"legitimate_lead"}')$$, :'src_a_vapi'),
  '22023', null, 'missing call_id is rejected');
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'vapi-call-full-0004', '{"call_id":"vapi-call-full-0004","is_lead":true,"call_classification":"legitimate_lead","sms_consent":true,"sms_consent_text":"t","sms_consent_version":"v","sms_consent_source":"voice_call","sms_consent_at":"2026-08-21T00:00:00Z"}')$$, :'src_a_vapi'),
  '0A000', null, 'asserting voice SMS consent is rejected (unsupported)');
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'vapi-call-full-0005', '{"call_id":"vapi-call-full-0005","is_lead":true,"call_classification":"legitimate_lead","sms_consent_text":"t"}')$$, :'src_a_vapi'),
  '0A000', null, 'voice consent evidence without the flag is also rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'form-with-voice-fields', '{"contact_name":"x","call_id":"abc"}')$$, :'src_a_web'),
  '22023', null, 'voice fields on a website event are rejected');
select is((select count(*) from public.leads where source_event_id like 'vapi-call-full-000%'), 0::bigint, 'rejected voice events created no leads');
select is((select count(*) from public.ingestion_events where source_event_id like 'vapi-call-full-000%'), 0::bigint, 'rejected voice events created no ingestion events');

-- ---- filtered calls: audit event, no lead, no notification -----------------------------------------
create temp table f1 as
select * from public.ingest_lead_event('vapi_assistant', :'src_a_vapi', 'vapi-call-filtered-0001', '{"call_id":"vapi-call-filtered-0001","is_lead":false,"call_classification":"uncertain","review_recommended":true,"review_reason":"Hung up early.","ended_reason":"customer-ended-call","caller_phone":"+15550100090","contact_name":"Should Not Persist"}'::jsonb);
select is((select outcome || '|' || should_notify::text || '|' || customer_sms_allowed::text from f1), 'filtered|false|false', 'non-lead call is filtered, never notifies');
select is((select lead_id is null and lead_number is null from f1), true, 'filtered result carries no lead');
select is((select count(*) from public.leads where source_event_id = 'vapi-call-filtered-0001'), 0::bigint, 'filtered call created no lead');
select is((select outcome || '|' || (metadata ->> 'filter_reason') || '|' || (metadata ->> 'call_classification') || '|' || (metadata ->> 'review_reason') from public.ingestion_events where source_event_id = 'vapi-call-filtered-0001'),
  'filtered|not_a_lead|uncertain|Hung up early.', 'filtered event is auditable with sanitized metadata');
select is((select metadata ? 'contact_name' or metadata ? 'caller_phone' from public.ingestion_events where source_event_id = 'vapi-call-filtered-0001'), false, 'filtered event stores no customer identity');

create temp table f2 as
select * from public.ingest_lead_event('vapi_assistant', :'src_a_vapi', 'vapi-call-filtered-0002', '{"call_id":"vapi-call-filtered-0002","is_lead":true,"call_classification":"spam"}'::jsonb);
select is((select outcome from f2) || '|' || (select metadata ->> 'filter_reason' from public.ingestion_events where source_event_id = 'vapi-call-filtered-0002'), 'filtered|classification_not_legitimate', 'is_lead but non-legitimate classification is filtered');

create temp table f3 as
select * from public.ingest_lead_event('vapi_assistant', :'src_a_vapi', 'vapi-call-filtered-0001', '{"call_id":"vapi-call-filtered-0001","is_lead":false,"call_classification":"uncertain"}'::jsonb);
select is((select outcome || '|' || should_notify::text || '|' || attempt_count::text from f3), 'duplicate_filtered|false|2', 'replayed filtered call is a duplicate with attempt 2');
select is((select count(*) from public.ingestion_events where source_event_id = 'vapi-call-filtered-0001'), 1::bigint, 'replay did not create a second event');
select is((select count(*) from public.leads where source_event_id like 'vapi-call-filtered-%'), 0::bigint, 'filtered replays never create leads');

select pg_temp.logout();
select * from finish();
rollback;
