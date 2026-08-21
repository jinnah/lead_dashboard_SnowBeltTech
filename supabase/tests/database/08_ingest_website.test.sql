-- Website ingestion through the privileged RPC, executed as service_role.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(39);

select pg_temp.login_service();
select is(current_user, 'service_role', 'running as service_role');

-- ---- a valid website event ---------------------------------------------------------------
create temp table r1 as
select * from public.ingest_lead_event('website_form', :'src_a_web', 'form-sub-0001-stable', $j${
  "contact_name": " Test Web Contact ",
  "email": "Web.Contact@Example.INVALID",
  "phone_e164": "+15550100077",
  "phone_raw": "(555) 010-0077",
  "requested_service": "Website redesign",
  "details": "Synthetic details.",
  "preferred_contact_method": "text",
  "email_marketing_consent": true,
  "sms_consent": true,
  "sms_consent_text": "Synthetic consent text v2.",
  "sms_consent_version": "test-v2",
  "sms_consent_source": "website_form",
  "sms_consent_at": "2026-08-21T10:00:00Z",
  "custom_fields": {"business_name": "Contact Co (synthetic)", "business_type": "Landscaping"}
}$j$::jsonb);
select is((select outcome from r1), 'lead_created', 'outcome is lead_created');
select is((select should_notify from r1), true, 'should_notify is true for a new lead');
select is((select customer_sms_allowed from r1), true, 'customer SMS allowed: consent + valid phone');
select is((select business_id from r1), :'biz_a'::uuid, 'business resolved from the registered source, not the payload');
select is((select attempt_count from r1), 1, 'first attempt');
select is((select count(*) from public.leads where source_event_id = 'form-sub-0001-stable'), 1::bigint, 'exactly one lead created');
select is((select lead_number from public.leads where id = (select lead_id from r1)), 'INQ-2026-0004', 'lead number continues after the seeded INQ-2026-0003');
select is((select lead_number from r1), (select lead_number from public.leads where id = (select lead_id from r1)), 'returned lead number matches the row');
select is((select source_event_id from public.leads where id = (select lead_id from r1)), 'form-sub-0001-stable', 'source event id preserved unchanged');
select is((select source from public.leads where id = (select lead_id from r1)), 'website_form', 'lead source is website_form');
select is((select status from public.leads where id = (select lead_id from r1)), 'new', 'status starts as new');
select is((select contact_name || '|' || email || '|' || phone_e164 || '|' || phone_raw from public.leads where id = (select lead_id from r1)),
  'Test Web Contact|web.contact@example.invalid|+15550100077|(555) 010-0077', 'contact fields trimmed/normalized and mapped');
select is((select requested_service || '|' || details || '|' || preferred_contact_method from public.leads where id = (select lead_id from r1)),
  'Website redesign|Synthetic details.|text', 'request fields mapped');
select is((select custom_fields from public.leads where id = (select lead_id from r1)),
  '{"business_name": "Contact Co (synthetic)", "business_type": "Landscaping"}'::jsonb, 'source-specific fields preserved in custom_fields');
select is((select email_marketing_consent from public.leads where id = (select lead_id from r1)), true, 'email marketing consent preserved');
select is((select sms_consent from public.leads where id = (select lead_id from r1)), true, 'sms consent preserved');
select is((select sms_consent_text || '|' || sms_consent_version || '|' || sms_consent_source || '|' || sms_consent_at::text from public.leads where id = (select lead_id from r1)),
  'Synthetic consent text v2.|test-v2|website_form|2026-08-21 10:00:00+00', 'complete consent evidence retained');
select is((select assigned_to from public.leads where id = (select lead_id from r1)), null, 'no assignment on ingestion');
select is((select outcome || '|' || attempt_count::text from public.ingestion_events where source_event_id = 'form-sub-0001-stable'), 'lead_created|1', 'ingestion event recorded');
select is((select lead_id from public.ingestion_events where source_event_id = 'form-sub-0001-stable'), (select lead_id from r1), 'event links to the lead');

-- ---- exact replay ------------------------------------------------------------------------------
create temp table r2 as
select * from public.ingest_lead_event('website_form', :'src_a_web', 'form-sub-0001-stable', '{"contact_name":"Test Web Contact"}'::jsonb);
select is((select outcome from r2), 'duplicate_lead', 'replay outcome is duplicate_lead');
select is((select should_notify from r2), false, 'replay must not notify');
select is((select customer_sms_allowed from r2), false, 'replay must not allow a customer SMS');
select is((select lead_id from r2), (select lead_id from r1), 'replay returns the existing lead');
select is((select lead_number from r2), (select lead_number from r1), 'replay returns the existing lead number');
select is((select attempt_count from r2), 2, 'attempt count incremented');
select is((select count(*) from public.leads where source_event_id = 'form-sub-0001-stable'), 1::bigint, 'still exactly one lead');

-- ---- replay with modified details does not overwrite ------------------------------------------
select lives_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'form-sub-0001-stable', '{"contact_name":"Attacker Changed","email":"changed@example.invalid","sms_consent":false}')$$, :'src_a_web'), 'modified replay accepted as a duplicate');
select is((select contact_name || '|' || email || '|' || sms_consent::text from public.leads where id = (select lead_id from r1)),
  'Test Web Contact|web.contact@example.invalid|true', 'original lead untouched by the modified replay');
select is((select attempt_count from public.ingestion_events where source_event_id = 'form-sub-0001-stable'), 3, 'attempt count now 3');
select is((select count(*) from public.leads where business_id = :'biz_a'), 4::bigint, 'Business A has exactly one new lead overall');

-- ---- rejections ----------------------------------------------------------------------------------
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, '', '{"contact_name":"x"}')$$, :'src_a_web'), '22023', null, 'empty source_event_id rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, null, '{"contact_name":"x"}')$$, :'src_a_web'), '22023', null, 'null source_event_id rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'form-sub-0002', '{"contact_name":"x","sms_consent":true,"sms_consent_text":"t","sms_consent_version":"v","sms_consent_source":"website_form"}')$$, :'src_a_web'), '22023', null, 'sms_consent without a timestamp rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'form-sub-0003', '{"contact_name":"x","business_id":"%s"}')$$, :'src_a_web', :'biz_b'), '42501', null, 'payload business_id rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'form-sub-0004', '{"contact_name":"x","status":"won"}')$$, :'src_a_web'), '42501', null, 'payload status rejected');
select throws_ok(format($$select * from public.ingest_lead_event('website_form', %L, 'form-sub-0005', '{"contact_name":"x","phone_e164":"5550100099"}')$$, :'src_a_web'), '22023', null, 'non-E.164 phone rejected (never silently accepted)');
select is((select count(*) from public.leads where source_event_id in ('form-sub-0002','form-sub-0003','form-sub-0004','form-sub-0005')), 0::bigint, 'rejected events created no leads');

select pg_temp.logout();
select * from finish();
rollback;
