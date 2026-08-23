-- Batch 4A: audited platform-administrator operations. Proven as real database
-- personas (authenticated / anon / service); synthetic fixtures; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(166);

-- =====================================================================================
-- posture: the four RPCs
-- =====================================================================================
select has_function('public', 'admin_create_business', array['text', 'text', 'text', 'text'], 'admin_create_business(text,text,text,text) exists');
select has_function('public', 'admin_set_business_status', array['uuid', 'text'], 'admin_set_business_status(uuid,text) exists');
select has_function('public', 'admin_create_integration_source', array['uuid', 'text', 'text', 'text', 'text'], 'admin_create_integration_source(uuid,text,text,text,text) exists');
select has_function('public', 'admin_set_integration_source_status', array['uuid', 'uuid', 'text'], 'admin_set_integration_source_status(uuid,uuid,text) exists');
select is(pg_get_function_result('public.admin_create_business(text,text,text,text)'::regprocedure), 'TABLE(business_id uuid, slug text, status text)', 'create_business return contract');
select is(pg_get_function_result('public.admin_set_business_status(uuid,text)'::regprocedure), 'TABLE(business_id uuid, status text, changed boolean)', 'set_business_status return contract');
select is(pg_get_function_result('public.admin_create_integration_source(uuid,text,text,text,text)'::regprocedure), 'TABLE(source_id uuid, business_id uuid, status text)', 'create_integration_source return contract');
select is(pg_get_function_result('public.admin_set_integration_source_status(uuid,uuid,text)'::regprocedure), 'TABLE(source_id uuid, status text, changed boolean)', 'set_integration_source_status return contract');

create temp table admin_fns (sig text) on commit drop;
insert into admin_fns values
  ('public.admin_create_business(text,text,text,text)'),
  ('public.admin_set_business_status(uuid,text)'),
  ('public.admin_create_integration_source(uuid,text,text,text,text)'),
  ('public.admin_set_integration_source_status(uuid,uuid,text)');
select is((select bool_and((select prosecdef from pg_proc where oid = sig::regprocedure)) from admin_fns), true, 'all four admin RPCs are SECURITY DEFINER');
select is((select bool_and((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = sig::regprocedure)) from admin_fns), true, 'all four admin RPCs pin an empty search_path');
select is((select bool_and((select pg_get_userbyid(proowner) from pg_proc where oid = sig::regprocedure) = 'postgres') from admin_fns), true, 'all four admin RPCs are owned by postgres');
select is((select bool_or(has_function_privilege('anon', sig, 'EXECUTE')) from admin_fns), false, 'anon cannot execute any admin RPC');
select is((select bool_or(has_function_privilege('public', sig, 'EXECUTE')) from admin_fns), false, 'PUBLIC cannot execute any admin RPC');
select is((select bool_and(has_function_privilege('authenticated', sig, 'EXECUTE')) from admin_fns), true, 'authenticated can execute (authorization happens inside)');
select is((select bool_or(has_function_privilege('anon', 'private.platform_admin_actor()', 'EXECUTE') or has_function_privilege('authenticated', 'private.platform_admin_actor()', 'EXECUTE'))), false, 'the private authorization gate is not directly executable by application roles');
select is((select prosecdef from pg_proc where oid = 'private.platform_admin_actor()'::regprocedure), true, 'authorization gate is SECURITY DEFINER with postgres owner');

