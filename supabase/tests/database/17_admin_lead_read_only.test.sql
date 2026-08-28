-- Batch 4A corrective hardening: platform administrators are read-only on
-- customer leads even with active business memberships — enforced in the shared
-- helper private.active_business_ids(). Synthetic fixtures; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(87);

-- =====================================================================================
-- helper posture (unchanged except the platform-role exclusion)
-- =====================================================================================
select has_function('private', 'active_business_ids', '{}'::name[], 'active_business_ids() exists with zero arguments');
select is(pg_get_function_result('private.active_business_ids()'::regprocedure), 'SETOF uuid', 'SETOF uuid return type');
select is((select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'private.active_business_ids()'::regprocedure), 'sql', 'SQL language');
select is((select provolatile from pg_proc where oid = 'private.active_business_ids()'::regprocedure), 's', 'STABLE volatility');
select is((select prosecdef from pg_proc where oid = 'private.active_business_ids()'::regprocedure), true, 'SECURITY DEFINER');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'private.active_business_ids()'::regprocedure), 'postgres', 'owned by the approved privileged owner');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'private.active_business_ids()'::regprocedure), 'empty fixed search_path');
select is(has_function_privilege('authenticated', 'private.active_business_ids()', 'EXECUTE'), true, 'authenticated may execute');
select is(has_function_privilege('anon', 'private.active_business_ids()', 'EXECUTE'), false, 'anon cannot execute');
select is(has_function_privilege('public', 'private.active_business_ids()', 'EXECUTE'), false, 'PUBLIC cannot execute');
select ok((select prosrc like '%platform_role is null%' from pg_proc where oid = 'private.active_business_ids()'::regprocedure), 'platform-role exclusion present in the helper');
select set_eq($$select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'$$,
  array['ingest_lead_event', 'add_lead_note', 'set_lead_assignee', 'admin_create_business', 'admin_set_business_status', 'admin_create_integration_source', 'admin_set_integration_source_status',
  'admin_prepare_customer_invitation', 'admin_mark_customer_invitation_sent', 'admin_mark_customer_invitation_failed', 'admin_revoke_customer_invitation', 'accept_customer_invitation', 'admin_set_business_member_role', 'admin_set_business_member_status'],
  'public RPC inventory: exactly the fourteen reviewed RPCs');
select is((select count(*) from pg_policies where schemaname = 'public'), 12::bigint, 'RLS policy inventory: the 12 reviewed policies');

-- =====================================================================================
-- fixture: give lead A3 a microsecond-precision follow-up via a legitimate staff session
-- =====================================================================================
select pg_temp.login_as(:'a_staff');
update public.leads set follow_up_at = '2032-04-01T10:30:00.250000Z' where id = :'lead_a3';
select pg_temp.logout();
select is((select count(*) from public.lead_activities where lead_id = :'lead_a3' and activity_type = 'follow_up_changed'), 1::bigint, 'setup: staff scheduled a follow-up (audited)');

-- =====================================================================================
-- baseline administrator (no membership)
-- =====================================================================================
select pg_temp.login_as(:'admin');
select is((select private.is_platform_admin()), true, 'admin without membership: is_platform_admin');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'admin without membership: zero customer business ids');
select is((select count(*) from public.businesses), 2::bigint, 'admin still reads all businesses');
select is((select count(*) from public.leads), 5::bigint, 'admin still reads all leads');
select pg_temp.logout();

