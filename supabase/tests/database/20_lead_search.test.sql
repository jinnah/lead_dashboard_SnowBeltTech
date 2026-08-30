-- Lead search / pagination RPC: posture, search semantics, injection safety,
-- deterministic paging, and tenant/role isolation. Synthetic fixtures only;
-- everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(61);

-- =====================================================================================
-- posture: SECURITY INVOKER, pinned search path, least privilege, exact surface
-- =====================================================================================
select has_function('public', 'search_leads',
  array['uuid', 'text', 'text', 'text', 'boolean', 'uuid', 'boolean', 'integer', 'integer', 'timestamptz', 'uuid'],
  'search_leads exists with the reviewed signature');
select is((select prosecdef from pg_proc where proname = 'search_leads' and pronamespace = 'public'::regnamespace), false,
  'search_leads is SECURITY INVOKER (RLS of the CALLER applies)');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""'))
           from pg_proc where proname = 'search_leads' and pronamespace = 'public'::regnamespace),
  'empty fixed search_path');
select is((select provolatile from pg_proc where proname = 'search_leads' and pronamespace = 'public'::regnamespace), 's', 'STABLE volatility');
select is((select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang
           where p.proname = 'search_leads' and p.pronamespace = 'public'::regnamespace), 'plpgsql', 'plpgsql language');
select is((select pg_get_userbyid(proowner) from pg_proc where proname = 'search_leads' and pronamespace = 'public'::regnamespace), 'postgres',
  'owned by the reviewed privileged owner');
select is(has_function_privilege('authenticated', 'public.search_leads(uuid,text,text,text,boolean,uuid,boolean,integer,integer,timestamptz,uuid)', 'EXECUTE'), true,
  'authenticated can execute');
select is(has_function_privilege('anon', 'public.search_leads(uuid,text,text,text,boolean,uuid,boolean,integer,integer,timestamptz,uuid)', 'EXECUTE'), false,
  'anon cannot execute');
select is(has_function_privilege('public', 'public.search_leads(uuid,text,text,text,boolean,uuid,boolean,integer,integer,timestamptz,uuid)', 'EXECUTE'), false,
  'PUBLIC cannot execute');
select is(has_function_privilege('service_role', 'public.search_leads(uuid,text,text,text,boolean,uuid,boolean,integer,integer,timestamptz,uuid)', 'EXECUTE'), false,
  'service_role has no grant (customer surfaces use the session client)');
select is(pg_get_function_result('public.search_leads(uuid,text,text,text,boolean,uuid,boolean,integer,integer,timestamptz,uuid)'::regprocedure),
  'TABLE(id uuid, lead_number text, contact_name text, phone_e164 text, email text, requested_service text, source text, status text, urgency text, review_recommended boolean, created_at timestamp with time zone, follow_up_at timestamp with time zone, assigned_to uuid, total_count bigint)',
  'returns exactly the reviewed columns');
select set_eq($$select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'$$,
  array['ingest_lead_event', 'add_lead_note', 'set_lead_assignee', 'admin_create_business', 'admin_set_business_status', 'admin_create_integration_source', 'admin_set_integration_source_status',
  'admin_prepare_customer_invitation', 'admin_mark_customer_invitation_sent', 'admin_mark_customer_invitation_failed', 'admin_revoke_customer_invitation', 'accept_customer_invitation', 'admin_set_business_member_role', 'admin_set_business_member_status', 'search_leads'],
  'public schema exposes exactly the fifteen reviewed RPCs');
select is((select count(*) from pg_policies where schemaname = 'public'), 13::bigint, 'RLS policy inventory unchanged by this file (13)');

-- =====================================================================================
-- fixture: a real note on lead A1 (notes must NEVER be searchable)
-- =====================================================================================
select pg_temp.login_as(:'a_owner');
select lives_ok(format($$select * from public.add_lead_note(%L, 'SECRET-NOTE-body finding', gen_random_uuid())$$, :'lead_a1'),
  'setup: owner adds a note through the ordinary RPC');