-- =====================================================================================
-- posture: the ledger and the table write model
-- =====================================================================================
select has_table('public', 'platform_admin_events', 'platform_admin_events exists');
select is((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.platform_admin_events'::regclass), true, 'RLS enabled AND forced on platform_admin_events');
select is((select count(*) from pg_policies where tablename = 'platform_admin_events'), 1::bigint, 'exactly one policy on the ledger');
select is((select cmd || ':' || array_to_string(roles, ',') from pg_policies where tablename = 'platform_admin_events'), 'SELECT:authenticated', 'the ledger policy is SELECT for authenticated only');
select is((select count(*) from pg_policies where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and tablename in ('businesses', 'integration_sources', 'platform_admin_events')), 0::bigint, 'no INSERT/UPDATE/DELETE policy on businesses, integration_sources or the ledger');
select is((select bool_or(has_table_privilege('authenticated', t, p)) from unnest(array['public.businesses', 'public.integration_sources', 'public.platform_admin_events']) t, unnest(array['INSERT', 'UPDATE', 'DELETE']) p), false, 'authenticated holds no direct INSERT/UPDATE/DELETE on businesses, integration_sources or the ledger');
select is((select bool_or(has_table_privilege('anon', t, p)) from unnest(array['public.businesses', 'public.integration_sources', 'public.platform_admin_events']) t, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p), false, 'anon holds nothing on those tables');
select is(has_table_privilege('authenticated', 'public.platform_admin_events', 'SELECT'), true, 'authenticated may SELECT the ledger (rows limited by RLS)');
select has_trigger('public', 'platform_admin_events', 'trg_platform_admin_events_append_only', 'append-only trigger present');
select is((select confdeltype from pg_constraint where conrelid = 'public.platform_admin_events'::regclass and contype = 'f' and conkey = array[(select attnum from pg_attribute where attrelid = 'public.platform_admin_events'::regclass and attname = 'business_id')]), 'r', 'business FK is ON DELETE RESTRICT');
select is((select count(*) from pg_constraint where conrelid = 'public.platform_admin_events'::regclass and contype = 'f' and confrelid = 'public.profiles'::regclass), 0::bigint, 'actor_id has NO foreign key to profiles (history survives account removal)');
select has_index('public', 'platform_admin_events', 'ix_platform_admin_events_business_created', 'business/created index');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and not exists (select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))), 0::bigint, 'every private function still pins an empty search_path');

-- =====================================================================================
-- who is refused (fail closed): anon, customers of every role, foreign tenants, inactive admin
-- =====================================================================================
select pg_temp.login_anon();
select throws_ok($$select * from public.admin_create_business('X', 'x-synthetic', 'hvac', 'UTC')$$, '42501', null, 'anon cannot create a business');
select pg_temp.logout();
select pg_temp.login_as(:'a_owner');
select throws_ok($$select * from public.admin_create_business('Owner Made', 'owner-made', 'hvac', 'UTC')$$, '42501', null, 'business owner cannot create a business');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'suspended')$$, :'biz_a'), '42501', null, 'business owner cannot change their own business status');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'owner-src', null, null)$$, :'biz_a'), '42501', null, 'business owner cannot register a source');
select throws_ok(format($$select * from public.admin_set_integration_source_status(%L, 'a3000000-0000-4000-8000-000000000001', 'inactive')$$, :'biz_a'), '42501', null, 'business owner cannot change a source status');
select pg_temp.logout();
select pg_temp.login_as(:'a_manager');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'suspended')$$, :'biz_a'), '42501', null, 'manager refused');
select pg_temp.logout();
select pg_temp.login_as(:'a_staff');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'suspended')$$, :'biz_a'), '42501', null, 'staff refused');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'suspended')$$, :'biz_a'), '42501', null, 'foreign-tenant owner refused');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'b-on-a', null, null)$$, :'biz_a'), '42501', null, 'foreign-tenant owner cannot register a source on another business');
select pg_temp.logout();
update public.profiles set is_active = false where id = :'admin';
select pg_temp.login_as(:'admin');
select throws_ok($$select * from public.admin_create_business('Inactive Admin', 'inactive-admin', 'hvac', 'UTC')$$, '42501', null, 'deactivated platform administrator refused');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'suspended')$$, :'biz_a'), '42501', null, 'deactivated platform administrator cannot change status');
select pg_temp.logout();
update public.profiles set is_active = true where id = :'admin';
select is((select status from public.businesses where id = :'biz_a'), 'active', 'Business A untouched by refused attempts');
select is((select count(*) from public.platform_admin_events), 0::bigint, 'no ledger rows from refused attempts');