-- =====================================================================================
-- dual-role administrator: BUSINESS_OWNER membership in Business A
-- =====================================================================================
insert into public.business_memberships (business_id, user_id, role, status) values (:'biz_a', :'admin', 'BUSINESS_OWNER', 'active');
select pg_temp.login_as(:'admin');
select is((select private.is_platform_admin()), true, 'dual-role admin (owner): still a platform administrator');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'dual-role admin (owner): zero customer business ids');
update public.leads set status = 'contacted' where id = :'lead_a1';
select is((select status from public.leads where id = :'lead_a1'), 'new', 'direct status UPDATE changed nothing');
update public.leads set follow_up_at = '2032-01-01T15:00:00.123456Z' where id = :'lead_a1';
select is((select follow_up_at from public.leads where id = :'lead_a1'), null, 'direct follow-up UPDATE changed nothing');
update public.leads set follow_up_at = null where id = :'lead_a3';
select is((select follow_up_at from public.leads where id = :'lead_a3'), '2032-04-01T10:30:00.250000Z'::timestamptz, 'direct follow-up clear changed nothing');
update public.leads set status = 'spam';
select is((select count(*) from public.leads where status = 'spam'), 0::bigint, 'unfiltered UPDATE changed no lead anywhere');
select throws_ok(format($$select * from public.add_lead_note(%L, 'synthetic unauthorized administrator note', '77777777-7777-4777-8777-777777777777')$$, :'lead_a1'), 'P0002', null, 'add_lead_note rejected (opaque P0002)');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'set_lead_assignee still rejected (P0002)');
select is((select count(*) from public.leads), 5::bigint, 'dual-role admin keeps global lead reads');
select pg_temp.logout();
select is((select count(*) from public.lead_activities where actor_id = :'admin'), 0::bigint, 'no unauthorized activities were created');

-- =====================================================================================
-- same protection for MANAGER, STAFF and multiple memberships
-- =====================================================================================
update public.business_memberships set role = 'BUSINESS_MANAGER' where user_id = :'admin';
select pg_temp.login_as(:'admin');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'dual-role admin (manager): zero business ids');
update public.leads set status = 'contacted' where id = :'lead_a1';
select is((select status from public.leads where id = :'lead_a1'), 'new', 'manager-role membership: status UPDATE ineffective');
select throws_ok(format($$select * from public.add_lead_note(%L, 'note', '77777777-7777-4777-8777-777777777778')$$, :'lead_a1'), 'P0002', null, 'manager-role membership: add_lead_note P0002');
select pg_temp.logout();
update public.business_memberships set role = 'BUSINESS_STAFF' where user_id = :'admin';
select pg_temp.login_as(:'admin');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'dual-role admin (staff): zero business ids');
update public.leads set follow_up_at = now() where id = :'lead_a1';
select is((select follow_up_at from public.leads where id = :'lead_a1'), null, 'staff-role membership: follow-up UPDATE ineffective');
select pg_temp.logout();
insert into public.business_memberships (business_id, user_id, role, status) values (:'biz_b', :'admin', 'BUSINESS_OWNER', 'active');
select pg_temp.login_as(:'admin');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'memberships in MULTIPLE businesses: still zero ids');
update public.leads set status = 'contacted' where id = :'lead_b1';
select is((select status from public.leads where id = :'lead_b1'), 'new', 'Business B lead also unchanged');
select throws_ok(format($$select * from public.add_lead_note(%L, 'note', '77777777-7777-4777-8777-777777777779')$$, :'lead_b1'), 'P0002', null, 'Business B note also P0002');

-- =====================================================================================
-- dual-role administrator retains permitted global reads
-- =====================================================================================
select is((select count(*) from public.businesses), 2::bigint, 'reads businesses');
select is((select count(*) from public.leads), 5::bigint, 'reads leads');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a3'), 1::bigint, 'reads lead activities');
select is((select count(*) from public.profiles), 6::bigint, 'reads profiles');
select is((select count(*) from public.business_memberships) >= 5, true, 'reads memberships');
select is((select count(*) from public.integration_sources), 3::bigint, 'reads integration sources');
select is((select count(*) from public.platform_admin_events), 0::bigint, 'reads the (empty) platform ledger without error');