-- =====================================================================================
-- search semantics under the owner's own session (Business A seed data)
-- =====================================================================================
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'INQ-2026-0001')), 1::bigint, 'finds a lead by exact lead number');
select is((select s.total_count from public.search_leads(:'biz_a'::uuid, 'INQ-2026-0001') s limit 1), 1::bigint, 'total_count matches the filtered result');
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, 'inq 2026 0002') s), 'INQ-2026-0002', 'punctuation/space-insensitive lead-number search');
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, 'test contact one') s), 'INQ-2026-0001', 'mixed-case contact-name search');
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, 'CONTACT-ONE@EXAMPLE.INVALID') s), 'INQ-2026-0001', 'case-insensitive email search');
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, '(555) 010-0001') s), 'INQ-2026-0001', 'punctuated phone search matches the normalized number');
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, '0100002') s), 'INQ-2026-0002', 'partial normalized phone digits match');
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, 'duct') s), 'INQ-2026-0003', 'requested-service search');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, '  Test   Contact ')), 2::bigint, 'surrounding/internal whitespace is normalized');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'form-submission-a-0001')), 0::bigint, 'source event ids are NOT searchable');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'Synthetic consent text')), 0::bigint, 'consent text is NOT searchable');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'Synthetic call summary')), 0::bigint, 'call metadata is NOT searchable');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'SECRET-NOTE-body')), 0::bigint, 'note bodies are NOT searchable');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'Synthetic request details')), 0::bigint, 'lead details/payload text is NOT searchable');

-- combined with the other filters (all inside the database)
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, 'test contact', 'contacted') s), 'INQ-2026-0003', 'search combines with status');
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, 'test', null, 'website_form') s), 'INQ-2026-0001', 'search combines with source');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'test', null, null, true)), 2::bigint, 'search combines with unassigned');
select is((select s.lead_number from public.search_leads(:'biz_a'::uuid, 'test', null, null, false, :'a_manager'::uuid) s), 'INQ-2026-0001', 'search combines with assignee');

-- hostile input matches literally or not at all - never as SQL/LIKE/PostgREST grammar
select is((select count(*) from public.search_leads(:'biz_a'::uuid, '%')), 0::bigint, 'a lone percent matches only literal percents');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, '_')), 0::bigint, 'a lone underscore matches only literal underscores');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, '\')), 0::bigint, 'a lone backslash matches only literal backslashes');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, ''');drop table public.leads;--')), 0::bigint, 'SQL metacharacters are inert data');
select is((select count(*) from public.leads where business_id = :'biz_a'), 3::bigint, 'leads table is intact after the hostile probe');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'or(status.eq.new)')), 0::bigint, 'PostgREST filter grammar is inert data');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, repeat('x', 500))), 0::bigint, 'oversized search text is bounded and harmless');

-- paging parameter clamps
select is((select count(*) from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, false, 100000, 0)), 3::bigint, 'an oversized limit is clamped, not an error');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, false, -5, 0)), 1::bigint, 'a negative limit clamps to one row');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, false, 50, -10)), 3::bigint, 'a negative offset clamps to zero');
select pg_temp.logout();

-- =====================================================================================
-- deterministic pagination: five leads sharing ONE timestamp can never duplicate
-- or skip across pages (secondary order on id)
-- =====================================================================================
insert into public.leads (business_id, lead_number, source, contact_name, created_at)
select :'biz_a', 'TIE-000' || i, 'manual', 'Tie Contact ' || i, '2026-08-20T10:00:00Z'::timestamptz
from generate_series(1, 5) i;
select is((select count(*) from public.leads where business_id = :'biz_a'), 8::bigint, 'setup: five tie-timestamp leads added (eight total)');