-- =====================================================================================
-- business creation
-- =====================================================================================
select pg_temp.login_as(:'admin');
create temp table cb as select * from public.admin_create_business('  Charlie Roofing (synthetic)  ', 'charlie-roofing', 'roofing', 'America/Denver');
grant select on cb to public;   -- fixture lookup under other personas
select is((select status from cb), 'active', 'created business starts active');
select is((select b.name || '|' || b.slug || '|' || b.industry || '|' || b.timezone || '|' || b.status from public.businesses b where b.id = (select business_id from cb)), 'Charlie Roofing (synthetic)|charlie-roofing|roofing|America/Denver|active', 'business persisted with trimmed name and validated fields');
select is((select e.event_type || '|' || e.actor_id::text || '|' || e.actor_display_name || '|' || coalesce(e.old_value, '-') || '|' || e.new_value || '|' || coalesce(e.integration_source_id::text, '-')
           from public.platform_admin_events e where e.business_id = (select business_id from cb)),
  'business_created|' || :'admin' || '|Platform Admin (synthetic)|-|active|-', 'business_created audited with actor UUID, display-name snapshot and initial status');
select throws_ok($$select * from public.admin_create_business('', 'empty-name', 'hvac', 'UTC')$$, '22023', null, 'empty name rejected');
select throws_ok($$select * from public.admin_create_business('   ', 'blank-name', 'hvac', 'UTC')$$, '22023', null, 'whitespace name rejected');
select throws_ok(format($$select * from public.admin_create_business(%L, 'long-name', 'hvac', 'UTC')$$, repeat('n', 201)), '22023', null, 'name longer than 200 rejected');
select throws_ok($$select * from public.admin_create_business('Bad', 'Bad Slug', 'hvac', 'UTC')$$, '22023', null, 'slug with uppercase/space rejected');
select throws_ok($$select * from public.admin_create_business('Bad', '-leading', 'hvac', 'UTC')$$, '22023', null, 'slug with leading hyphen rejected');
select throws_ok($$select * from public.admin_create_business('Bad', 'trailing-', 'hvac', 'UTC')$$, '22023', null, 'slug with trailing hyphen rejected');
select throws_ok(format($$select * from public.admin_create_business('Bad', %L, 'hvac', 'UTC')$$, repeat('a', 64)), '22023', null, 'slug longer than 63 rejected');
select throws_ok($$select * from public.admin_create_business('Bad', 'alpha-hvac', 'hvac', 'UTC')$$, '23505', null, 'seeded slug cannot be reused');
select throws_ok($$select * from public.admin_create_business('Bad', 'charlie-roofing', 'hvac', 'UTC')$$, '23505', null, 'freshly created slug cannot be reused');
select throws_ok($$select * from public.admin_create_business('Bad', 'bad-industry', 'banking', 'UTC')$$, '22023', null, 'industry outside the schema allow-list rejected');
select throws_ok($$select * from public.admin_create_business('Bad', 'bad-industry-2', 'HVAC', 'UTC')$$, '22023', null, 'industry is case-sensitive (HVAC rejected)');
select throws_ok($$select * from public.admin_create_business('Bad', 'bad-tz', 'hvac', 'Mars/Olympus_Mons')$$, '22023', null, 'pattern-shaped but nonexistent timezone rejected');
select throws_ok($$select * from public.admin_create_business('Bad', 'bad-tz-2', 'hvac', 'America/Not_A_Zone')$$, '22023', null, 'unknown America/* zone rejected');
select throws_ok($$select * from public.admin_create_business('Bad', 'bad-tz-3', 'hvac', 'EST')$$, '22023', null, 'abbreviation rejected (not canonical Area/Location)');
select throws_ok($$select * from public.admin_create_business('Bad', 'bad-tz-4', 'hvac', 'america/denver')$$, '22023', null, 'wrong-case zone name rejected');
select throws_ok($$select * from public.admin_create_business('Bad', 'bad-tz-5', 'hvac', '')$$, '22023', null, 'empty timezone rejected');
select lives_ok($$select * from public.admin_create_business('Delta Cleaning (synthetic)', 'delta-cleaning', 'cleaning', 'UTC')$$, 'UTC accepted');
select lives_ok($$select * from public.admin_create_business('Echo Electric (synthetic)', 'echo-electric', 'electrical', 'Europe/London')$$, 'a real Europe/* zone accepted');
select is((select count(*) from public.businesses), 5::bigint, 'exactly three new businesses (rejected attempts created nothing)');
select is((select count(*) from public.platform_admin_events where event_type = 'business_created'), 3::bigint, 'one business_created row per created business');
select pg_temp.logout();