-- =====================================================================================
-- dual-role administrator retains approved platform operations (audited)
-- =====================================================================================
create temp table cb as select * from public.admin_create_business('Hotel Cleaning (synthetic)', 'hotel-cleaning', 'cleaning', 'UTC');
grant select on cb to public;
select is((select status from cb), 'active', 'dual-role admin creates a business');
create temp table s1 as select * from public.admin_set_business_status((select business_id from cb), 'suspended');
select is((select status || '|' || changed::text from s1), 'suspended|true', 'dual-role admin suspends it');
create temp table s2 as select * from public.admin_set_business_status((select business_id from cb), 'active');
select is((select status || '|' || changed::text from s2), 'active|true', 'dual-role admin reactivates it');
create temp table cs as select * from public.admin_create_integration_source((select business_id from cb), 'website_form', 'site-hotel-synthetic', 'Hotel form', null);
grant select on cs to public;
select is((select status from cs), 'active', 'dual-role admin registers a source');
create temp table d1 as select * from public.admin_set_integration_source_status((select business_id from cb), (select source_id from cs), 'inactive');
select is((select status || '|' || changed::text from d1), 'inactive|true', 'dual-role admin deactivates the source');
create temp table d2 as select * from public.admin_set_integration_source_status((select business_id from cb), (select source_id from cs), 'active');
select is((select status || '|' || changed::text from d2), 'active|true', 'dual-role admin reactivates the source');
select is((select count(*) from public.platform_admin_events where business_id = (select business_id from cb)), 6::bigint, 'all six platform operations audited');
select is((select bool_and(actor_id = :'admin'::uuid and actor_display_name = 'Platform Admin (synthetic)') from public.platform_admin_events), true, 'audit rows carry the actor UUID and display-name snapshot');
select pg_temp.logout();
delete from public.business_memberships where user_id = :'admin';

-- =====================================================================================
-- promoting an ordinary owner to PLATFORM_ADMIN removes customer authorization at once
-- =====================================================================================
select pg_temp.login_as(:'b_owner');
select set_eq('select * from private.active_business_ids()', array[:'biz_b'::uuid], 'setup: owner B has Business B');
select pg_temp.logout();
update public.profiles set platform_role = 'PLATFORM_ADMIN' where id = :'b_owner';
select pg_temp.login_as(:'b_owner');
select is((select private.is_platform_admin()), true, 'promoted owner is a platform administrator');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'customer business ids disappear immediately');
update public.leads set status = 'contacted' where id = :'lead_b1';
select is((select status from public.leads where id = :'lead_b1'), 'new', 'promoted owner: status UPDATE ineffective');
update public.leads set follow_up_at = now() where id = :'lead_b1';
select is((select follow_up_at from public.leads where id = :'lead_b1'), null, 'promoted owner: follow-up UPDATE ineffective');
select throws_ok(format($$select * from public.add_lead_note(%L, 'note', '77777777-7777-4777-8777-77777777777a')$$, :'lead_b1'), 'P0002', null, 'promoted owner: add_lead_note P0002');
select throws_ok(format($$select * from public.set_lead_assignee(%L, null)$$, :'lead_b1'), 'P0002', null, 'promoted owner: set_lead_assignee P0002');
select is((select count(*) from public.businesses), 3::bigint, 'promoted owner gains global reads (all businesses incl. the new one)');
select is((select count(*) from public.leads), 5::bigint, 'promoted owner reads all leads');
create temp table pr as select * from public.admin_set_business_status((select business_id from cb), 'active');
select is((select changed from pr), false, 'promoted owner can run approved platform operations');
select pg_temp.logout();

-- =====================================================================================
-- demotion restores legitimate customer capability, never cross-tenant access
-- =====================================================================================
update public.profiles set platform_role = null where id = :'b_owner';
select pg_temp.login_as(:'b_owner');
select set_eq('select * from private.active_business_ids()', array[:'biz_b'::uuid], 'demotion restores the legitimate business id');
select is((select count(*) from public.businesses), 1::bigint, 'normal tenant visibility restored (own business only)');
update public.leads set status = 'contacted' where id = :'lead_b1';
select is((select status from public.leads where id = :'lead_b1'), 'contacted', 'permitted status update works again');
update public.leads set follow_up_at = '2032-06-01T09:00:00.750000Z' where id = :'lead_b1';
select is((select follow_up_at from public.leads where id = :'lead_b1'), '2032-06-01T09:00:00.750000Z'::timestamptz, 'permitted follow-up update works again');
create temp table n1 as select * from public.add_lead_note(:'lead_b1', 'legitimate owner note', '77777777-7777-4777-8777-77777777777b');
select is((select replayed from n1), false, 'add_lead_note works again');
create temp table asg as select * from public.set_lead_assignee(:'lead_b2', :'b_owner');
select is((select changed from asg), true, 'owner assignment works again');
update public.leads set status = 'spam' where id = :'lead_a1';
select is((select count(*) from public.leads where id = :'lead_a1'), 0::bigint, 'cross-tenant leads remain invisible');
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_a1'), 'new', 'cross-tenant lead unchanged');

