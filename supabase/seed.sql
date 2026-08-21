-- =============================================================================
-- Deterministic SYNTHETIC seed for local development and database tests.
-- Data only (no schema). Nothing here is a real person, business, phone,
-- address, credential or production identifier. Email domains are reserved
-- (.invalid). Passwords are a throwaway local-only value.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- auth.users (minimal rows GoTrue tolerates; never used to sign in remotely)
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, is_sso_user,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'platform-admin@example.invalid',   extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'owner-a@example.invalid',          extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'manager-a@example.invalid',        extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'staff-a@example.invalid',          extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated',
   'former-staff-a@example.invalid',   extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'owner-b@example.invalid',          extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());

-- ---------------------------------------------------------------------------
-- profiles (platform_role set here by the seed, never from auth metadata)
-- ---------------------------------------------------------------------------
insert into public.profiles (id, display_name, platform_role, is_active) values
  ('10000000-0000-4000-8000-000000000001', 'Platform Admin (synthetic)', 'PLATFORM_ADMIN', true),
  ('a1000000-0000-4000-8000-000000000001', 'Owner A (synthetic)',        null,             true),
  ('a1000000-0000-4000-8000-000000000002', 'Manager A (synthetic)',      null,             true),
  ('a1000000-0000-4000-8000-000000000003', 'Staff A (synthetic)',        null,             true),
  ('a1000000-0000-4000-8000-000000000004', 'Former Staff A (synthetic)', null,             true),
  ('b1000000-0000-4000-8000-000000000001', 'Owner B (synthetic)',        null,             true);

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
insert into public.businesses (id, name, slug, industry, timezone, status) values
  ('a0000000-0000-4000-8000-000000000001', 'Alpha HVAC (synthetic)',      'alpha-hvac',      'hvac',     'America/New_York', 'active'),
  ('b0000000-0000-4000-8000-000000000001', 'Bravo Plumbing (synthetic)',  'bravo-plumbing',  'plumbing', 'America/Chicago',  'active');

-- ---------------------------------------------------------------------------
-- business_memberships (one inactive membership for revocation tests)
-- ---------------------------------------------------------------------------
insert into public.business_memberships (id, business_id, user_id, role, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'BUSINESS_OWNER',   'active'),
  ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'BUSINESS_MANAGER', 'active'),
  ('a2000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'BUSINESS_STAFF',   'active'),
  ('a2000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000004', 'BUSINESS_STAFF',   'inactive'),
  ('b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'BUSINESS_OWNER',   'active');

-- ---------------------------------------------------------------------------
-- integration_sources (synthetic identifiers only)
-- ---------------------------------------------------------------------------
insert into public.integration_sources (id, business_id, kind, external_id, label, allowed_origin, status) values
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'website_form',   'site-alpha-synthetic',      'Alpha website form',   'https://alpha.example.invalid', 'active'),
  ('a3000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'vapi_assistant', 'asst-alpha-synthetic-0001', 'Alpha voice assistant', null,                            'active'),
  ('b3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'website_form',   'site-bravo-synthetic',      'Bravo website form',   'https://bravo.example.invalid', 'active');

-- ---------------------------------------------------------------------------
-- leads (synthetic; phone numbers use the reserved 555-01xx fiction range)
-- ---------------------------------------------------------------------------
insert into public.leads (
  id, business_id, lead_number, source, source_event_id,
  contact_name, email, phone_e164, phone_raw, service_address, requested_service, details,
  urgency, preferred_contact_method, status, assigned_to, follow_up_at,
  email_marketing_consent, sms_consent, sms_consent_text, sms_consent_version, sms_consent_source, sms_consent_at,
  call_id, caller_phone, call_classification, call_summary, review_recommended, review_reason, ended_reason
) values
  -- Business A, web form, assigned to manager, SMS consent with full evidence
  ('aa000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'INQ-2026-0001', 'website_form', 'form-submission-a-0001',
   'Test Contact One', 'contact-one@example.invalid', '+15550100001', '(555) 010-0001', '1 Example Street, Testville', 'Furnace tune-up', 'Synthetic request details.',
   'normal', 'text', 'new', 'a1000000-0000-4000-8000-000000000002', null,
   true, true, 'Synthetic consent text for local tests.', 'test-v1', 'website_form', now(),
   null, null, null, null, false, null, null),
  -- Business A, voice call, unassigned, no SMS consent (voice does not collect it)
  ('aa000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'INQ-2026-0002', 'voice_call', 'synthetic-vapi-call-a-0002-full-id-never-truncated',
   'Test Caller Two', null, '+15550100002', '5550100002', null, 'No heat', 'Synthetic call details.',
   'urgent', 'phone', 'new', null, null,
   false, false, null, null, null, null,
   'synthetic-vapi-call-a-0002-full-id-never-truncated', '+15550100002', 'legitimate_lead', 'Synthetic call summary.', false, null, 'customer-ended-call'),
  -- Business A, manual, with a follow-up date
  ('aa000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'INQ-2026-0003', 'manual', null,
   'Test Contact Three', 'contact-three@example.invalid', null, null, null, 'Duct cleaning', null,
   'normal', 'email', 'contacted', null, now() + interval '2 days',
   false, false, null, null, null, null,
   null, null, null, null, false, null, null),
  -- Business B, web form, assigned to owner B
  ('bb000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'INQ-2026-0001', 'website_form', 'form-submission-b-0001',
   'Test Contact Four', 'contact-four@example.invalid', '+15550100004', '555-010-0004', '4 Example Avenue, Testville', 'Leaking faucet', null,
   'normal', 'phone', 'new', 'b1000000-0000-4000-8000-000000000001', null,
   false, false, null, null, null, null,
   null, null, null, null, false, null, null),
  -- Business B, voice call flagged for review
  ('bb000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'INQ-2026-0002', 'voice_call', 'synthetic-vapi-call-b-0002-full-id-never-truncated',
   'Test Caller Five', null, null, null, null, 'Water heater', null,
   'emergency', 'phone', 'new', null, null,
   false, false, null, null, null, null,
   'synthetic-vapi-call-b-0002-full-id-never-truncated', '+15550100005', 'uncertain', 'Synthetic uncertain call.', true, 'Caller did not confirm callback number.', 'assistant-ended-call');