-- =====================================================================================
-- business lifecycle: active <-> suspended only; archived is not operable; no-ops audit nothing
-- =====================================================================================
select pg_temp.login_as(:'admin');
create temp table s1 as select * from public.admin_set_business_status((select business_id from cb), 'suspended');
select is((select status || '|' || changed::text from s1), 'suspended|true', 'active -> suspended');
select is((select status from public.businesses where id = (select business_id from cb)), 'suspended', 'status persisted');
select is((select old_value || '>' || new_value from public.platform_admin_events where business_id = (select business_id from cb) and event_type = 'business_status_changed'), 'active>suspended', 'status change audited with old/new');
create temp table s2 as select * from public.admin_set_business_status((select business_id from cb), 'suspended');
select is((select changed from s2), false, 'repeating the current status is a no-op');
select is((select count(*) from public.platform_admin_events where business_id = (select business_id from cb)), 2::bigint, 'no duplicate audit row for the no-op');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'archived')$$, (select business_id from cb)), '22023', null, 'archiving is not offered by this RPC');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'bogus')$$, (select business_id from cb)), '22023', null, 'unknown status rejected');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'ACTIVE')$$, (select business_id from cb)), '22023', null, 'status is case-sensitive');
select throws_ok($$select * from public.admin_set_business_status('00000000-0000-4000-8000-00000000dead', 'active')$$, 'P0002', null, 'unknown business rejected');
create temp table s3 as select * from public.admin_set_business_status((select business_id from cb), 'active');
select is((select status || '|' || changed::text from s3), 'active|true', 'suspended -> active');
select is((select count(*) from public.platform_admin_events where business_id = (select business_id from cb) and event_type = 'business_status_changed'), 2::bigint, 'both real transitions audited');
select pg_temp.logout();
update public.businesses set status = 'archived' where id = (select business_id from cb);
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'active')$$, (select business_id from cb)), '55000', null, 'archived business cannot be reactivated here');
select throws_ok(format($$select * from public.admin_set_business_status(%L, 'suspended')$$, (select business_id from cb)), '55000', null, 'archived business cannot be suspended here');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'archived-src', null, null)$$, (select business_id from cb)), '55000', null, 'archived business cannot receive sources');
select pg_temp.logout();
update public.businesses set status = 'active' where id = (select business_id from cb);
select is((select count(*) from public.platform_admin_events where business_id = (select business_id from cb)), 3::bigint, 'rejected archived attempts audited nothing');

-- =====================================================================================
-- dual-role administrator: platform operations allowed, lead assignment still blocked
-- =====================================================================================
insert into public.business_memberships (business_id, user_id, role, status) values (:'biz_a', :'admin', 'BUSINESS_OWNER', 'active');
select pg_temp.login_as(:'admin');
create temp table dr as select * from public.admin_set_business_status(:'biz_a', 'active');
select is((select changed from dr), false, 'administrator with a membership may still operate platform resources');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'administrator with a membership still cannot assign leads');
select pg_temp.logout();
delete from public.business_memberships where user_id = :'admin';