-- =====================================================================================
-- ordinary customer roles keep their workflows
-- =====================================================================================
select pg_temp.login_as(:'a_owner');
update public.leads set status = 'qualified' where id = :'lead_a1';
select is((select status from public.leads where id = :'lead_a1'), 'qualified', 'owner updates status');
create temp table oa as select * from public.set_lead_assignee(:'lead_a2', :'a_staff');
select is((select changed from oa), true, 'owner assigns');
select pg_temp.logout();
select pg_temp.login_as(:'a_manager');
update public.leads set follow_up_at = '2032-02-02T08:00:00.000001Z' where id = :'lead_a1';
select is((select follow_up_at from public.leads where id = :'lead_a1'), '2032-02-02T08:00:00.000001Z'::timestamptz, 'manager updates follow-up');
create temp table ma as select * from public.set_lead_assignee(:'lead_a2', null);
select is((select changed from ma), true, 'manager unassigns');
select pg_temp.logout();
select pg_temp.login_as(:'a_staff');
update public.leads set status = 'contacted', follow_up_at = null where id = :'lead_a3';
select is((select status || '|' || coalesce(follow_up_at::text, '-') from public.leads where id = :'lead_a3'), 'contacted|-', 'staff updates status and clears follow-up');
create temp table sn as select * from public.add_lead_note(:'lead_a3', 'staff note', '77777777-7777-4777-8777-77777777777c');
select is((select replayed from sn), false, 'staff adds a note');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a3', :'a_staff'), 'P0002', null, 'staff still cannot assign');
select pg_temp.logout();

-- =====================================================================================
-- existing denials remain effective
-- =====================================================================================
update public.profiles set is_active = false where id = :'a_manager';
select pg_temp.login_as(:'a_manager');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'inactive profile: zero business ids');
select pg_temp.logout();
update public.profiles set is_active = true where id = :'a_manager';
update public.business_memberships set status = 'inactive' where user_id = :'a_staff';
select pg_temp.login_as(:'a_staff');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'inactive membership: zero business ids');
select pg_temp.logout();
update public.business_memberships set status = 'active' where user_id = :'a_staff';
update public.businesses set status = 'suspended' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'suspended business: zero business ids');
select pg_temp.logout();
update public.businesses set status = 'archived' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'archived business: zero business ids');
select pg_temp.logout();
update public.businesses set status = 'active' where id = :'biz_a';
select pg_temp.login_anon();
select throws_ok('select count(*) from public.leads', '42501', null, 'anonymous callers still read nothing');
select throws_ok('select * from private.active_business_ids()', '42501', null, 'anonymous callers cannot execute the helper');
select pg_temp.logout();

-- =====================================================================================
-- history remains immutable, precise, and survives administrator account removal
-- =====================================================================================
select throws_ok($$update public.lead_activities set new_value = 'x'$$, '23514', null, 'lead activities immutable even for postgres');
select is((select new_value from public.lead_activities where lead_id = :'lead_a3' and activity_type = 'follow_up_changed' and new_value is not null order by created_at limit 1), '2032-04-01T10:30:00.250000Z', 'microsecond-precision follow-up audit value preserved');
select throws_ok($$update public.platform_admin_events set new_value = 'x'$$, '23514', null, 'platform audit immutable even for postgres');
select throws_ok($$update public.platform_admin_events set actor_display_name = 'x'$$, '23514', null, 'audit display-name snapshots immutable');
delete from public.profiles where id = :'admin';
select is((select count(*) from public.platform_admin_events where actor_id = :'admin'::uuid and actor_display_name = 'Platform Admin (synthetic)'), 6::bigint, 'audit history retains the historical actor UUID and snapshot after profile removal');

select * from finish();
rollback;
