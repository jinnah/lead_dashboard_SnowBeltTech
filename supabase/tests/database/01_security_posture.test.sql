-- Catalog / security posture: structure, RLS flags, policies, grants, helpers.
-- Runs as the test session role (postgres); it inspects the catalog, it does
-- not prove isolation (02–04 do that as authenticated/anon).
begin;
create extension if not exists pgtap with schema extensions;
select plan(64);

-- ---- tables exist -----------------------------------------------------------
select has_table('public', 'businesses',           'businesses exists');
select has_table('public', 'profiles',             'profiles exists');
select has_table('public', 'business_memberships', 'business_memberships exists');
select has_table('public', 'integration_sources',  'integration_sources exists');
select has_table('public', 'leads',                'leads exists');

-- ---- RLS enabled AND forced on all five --------------------------------------
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('businesses','profiles','business_memberships','integration_sources','leads')
     and c.relrowsecurity and c.relforcerowsecurity),
  5::bigint, 'RLS is enabled and forced on all five tenancy tables');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.businesses'::regclass),           'businesses: RLS enabled+forced');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.profiles'::regclass),             'profiles: RLS enabled+forced');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.business_memberships'::regclass), 'business_memberships: RLS enabled+forced');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.integration_sources'::regclass),  'integration_sources: RLS enabled+forced');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.leads'::regclass),                'leads: RLS enabled+forced');

-- ---- policy shape -----------------------------------------------------------
select is((select count(*) from pg_policies where schemaname = 'public' and cmd = 'DELETE'), 0::bigint,
  'no DELETE policy exists on any public table');
select is((select count(*) from pg_policies where schemaname = 'public' and cmd = 'INSERT'), 0::bigint,
  'no INSERT policy exists on any public table (Batch 1)');
select is((select count(*) from pg_policies where schemaname = 'public' and cmd = 'ALL'), 0::bigint,
  'no FOR ALL policy exists (would imply delete)');
select is((select count(*) from pg_policies where schemaname = 'public' and cmd = 'UPDATE' and (with_check is null or qual is null)), 0::bigint,
  'every UPDATE policy has both USING and WITH CHECK');
select is((select count(*) from pg_policies where schemaname = 'public' and 'anon' = any(roles)), 0::bigint,
  'no policy grants anything to anon');
select is((select count(*) from pg_policies where schemaname = 'public' and roles = '{public}'), 0::bigint,
  'no policy is addressed to PUBLIC');
select is((select count(*) from pg_policies where schemaname = 'public'), 12::bigint,
  'exactly the 12 expected policies exist (7 Batch 1 + ingestion_events + lead_activities + platform_admin_events + customer_invitations + customer_access_events select)');

-- ---- anon has no privileges at all ----------------------------------------
select is((select bool_or(has_table_privilege('anon', t, p))
           from unnest(array['public.businesses','public.profiles','public.business_memberships','public.integration_sources','public.leads']) t
           cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p),
  false, 'anon holds no table-level privilege on any tenancy table');
select is((select bool_or(has_any_column_privilege('anon', t, p))
           from unnest(array['public.businesses','public.profiles','public.business_memberships','public.integration_sources','public.leads']) t
           cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p),
  false, 'anon holds no column-level privilege on any tenancy table');
select is(has_schema_privilege('anon', 'private', 'USAGE'), false, 'anon has no USAGE on schema private');
select is(has_function_privilege('anon', 'private.active_business_ids()', 'EXECUTE'), false, 'anon cannot execute active_business_ids');
select is(has_function_privilege('anon', 'private.is_platform_admin()', 'EXECUTE'), false, 'anon cannot execute is_platform_admin');