-- =====================================================================================
-- integration-source registration
-- =====================================================================================
select pg_temp.login_as(:'admin');
create temp table cs as select * from public.admin_create_integration_source((select business_id from cb), 'website_form', 'site-charlie-synthetic', '  Charlie website form ', 'https://charlie.example.invalid');
grant select on cs to public;
select is((select status from cs), 'active', 'source starts active');
select is((select s.kind || '|' || s.external_id || '|' || s.label || '|' || s.allowed_origin || '|' || s.status || '|' || (s.business_id = (select business_id from cb))::text from public.integration_sources s where s.id = (select source_id from cs)),
  'website_form|site-charlie-synthetic|Charlie website form|https://charlie.example.invalid|active|true', 'source persisted: exact identifier, trimmed label, canonical origin, correct tenant');
select is((select e.event_type || '|' || e.actor_id::text || '|' || e.actor_display_name || '|' || coalesce(e.old_value, '-') || '|' || e.new_value
           from public.platform_admin_events e where e.integration_source_id = (select source_id from cs)),
  'integration_source_created|' || :'admin' || '|Platform Admin (synthetic)|-|active', 'integration_source_created audited');
-- kinds
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'twilio_number', '+15550100999', null, null)$$, (select business_id from cb)), '22023', null, 'twilio_number is not registrable (not ingestible yet)');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'sms', 'x', null, null)$$, (select business_id from cb)), '22023', null, 'unknown kind rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'Website_Form', 'x', null, null)$$, (select business_id from cb)), '22023', null, 'kind is case-sensitive');
-- identifiers
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', ' padded', null, null)$$, (select business_id from cb)), '22023', null, 'leading whitespace rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'padded ', null, null)$$, (select business_id from cb)), '22023', null, 'trailing whitespace rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', E'tab\t', null, null)$$, (select business_id from cb)), '22023', null, 'trailing tab rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', '', null, null)$$, (select business_id from cb)), '22023', null, 'empty identifier rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', %L, null, null)$$, (select business_id from cb), repeat('x', 256)), '22023', null, 'identifier longer than 255 rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', E'a\nb', null, null)$$, (select business_id from cb)), '22023', null, 'control character inside identifier rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', null, null, null)$$, (select business_id from cb)), '22023', null, 'null identifier rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'label-too-long', %L, null)$$, (select business_id from cb), repeat('l', 101)), '22023', null, 'label longer than 100 rejected');
-- origins
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o1', null, 'http://charlie.example.invalid')$$, (select business_id from cb)), '22023', null, 'http origin rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o2', null, 'https://charlie.example.invalid/')$$, (select business_id from cb)), '22023', null, 'trailing slash rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o3', null, 'https://charlie.example.invalid/path')$$, (select business_id from cb)), '22023', null, 'path rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o4', null, 'https://charlie.example.invalid?q=1')$$, (select business_id from cb)), '22023', null, 'query rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o5', null, 'https://charlie.example.invalid#f')$$, (select business_id from cb)), '22023', null, 'fragment rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o6', null, 'https://user:pw@charlie.example.invalid')$$, (select business_id from cb)), '22023', null, 'credentials rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o7', null, 'https://Charlie.Example.invalid')$$, (select business_id from cb)), '22023', null, 'non-lowercase host rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o8', null, 'https://charlie.example.invalid:443')$$, (select business_id from cb)), '22023', null, 'explicit default port rejected (non-canonical)');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o9', null, 'https://charlie.example.invalid:70000')$$, (select business_id from cb)), '22023', null, 'out-of-range port rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o10', null, ' https://charlie.example.invalid')$$, (select business_id from cb)), '22023', null, 'padded origin rejected');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'vapi_assistant', 'asst-with-origin', null, 'https://charlie.example.invalid')$$, (select business_id from cb)), '22023', null, 'voice source cannot carry a website origin');
select lives_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'o11', null, 'https://charlie.example.invalid:8443')$$, (select business_id from cb)), 'non-default port accepted');
select lives_ok(format($$select * from public.admin_create_integration_source(%L, 'vapi_assistant', 'asst-charlie-synthetic-0001', 'Charlie voice', null)$$, (select business_id from cb)), 'voice assistant source without origin accepted');
select lives_ok(format($$select * from public.admin_create_integration_source(%L, 'vapi_phone_number', '+15550100777', null, null)$$, (select business_id from cb)), 'voice phone-number source accepted');
select lives_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'no-origin-synthetic', null, null)$$, (select business_id from cb)), 'website source without an origin accepted (origin is optional)');
-- uniqueness / tenant protection
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'site-alpha-synthetic', 'hijack', null)$$, (select business_id from cb)), '23505', null, 'another business''s identifier cannot be claimed');
select is((select business_id from public.integration_sources where kind = 'website_form' and external_id = 'site-alpha-synthetic'), :'biz_a'::uuid, 'Business A routing unchanged');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'site-charlie-synthetic', null, null)$$, :'biz_a'), '23505', null, 'Charlie''s identifier cannot be claimed by Business A either');
select lives_ok(format($$select * from public.admin_create_integration_source(%L, 'vapi_assistant', 'site-alpha-synthetic', null, null)$$, (select business_id from cb)), 'same identifier under a different kind is a different source (kind, external_id)');
select throws_ok($$select * from public.admin_create_integration_source('00000000-0000-4000-8000-00000000dead', 'website_form', 'orphan', null, null)$$, 'P0002', null, 'unknown business rejected');
select pg_temp.logout();
update public.businesses set status = 'suspended' where id = (select business_id from cb);
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_create_integration_source(%L, 'website_form', 'while-suspended', null, null)$$, (select business_id from cb)), '55000', null, 'suspended business cannot receive sources');
select pg_temp.logout();
update public.businesses set status = 'active' where id = (select business_id from cb);
select is((select count(*) from public.integration_sources where business_id = (select business_id from cb)), 6::bigint, 'exactly the six accepted sources exist');
select is((select count(*) from public.platform_admin_events where event_type = 'integration_source_created'), 6::bigint, 'one integration_source_created per accepted source');

