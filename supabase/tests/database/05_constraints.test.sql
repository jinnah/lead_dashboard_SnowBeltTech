-- Data-integrity constraints and triggers, exercised as postgres (bypassrls)
-- so the checks themselves — not RLS or grants — are what reject the rows.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(18);

-- ---- replay protection / identity uniqueness ----------------------------------------
select throws_ok(
  format($$insert into public.leads (business_id, lead_number, source, source_event_id)
           values (%L, 'INQ-DUP-1', 'website_form', 'form-submission-a-0001')$$, :'biz_a'),
  '23505', null, 'duplicate (business_id, source, source_event_id) is rejected');
select lives_ok(
  format($$insert into public.leads (business_id, lead_number, source, source_event_id)
           values (%L, 'INQ-DUP-2', 'website_form', 'form-submission-a-0001')$$, :'biz_b'),
  'the same source event id in a DIFFERENT business is a different lead');
select lives_ok(
  format($$insert into public.leads (business_id, lead_number, source, source_event_id)
           values (%L, 'INQ-DUP-3', 'manual', null), (%L, 'INQ-DUP-4', 'manual', null)$$, :'biz_a', :'biz_a'),
  'leads without a source event id do not collide with each other');
select throws_ok(
  format($$insert into public.leads (business_id, lead_number, source) values (%L, 'INQ-2026-0001', 'manual')$$, :'biz_a'),
  '23505', null, 'duplicate (business_id, lead_number) is rejected');
select lives_ok(
  format($$insert into public.leads (business_id, lead_number, source) values (%L, 'INQ-2026-0003', 'manual')$$, :'biz_b'),
  'the same lead_number in a different business is allowed');

-- ---- voice identity: full call id IS the idempotency key ------------------------------------
select throws_ok(
  format($$insert into public.leads (business_id, lead_number, source, source_event_id, call_id)
           values (%L, 'INQ-V-1', 'voice_call', 'evt-1', null)$$, :'biz_a'),
  '23514', null, 'a voice lead without call_id is rejected');
select throws_ok(
  format($$insert into public.leads (business_id, lead_number, source, source_event_id, call_id)
           values (%L, 'INQ-V-2', 'voice_call', 'ABC123', 'full-call-id-ending-in-ABC123')$$, :'biz_a'),
  '23514', null, 'a voice lead whose source_event_id is a truncated call id is rejected');
select lives_ok(
  format($$insert into public.leads (business_id, lead_number, source, source_event_id, call_id)
           values (%L, 'INQ-V-3', 'voice_call', 'full-call-id-0003', 'full-call-id-0003')$$, :'biz_a'),
  'a voice lead whose source_event_id equals the full call id is accepted');

-- ---- consent evidence --------------------------------------------------------------------------
select throws_ok(
  format($$insert into public.leads (business_id, lead_number, source, sms_consent) values (%L, 'INQ-C-1', 'manual', true)$$, :'biz_a'),
  '23514', null, 'sms_consent = true without evidence is rejected');
select throws_ok(
  format($$insert into public.leads (business_id, lead_number, source, sms_consent, sms_consent_text, sms_consent_version, sms_consent_source)
           values (%L, 'INQ-C-2', 'manual', true, 't', 'v1', 'website_form')$$, :'biz_a'),
  '23514', null, 'sms_consent = true without a timestamp is rejected');
select lives_ok(
  format($$insert into public.leads (business_id, lead_number, source, sms_consent, sms_consent_text, sms_consent_version, sms_consent_source, sms_consent_at)
           values (%L, 'INQ-C-3', 'manual', true, 't', 'v1', 'website_form', now())$$, :'biz_a'),
  'sms_consent = true with full evidence is accepted');
select lives_ok(
  format($$insert into public.leads (business_id, lead_number, source, source_event_id, call_id, sms_consent)
           values (%L, 'INQ-C-4', 'voice_call', 'call-c4', 'call-c4', false)$$, :'biz_a'),
  'a voice lead with sms_consent = false and no evidence is valid');

-- ---- assignment integrity (trigger) --------------------------------------------------------
select throws_ok(
  format($$update public.leads set assigned_to = %L where id = %L$$, :'b_owner', :'lead_a1'),
  '23514', null, 'assigning a Business A lead to a Business B member is rejected');
select throws_ok(
  format($$update public.leads set assigned_to = %L where id = %L$$, :'a_former', :'lead_a1'),
  '23514', null, 'assigning to an INACTIVE member of the same business is rejected');
select lives_ok(
  format($$update public.leads set assigned_to = %L where id = %L$$, :'a_staff', :'lead_a1'),
  'assigning to an active member of the same business is accepted');
select throws_ok(
  format($$insert into public.leads (business_id, lead_number, source, assigned_to) values (%L, 'INQ-AS-1', 'manual', %L)$$, :'biz_b', :'a_owner'),
  '23514', null, 'inserting a lead pre-assigned to a cross-business user is rejected');

-- ---- other bounded values ---------------------------------------------------------------------------
select throws_ok(
  $$insert into public.businesses (name, slug, industry) values ('Mixed', 'Mixed-Case', 'hvac')$$,
  '23514', null, 'mixed-case slug is rejected');
select throws_ok(
  format($$insert into public.integration_sources (business_id, kind, external_id) values (%L, 'website_form', 'site-alpha-synthetic')$$, :'biz_b'),
  '23505', null, 'the same (kind, external_id) cannot resolve to a second business');

select * from finish();
rollback;