-- ---- authenticated: least privilege ----------------------------------------
select is((select bool_or(has_table_privilege('authenticated', t, p))
           from unnest(array['public.businesses','public.profiles','public.business_memberships','public.integration_sources','public.leads']) t
           cross join unnest(array['INSERT','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p),
  false, 'authenticated has no INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER on any tenancy table');
select is((select bool_or(has_any_column_privilege('authenticated', t, 'INSERT'))
           from unnest(array['public.businesses','public.profiles','public.business_memberships','public.integration_sources','public.leads']) t),
  false, 'authenticated has no column-level INSERT anywhere');
select is(has_table_privilege('authenticated', 'public.leads', 'UPDATE'), false, 'authenticated has no table-wide UPDATE on leads');
select is(has_column_privilege('authenticated', 'public.leads', 'status',       'UPDATE'), true,  'authenticated may update leads.status');
select is(has_column_privilege('authenticated', 'public.leads', 'follow_up_at', 'UPDATE'), true,  'authenticated may update leads.follow_up_at');
select is((select bool_or(has_column_privilege('authenticated', 'public.leads', c, 'UPDATE'))
           from unnest(array['id','business_id','lead_number','source','source_event_id','contact_name','email','phone_e164','phone_raw',
                             'service_address','requested_service','details','urgency','preferred_contact_method','preferred_callback_at',
                             'custom_fields','assigned_to','archived_at','email_marketing_consent','sms_consent','sms_consent_text',
                             'sms_consent_version','sms_consent_source','sms_consent_at','call_id','caller_phone','call_classification',
                             'call_summary','review_recommended','review_reason','ended_reason','created_at','updated_at']) c),
  false, 'authenticated cannot update any system-managed lead column');
select is(has_table_privilege('authenticated', 'public.profiles', 'UPDATE'), false, 'authenticated has no table-wide UPDATE on profiles');
select is(has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE'), true, 'authenticated may update profiles.display_name');
select is((select bool_or(has_column_privilege('authenticated', 'public.profiles', c, 'UPDATE'))
           from unnest(array['id','platform_role','is_active','created_at','updated_at']) c),
  false, 'authenticated cannot update profiles.platform_role / is_active / id / timestamps');
select is((select bool_or(has_table_privilege('authenticated', t, 'UPDATE') or has_any_column_privilege('authenticated', t, 'UPDATE'))
           from unnest(array['public.businesses','public.business_memberships','public.integration_sources']) t),
  false, 'authenticated cannot update businesses, memberships or integration_sources at all');
select is(has_table_privilege('authenticated', 'public.leads', 'SELECT'), true, 'authenticated may select leads (rows limited by RLS)');
select is(has_table_privilege('service_role', 'public.leads', 'SELECT'), true, 'service_role retains access (bypasses RLS by design)');

-- ---- helper functions -------------------------------------------------------
select has_function('private', 'active_business_ids', 'private.active_business_ids exists');
select has_function('private', 'is_platform_admin',   'private.is_platform_admin exists');
select is((select prosecdef from pg_proc where oid = 'private.active_business_ids()'::regprocedure), true, 'active_business_ids is SECURITY DEFINER');
select is((select prosecdef from pg_proc where oid = 'private.is_platform_admin()'::regprocedure),   true, 'is_platform_admin is SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'private.active_business_ids()'::regprocedure), 'active_business_ids has an empty fixed search_path');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'private.is_platform_admin()'::regprocedure),   'is_platform_admin has an empty fixed search_path');
select is((select pronargs from pg_proc where oid = 'private.active_business_ids()'::regprocedure), 0::smallint, 'active_business_ids takes no caller-supplied user id');
select is((select pronargs from pg_proc where oid = 'private.is_platform_admin()'::regprocedure),   0::smallint, 'is_platform_admin takes no caller-supplied user id');
select is((select rolbypassrls from pg_roles where oid = (select proowner from pg_proc where oid = 'private.active_business_ids()'::regprocedure)), true,
  'helper owner bypasses RLS (prevents policy recursion through memberships)');
select is(has_function_privilege('authenticated', 'private.active_business_ids()', 'EXECUTE'), true, 'authenticated may execute active_business_ids');
select is(has_function_privilege('authenticated', 'private.is_platform_admin()', 'EXECUTE'),   true, 'authenticated may execute is_platform_admin');
select is(has_function_privilege('public', 'private.active_business_ids()', 'EXECUTE'), false, 'PUBLIC cannot execute active_business_ids');
select is(has_function_privilege('public', 'private.is_platform_admin()', 'EXECUTE'),   false, 'PUBLIC cannot execute is_platform_admin');
select is((select bool_or(prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname in ('set_updated_at','protect_row_identity','protect_system_fields')),
  false, 'ordinary trigger functions are not SECURITY DEFINER');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private'
             and not exists (select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))), 0::bigint,
  'every private function pins an empty search_path');
select set_eq('select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $$public$$',
  array['ingest_lead_event', 'add_lead_note', 'set_lead_assignee', 'admin_create_business', 'admin_set_business_status', 'admin_create_integration_source', 'admin_set_integration_source_status',
  'admin_prepare_customer_invitation', 'admin_mark_customer_invitation_sent', 'admin_mark_customer_invitation_failed', 'admin_revoke_customer_invitation', 'accept_customer_invitation', 'admin_set_business_member_role', 'admin_set_business_member_status'],
  'the exposed public schema holds exactly the fourteen reviewed RPCs');

-- ---- defensive triggers present ----------------------------------------------
select has_trigger('public', 'leads',                'trg_z_leads_protect_identity',                'leads identity trigger');
select has_trigger('public', 'leads',                'trg_z_leads_protect_system_fields',           'leads system-field trigger');
select has_trigger('public', 'leads',                'trg_leads_enforce_assignee',                  'leads assignee trigger');
select has_trigger('public', 'profiles',             'trg_z_profiles_protect_system_fields',        'profiles system-field trigger');
select has_trigger('public', 'profiles',             'trg_z_profiles_protect_identity',             'profiles identity trigger');
select has_trigger('public', 'businesses',           'trg_z_businesses_protect_identity',           'businesses identity trigger');
select has_trigger('public', 'business_memberships', 'trg_z_business_memberships_protect_identity', 'memberships identity trigger');
select has_trigger('public', 'integration_sources',  'trg_z_integration_sources_protect_identity',  'integration_sources identity trigger');

-- ---- key constraints and indexes -------------------------------------------
select col_is_unique('public', 'leads', array['business_id', 'lead_number'], 'unique (business_id, lead_number)');
select has_index('public', 'leads', 'uq_leads_business_source_event', 'replay-protection index exists');
select ok((select indisunique from pg_index where indexrelid = 'public.uq_leads_business_source_event'::regclass), 'replay-protection index is unique');
select col_is_unique('public', 'integration_sources', array['kind', 'external_id'], 'unique (kind, external_id) on integration_sources');
select col_is_unique('public', 'business_memberships', array['business_id', 'user_id'], 'unique (business_id, user_id) on memberships');

select * from finish();
rollback;
