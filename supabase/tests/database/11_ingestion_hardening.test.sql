-- Batch 2A corrective proofs: filtered-metadata allow-list, lead numbers past
-- 9999, unambiguous timestamps, exact event identity, vapi_phone_number routing.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(49);

-- =====================================================================================
-- F1: filtered metadata is an explicit allow-list; no free text, no contact data
-- =====================================================================================
select pg_temp.login_service();
select lives_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'f1-filtered-full', '{"call_id":"f1-filtered-full","is_lead":false,"call_classification":"uncertain","review_recommended":true,"review_reason":"Caller said their name is Someone and number +15550109999","ended_reason":"customer-ended-call","caller_phone":"+15550100091","phone_e164":"+15550100092","contact_name":"Should Not Persist","email":"no@example.invalid","call_summary":"Long summary.","details":"Inquiry details.","custom_fields":{"note":"x"}}')$$, :'src_a_vapi'),
  'setup: filtered call with every free-text field populated');
select set_eq(
  $$select jsonb_object_keys(metadata) from public.ingestion_events where source_event_id = 'f1-filtered-full'$$,
  array['filter_reason', 'is_lead', 'call_classification', 'review_recommended', 'ended_reason'],
  'filtered metadata contains EXACTLY the allow-listed keys');
select is((select metadata from public.ingestion_events where source_event_id = 'f1-filtered-full'),
  '{"filter_reason":"not_a_lead","is_lead":false,"call_classification":"uncertain","review_recommended":true,"ended_reason":"customer-ended-call"}'::jsonb,
  'filtered metadata values are the bounded machine-readable facts only');
select is((select length(metadata::text) < 200 from public.ingestion_events where source_event_id = 'f1-filtered-full'), true, 'filtered metadata is small');
select lives_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'f1-filtered-min', '{"call_id":"f1-filtered-min","is_lead":true,"call_classification":"spam"}')$$, :'src_a_vapi'), 'setup: minimal filtered call');
select set_eq(
  $$select jsonb_object_keys(metadata) from public.ingestion_events where source_event_id = 'f1-filtered-min'$$,
  array['filter_reason', 'is_lead', 'call_classification', 'review_recommended'],
  'absent optional values are simply omitted (never null-padded)');
select is((select count(*) from public.ingestion_events where outcome = 'filtered' and metadata ? 'review_reason'), 0::bigint, 'no filtered event carries review_reason');
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'f1-bad-ended', '{"call_id":"f1-bad-ended","is_lead":false,"call_classification":"uncertain","ended_reason":"Caller hung up after giving phone 555 0100"}')$$, :'src_a_vapi'),
  '22023', null, 'free-text ended_reason is rejected (must be a machine-readable code)');
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'f1-bad-class', '{"call_id":"f1-bad-class","is_lead":false,"call_classification":"Not A Lead, see notes"}')$$, :'src_a_vapi'),
  '22023', null, 'free-text call_classification is rejected');
select is((select count(*) from public.ingestion_events where source_event_id like 'f1-bad-%'), 0::bigint, 'rejected calls wrote no event');
-- accepted voice leads keep review_reason on the tenant-protected lead row
select lives_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, 'f1-lead', '{"call_id":"f1-lead","is_lead":true,"call_classification":"legitimate_lead","review_recommended":true,"review_reason":"Callback number unconfirmed.","ended_reason":"assistant-ended-call"}')$$, :'src_a_vapi'), 'setup: accepted voice lead');
select is((select review_reason from public.leads where source_event_id = 'f1-lead'), 'Callback number unconfirmed.', 'accepted lead retains review_reason on the lead row');
select is((select metadata from public.ingestion_events where source_event_id = 'f1-lead'), '{"call_classification":"legitimate_lead"}'::jsonb, 'lead-created event metadata stays minimal');
select pg_temp.logout();