-- =====================================================================================
-- integration-source lifecycle
-- =====================================================================================
select pg_temp.login_as(:'admin');
create temp table d1 as select * from public.admin_set_integration_source_status((select business_id from cb), (select source_id from cs), 'inactive');
select is((select status || '|' || changed::text from d1), 'inactive|true', 'active -> inactive');
select is((select old_value || '>' || new_value from public.platform_admin_events where integration_source_id = (select source_id from cs) and event_type = 'integration_source_status_changed'), 'active>inactive', 'source status change audited');
create temp table d2 as select * from public.admin_set_integration_source_status((select business_id from cb), (select source_id from cs), 'inactive');
select is((select changed from d2), false, 'repeating the current source status is a no-op');
select is((select count(*) from public.platform_admin_events where integration_source_id = (select source_id from cs)), 2::bigint, 'no duplicate audit row for the source no-op');
select throws_ok(format($$select * from public.admin_set_integration_source_status(%L, %L, 'active')$$, :'biz_a', (select source_id from cs)), 'P0002', null, 'mismatched business/source pair rejected');
select throws_ok(format($$select * from public.admin_set_integration_source_status(%L, 'a3000000-0000-4000-8000-000000000001', 'inactive')$$, (select business_id from cb)), 'P0002', null, 'another business''s source cannot be changed through the wrong business');
select throws_ok(format($$select * from public.admin_set_integration_source_status(%L, '00000000-0000-4000-8000-00000000dead', 'inactive')$$, (select business_id from cb)), 'P0002', null, 'unknown source rejected');
select throws_ok(format($$select * from public.admin_set_integration_source_status(%L, %L, 'archived')$$, (select business_id from cb), (select source_id from cs)), '22023', null, 'unknown source status rejected');
select is((select status from public.integration_sources where kind = 'website_form' and external_id = 'site-alpha-synthetic'), 'active', 'Business A source unchanged');
select is((select business_id from public.integration_sources where id = (select source_id from cs)), (select business_id from cb), 'source tenant never changed');
select pg_temp.logout();