select pg_temp.login_as(:'a_owner');
select is((
  with p as (
    select s.id from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, false, 3, 0) s
    union all
    select s.id from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, false, 3, 3) s
    union all
    select s.id from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, false, 3, 6) s
  )
  select count(*) || '|' || count(distinct id) from p
), '8|8', 'newest-first offset pages cover all eight leads exactly once');
select is((
  with p as (
    select s.id from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, true, 3, 0) s
    union all
    select s.id from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, true, 3, 3) s
    union all
    select s.id from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, true, 3, 6) s
  )
  select count(*) || '|' || count(distinct id) from p
), '8|8', 'oldest-first offset pages cover all eight leads exactly once');
select is((
  select array_agg(s.id order by s.ordinality)
  from public.search_leads(:'biz_a'::uuid) with ordinality s
), (
  select array_agg(s.id order by s.ordinality)
  from public.search_leads(:'biz_a'::uuid) with ordinality s
), 'the newest-first ordering is fully deterministic across repeated calls');
select is((
  with o as (select s.id, s.created_at, s.ordinality as rn from public.search_leads(:'biz_a'::uuid) with ordinality s),
       cur as (select created_at, id from o where rn = 4),
       nxt as (select s.id, s.ordinality as rn from public.search_leads(:'biz_a'::uuid, null, null, null, false, null, false, 1000, 0,
                 (select created_at from cur), (select id from cur)) with ordinality s)
  select bool_and(o.id = nxt.id) and count(*) = 4 from o join nxt on o.rn = nxt.rn + 4
), true, 'keyset cursor batches continue exactly where offset paging stopped');
select is((select s.total_count from public.search_leads(:'biz_a'::uuid, 'Tie Contact', null, null, false, null, false, 1, 0) s limit 1), 5::bigint,
  'total_count is the full filtered count computed before the page limit');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'Tie Contact')), 5::bigint, 'search matches all tie leads');

-- =====================================================================================
-- tenant isolation and roles (the function grants NOTHING beyond caller RLS)
-- =====================================================================================
select is((select count(*) from public.search_leads(:'biz_b'::uuid)), 0::bigint, 'owner A calling with business B id gets zero rows');
select is((select count(*) from public.search_leads(:'biz_b'::uuid, 'Test Contact Four')), 0::bigint, 'owner A cannot search business B content');
select pg_temp.logout();

select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.search_leads(:'biz_a'::uuid, 'Tie Contact')), 0::bigint, 'owner B gets zero rows and zero count from business A');
select is((select count(*) from public.search_leads(:'biz_b'::uuid, 'Test Contact Four')), 1::bigint, 'owner B still searches business B normally');
select is((select count(*) from public.search_leads(:'biz_b'::uuid, 'TIE')), 0::bigint, 'business A tie leads never leak into business B results');
select pg_temp.logout();

select pg_temp.login_as(:'admin');
select is((select count(*) from public.search_leads(:'biz_a'::uuid)), 8::bigint, 'platform administrator keeps exactly the existing read-only visibility');
select pg_temp.logout();

select pg_temp.login_as(:'a_former');
select is((select count(*) from public.search_leads(:'biz_a'::uuid)), 0::bigint, 'inactive membership receives nothing');
select pg_temp.logout();

update public.profiles set is_active = false where id = :'a_staff';
select pg_temp.login_as(:'a_staff');
select is((select count(*) from public.search_leads(:'biz_a'::uuid)), 0::bigint, 'deactivated profile receives nothing');
select pg_temp.logout();
update public.profiles set is_active = true where id = :'a_staff';

update public.businesses set status = 'suspended' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select is((select count(*) from public.search_leads(:'biz_a'::uuid)), 0::bigint, 'suspended business members receive nothing');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select is((select count(*) from public.search_leads(:'biz_a'::uuid)), 8::bigint, 'administrator visibility of a suspended business is unchanged');
select pg_temp.logout();
update public.businesses set status = 'archived' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select is((select count(*) from public.search_leads(:'biz_a'::uuid)), 0::bigint, 'archived business members receive nothing');
select pg_temp.logout();
update public.businesses set status = 'active' where id = :'biz_a';

select pg_temp.login_anon();
select throws_ok($$select * from public.search_leads('a0000000-0000-4000-8000-000000000001'::uuid)$$, '42501', null,
  'anonymous sessions cannot execute search_leads at all');
select pg_temp.logout();

select * from finish();
rollback;