-- =====================================================================================
-- F2: lead numbers at the 9999 -> 10000 boundary (Business B, its local year)
-- =====================================================================================
\set yr_b '(extract(year from (now() at time zone (select timezone from public.businesses where id = ' :'biz_b' ')))::int)'
insert into public.lead_number_counters (business_id, year, last_value) values (:'biz_b', :yr_b, 9999);
select is((select last_value from public.lead_number_counters where business_id = :'biz_b'), 9999, 'setup: Business B counter placed at 9999');
select pg_temp.login_service();
create temp table n1 as select * from public.ingest_lead_event('website_form', :'src_b_web', 'f2-boundary-1', '{"contact_name":"Boundary One"}'::jsonb);
create temp table n2 as select * from public.ingest_lead_event('website_form', :'src_b_web', 'f2-boundary-2', '{"contact_name":"Boundary Two"}'::jsonb);
select pg_temp.logout();
select is((select lead_number from n1), 'INQ-' || :yr_b || '-10000', 'counter 9999 -> next number ends in 10000 (not truncated)');
select is((select lead_number from n2), 'INQ-' || :yr_b || '-10001', 'following number is 10001');
select is((select outcome from n1) || '|' || (select outcome from n2), 'lead_created|lead_created', 'both boundary events created leads');
select is((select count(*) from public.leads where lead_number in ('INQ-' || :yr_b || '-10000', 'INQ-' || :yr_b || '-10001') and business_id = :'biz_b'), 2::bigint, 'both leads exist with full-width numbers');
select is((select last_value from public.lead_number_counters where business_id = :'biz_b'), 10001, 'counter advanced to 10001');
select is((select lead_number from public.leads where source_event_id = 'f2-boundary-1'), 'INQ-' || :yr_b || '-10000', 'stored number matches the returned number');

-- =====================================================================================
-- F3: external timestamps require an explicit timezone; parser is STABLE
-- =====================================================================================
select is((select provolatile from pg_proc where oid = 'private.payload_timestamptz(jsonb,text)'::regprocedure), 's', 'payload_timestamptz is declared STABLE (not IMMUTABLE)');
select is((select provolatile from pg_proc where oid = 'private.payload_text(jsonb,text,integer)'::regprocedure), 'i', 'pure text accessor remains IMMUTABLE');
select pg_temp.login_service();
select lives_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'f3-z', '{"contact_name":"Z","sms_consent":true,"sms_consent_text":"t","sms_consent_version":"v","sms_consent_source":"website_form","sms_consent_at":"2026-08-21T14:30:00Z","preferred_callback_at":"2026-08-22T09:00:00Z"}')$$, :'src_a_web'), 'Z-suffixed timestamps accepted');
select lives_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'f3-neg', '{"contact_name":"Neg","sms_consent":true,"sms_consent_text":"t","sms_consent_version":"v","sms_consent_source":"website_form","sms_consent_at":"2026-08-21T10:30:00-04:00"}')$$, :'src_a_web'), 'negative-offset timestamp accepted');
select lives_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'f3-pos', '{"contact_name":"Pos","sms_consent":true,"sms_consent_text":"t","sms_consent_version":"v","sms_consent_source":"website_form","sms_consent_at":"2026-08-21T16:30:00+02:00"}')$$, :'src_a_web'), 'positive-offset timestamp accepted');
select is((select count(distinct sms_consent_at) from public.leads where source_event_id in ('f3-z', 'f3-neg', 'f3-pos')), 1::bigint, 'equivalent instants with different offsets store the SAME instant');
select is((select sms_consent_at from public.leads where source_event_id = 'f3-neg'), '2026-08-21T14:30:00Z'::timestamptz, 'stored instant is 14:30Z');
select is((select preferred_callback_at from public.leads where source_event_id = 'f3-z'), '2026-08-22T09:00:00Z'::timestamptz, 'preferred_callback_at goes through the same parser');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'f3-naive', '{"contact_name":"Naive","sms_consent":true,"sms_consent_text":"t","sms_consent_version":"v","sms_consent_source":"website_form","sms_consent_at":"2026-08-21T14:30:00"}')$$, :'src_a_web'),
  '22023', null, 'timestamp without a timezone is rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'f3-naive-cb', '{"contact_name":"Naive","preferred_callback_at":"2026-08-22 09:00"}')$$, :'src_a_web'),
  '22023', null, 'preferred_callback_at without a timezone is rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'f3-invalid', '{"contact_name":"Bad","preferred_callback_at":"2026-13-45T25:61:00Z"}')$$, :'src_a_web'),
  '22023', null, 'invalid calendar/time values are rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'f3-garbage', '{"contact_name":"Bad","preferred_callback_at":"next tuesday"}')$$, :'src_a_web'),
  '22023', null, 'non-ISO text is rejected');
select is((select count(*) from public.leads where source_event_id like 'f3-naive%' or source_event_id in ('f3-invalid', 'f3-garbage')), 0::bigint, 'rejected timestamps created no leads');