-- =====================================================================================
-- ingestion follows source and business status (service persona, real ingest RPC)
-- =====================================================================================
select pg_temp.login_service();
select throws_ok($$select * from public.ingest_lead_event('website_form', 'site-charlie-synthetic', 'evt-charlie-1', '{"contact_name": "Synthetic"}')$$, '55000', null, 'inactive source is rejected by ingestion');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select lives_ok(format($$select * from public.admin_set_integration_source_status(%L, %L, 'active')$$, (select business_id from cb), (select source_id from cs)), 'source reactivated');
select pg_temp.logout();
select pg_temp.login_service();
create temp table ing1 as select * from public.ingest_lead_event('website_form', 'site-charlie-synthetic', 'evt-charlie-1', '{"contact_name": "Synthetic"}');
select is((select outcome from ing1), 'lead_created', 'reactivated source ingests again');
select is((select business_id from public.leads where source_event_id = 'evt-charlie-1'), (select business_id from cb), 'lead landed in the new business');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select lives_ok(format($$select * from public.admin_set_business_status(%L, 'suspended')$$, (select business_id from cb)), 'business suspended');
select pg_temp.logout();
select pg_temp.login_service();
select throws_ok($$select * from public.ingest_lead_event('website_form', 'site-charlie-synthetic', 'evt-charlie-2', '{"contact_name": "Synthetic"}')$$, '55000', null, 'suspended business is rejected by ingestion');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select lives_ok(format($$select * from public.admin_set_business_status(%L, 'active')$$, (select business_id from cb)), 'business reactivated');
select pg_temp.logout();
select pg_temp.login_service();
select lives_ok($$select * from public.ingest_lead_event('website_form', 'site-charlie-synthetic', 'evt-charlie-2', '{"contact_name": "Synthetic"}')$$, 'reactivated business ingests again');
select pg_temp.logout();
select is((select count(*) from public.leads where business_id = (select business_id from cb)), 2::bigint, 'two leads in the new business; none lost across suspension');
select is((select count(*) from public.integration_sources where business_id = (select business_id from cb)), 6::bigint, 'source configuration preserved across suspension');