-- =====================================================================================
-- F4: source_event_id is preserved byte-for-byte; surrounding whitespace rejected
-- =====================================================================================
\set exact_id 'Evt_ABC-123.xyz:Mixed/Case~'
create temp table e1 as select * from public.ingest_lead_event('website_form', :'src_a_web', :'exact_id', '{"contact_name":"Exact"}'::jsonb);
select is((select source_event_id from public.leads where id = (select lead_id from e1)), :'exact_id', 'event id stored exactly as received (case, symbols)');
select is((select source_event_id from public.ingestion_events where id = (select ingestion_event_id from e1)), :'exact_id', 'ingestion event keeps the exact id too');
select is((select outcome from public.ingest_lead_event('website_form', :'src_a_web', :'exact_id', '{"contact_name":"Exact"}'::jsonb)), 'duplicate_lead', 'exact replay is a duplicate');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, ' f4-leading', '{"contact_name":"x"}')$$, :'src_a_web'), '22023', null, 'leading whitespace rejected, not trimmed');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'f4-trailing ', '{"contact_name":"x"}')$$, :'src_a_web'), '22023', null, 'trailing whitespace rejected, not trimmed');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, %L, '{"contact_name":"x"}')$$, :'src_a_web', repeat('x', 256)), '22023', null, '256-character id rejected');
select lives_ok(format($$select * from public.ingest_lead_event('website_form', %L, %L, '{"contact_name":"x"}')$$, :'src_a_web', repeat('y', 255)), '255-character id accepted');
select is((select count(*) from public.leads where source_event_id in (' f4-leading', 'f4-leading', 'f4-trailing', 'f4-trailing ')), 0::bigint, 'whitespace variants created nothing');
select throws_ok(format($$select * from public.ingest_lead_event('vapi_assistant', %L, ' f4-voice-padded', '{"call_id":" f4-voice-padded","is_lead":true,"call_classification":"legitimate_lead"}')$$, :'src_a_vapi'),
  '22023', null, 'a whitespace-padded voice event id is rejected before any call_id comparison');
select pg_temp.logout();

-- =====================================================================================
-- F5: vapi_phone_number routing (transaction-scoped synthetic source for Business B)
-- =====================================================================================
insert into public.integration_sources (business_id, kind, external_id, label, status)
values (:'biz_b', 'vapi_phone_number', '+15550100500', 'Bravo voice line (synthetic)', 'active');
select pg_temp.login_service();
create temp table p1 as select * from public.ingest_lead_event('vapi_phone_number', '+15550100500', 'vapi-phone-call-full-id-0001', '{"call_id":"vapi-phone-call-full-id-0001","is_lead":true,"call_classification":"legitimate_lead","caller_phone":"+15550100501","contact_name":"Phone Route"}'::jsonb);
select is((select business_id from p1), :'biz_b'::uuid, 'vapi_phone_number source resolves to Business B');
select is((select outcome || '|' || should_notify::text from p1), 'lead_created|true', 'legitimate call via phone-number source creates a notifying lead');
select is((select source || '|' || call_id from public.leads where id = (select lead_id from p1)), 'voice_call|vapi-phone-call-full-id-0001', 'voice_call lead with the complete call id');
select is((select outcome from public.ingest_lead_event('vapi_phone_number', '+15550100500', 'vapi-phone-call-full-id-0001', '{"call_id":"vapi-phone-call-full-id-0001","is_lead":true,"call_classification":"legitimate_lead"}'::jsonb)), 'duplicate_lead', 'duplicate via phone-number source is a duplicate');
select throws_ok($$select * from public.ingest_lead_event('vapi_assistant', '+15550100500', 'vapi-phone-call-full-id-0002', '{"call_id":"vapi-phone-call-full-id-0002","is_lead":true,"call_classification":"legitimate_lead"}')$$,
  'P0002', null, 'the phone number is not resolvable under a different source kind');
select pg_temp.logout();
select pg_temp.login_as(:'a_staff');
select is((select count(*) from public.leads where source_event_id = 'vapi-phone-call-full-id-0001'), 0::bigint, 'Business A staff cannot see the Business B phone-routed lead');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.leads where source_event_id = 'vapi-phone-call-full-id-0001'), 1::bigint, 'Business B owner sees the phone-routed lead');
select pg_temp.logout();

select * from finish();
rollback;