-- =====================================================================================
-- ledger visibility and immutability
-- =====================================================================================
select pg_temp.login_as(:'admin');
select ok((select count(*) > 0 from public.platform_admin_events), 'administrator reads the ledger');
select throws_ok(format($$insert into public.platform_admin_events (business_id, event_type, actor_id, new_value) values (%L, 'business_created', %L, 'active')$$, :'biz_a', :'admin'), '42501', null, 'administrator cannot insert ledger rows directly');
select throws_ok($$update public.platform_admin_events set new_value = 'x'$$, '42501', null, 'administrator cannot update ledger rows');
select throws_ok($$delete from public.platform_admin_events$$, '42501', null, 'administrator cannot delete ledger rows');
select throws_ok(format($$update public.businesses set status = 'suspended' where id = %L$$, :'biz_a'), '42501', null, 'administrator cannot update businesses directly');
select throws_ok(format($$insert into public.integration_sources (business_id, kind, external_id) values (%L, 'website_form', 'direct')$$, :'biz_a'), '42501', null, 'administrator cannot insert sources directly');
select pg_temp.logout();
select pg_temp.login_as(:'a_owner');
select is((select count(*) from public.platform_admin_events), 0::bigint, 'customer reads no ledger rows');
select is((select count(*) from public.integration_sources), 0::bigint, 'customer reads no integration sources');
select is((select count(*) from public.businesses where id = (select business_id from cb)), 0::bigint, 'customer cannot see the new business');
select is((select count(*) from public.leads where business_id = (select business_id from cb)), 0::bigint, 'customer cannot see the new business''s leads');
select throws_ok(format($$insert into public.platform_admin_events (business_id, event_type, actor_id, new_value) values (%L, 'business_created', %L, 'active')$$, :'biz_a', :'a_owner'), '42501', null, 'customer cannot insert ledger rows');
select throws_ok($$update public.platform_admin_events set new_value = 'x'$$, '42501', null, 'customer cannot update ledger rows');
select throws_ok($$delete from public.platform_admin_events$$, '42501', null, 'customer cannot delete ledger rows');
select lives_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'customer assignment rules unchanged (owner still assigns)');
select pg_temp.logout();
select pg_temp.login_anon();
select throws_ok('select count(*) from public.platform_admin_events', '42501', null, 'anon cannot read the ledger');
select pg_temp.logout();
select throws_ok($$update public.platform_admin_events set new_value = 'x'$$, '23514', null, 'ledger rows are immutable even for postgres');
select throws_ok($$update public.platform_admin_events set actor_display_name = 'x'$$, '23514', null, 'display-name snapshots are immutable even for postgres');
select throws_ok(format($$insert into public.platform_admin_events (business_id, event_type, actor_id, old_value, new_value) values (%L, 'business_status_changed', %L, 'active', 'active')$$, :'biz_a', :'admin'), '23514', null, 'shape: status change needs a genuine difference');
select throws_ok(format($$insert into public.platform_admin_events (business_id, event_type, actor_id, old_value, new_value) values (%L, 'business_status_changed', %L, 'active', 'archived')$$, :'biz_a', :'admin'), '23514', null, 'shape: archived is not a recordable transition here');
select throws_ok(format($$insert into public.platform_admin_events (business_id, integration_source_id, event_type, actor_id, new_value) values (%L, %L, 'business_created', %L, 'active')$$, :'biz_a', 'a3000000-0000-4000-8000-000000000001', :'admin'), '23514', null, 'shape: business events carry no source id');
select throws_ok(format($$insert into public.platform_admin_events (business_id, event_type, actor_id, new_value) values (%L, 'integration_source_created', %L, 'active')$$, :'biz_a', :'admin'), '23514', null, 'shape: source events require a source id');
select throws_ok(format($$insert into public.platform_admin_events (business_id, event_type, actor_id, new_value) values (%L, 'lead_edited', %L, 'x')$$, :'biz_a', :'admin'), '23514', null, 'unknown event type rejected');
select throws_ok(format($$insert into public.platform_admin_events (business_id, event_type, actor_id, new_value, actor_display_name) values (%L, 'business_created', %L, 'active', %L)$$, :'biz_a', :'admin', repeat('n', 101)), '23514', null, 'display-name snapshot bounded at 100');

-- =====================================================================================
-- administrator account removal keeps history; existing history untouched
-- =====================================================================================
select is((select count(*) from public.platform_admin_events where actor_id = :'admin'), (select count(*) from public.platform_admin_events), 'setup: every ledger row names the administrator');
delete from public.profiles where id = :'admin';
select ok((select count(*) > 0 and bool_and(actor_id = :'admin'::uuid and actor_display_name = 'Platform Admin (synthetic)') from public.platform_admin_events), 'ledger rows keep the historical actor UUID and display-name snapshot after the profile is deleted');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'), 1::bigint, 'lead history unchanged by platform operations');
select throws_ok($$update public.lead_activities set new_value = 'x' where activity_type = 'assignment_changed'$$, '23514', null, 'lead activities remain immutable');

select * from finish();
rollback;
