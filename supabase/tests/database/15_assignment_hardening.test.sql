-- Corrective hardening: a platform administrator can never assign/unassign
-- through set_lead_assignee, even with an active owner/manager membership.
-- Synthetic fixtures only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(40);

-- =====================================================================================
-- posture is unchanged by the CREATE OR REPLACE
-- =====================================================================================
select has_function('public', 'set_lead_assignee', array['uuid', 'uuid'], 'set_lead_assignee(uuid, uuid) still exists with the same signature');
select is((select pg_get_function_result('public.set_lead_assignee(uuid,uuid)'::regprocedure)), 'TABLE(lead_id uuid, assigned_to uuid, changed boolean)', 'return columns and types unchanged');
select is((select prosecdef from pg_proc where oid = 'public.set_lead_assignee(uuid,uuid)'::regprocedure), true, 'still SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'public.set_lead_assignee(uuid,uuid)'::regprocedure), 'still an empty fixed search_path');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.set_lead_assignee(uuid,uuid)'::regprocedure), 'postgres', 'still owned by postgres');
select is(has_function_privilege('authenticated', 'public.set_lead_assignee(uuid,uuid)', 'EXECUTE'), true, 'authenticated can still execute');
select is(has_function_privilege('anon', 'public.set_lead_assignee(uuid,uuid)', 'EXECUTE'), false, 'anon still cannot execute');
select is(has_function_privilege('public', 'public.set_lead_assignee(uuid,uuid)', 'EXECUTE'), false, 'PUBLIC still cannot execute');
select is(has_column_privilege('authenticated', 'public.leads', 'assigned_to', 'UPDATE'), false, 'authenticated still lacks direct UPDATE on leads.assigned_to');
select ok((select prosrc like '%p.platform_role is null%' from pg_proc where oid = 'public.set_lead_assignee(uuid,uuid)'::regprocedure), 'caller authorization requires a null platform_role');

-- =====================================================================================
-- 1. administrator without any membership stays blocked (unchanged behavior)
-- =====================================================================================
select is((select count(*) from public.business_memberships where user_id = :'admin'), 0::bigint, 'setup: seeded administrator holds no membership');
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'administrator without membership cannot assign');
select pg_temp.logout();

-- =====================================================================================
-- 2-3. dual-role administrator (active BUSINESS_OWNER in Business A) is still blocked
-- =====================================================================================
insert into public.business_memberships (business_id, user_id, role, status) values (:'biz_a', :'admin', 'BUSINESS_OWNER', 'active');
select is((select platform_role || '|' || is_active::text from public.profiles where id = :'admin'), 'PLATFORM_ADMIN|true', 'setup: administrator profile is active with the platform role');
select is((select assigned_to is null from public.leads where id = :'lead_a2'), true, 'setup: lead A2 is unassigned');
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'dual-role administrator (owner) cannot assign: opaque P0002');
select throws_ok(format($$update public.leads set assigned_to = %L where id = %L$$, :'a_staff', :'lead_a2'), '42501', null, 'dual-role administrator cannot update assigned_to directly');
select is((select count(*) from public.leads where id = :'lead_a2'), 1::bigint, 'dual-role administrator can still read the lead');
select pg_temp.logout();
select is((select assigned_to is null from public.leads where id = :'lead_a2'), true, 'lead A2 remains unassigned');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'), 0::bigint, 'no assignment activity was created');

-- =====================================================================================
-- 4. dual-role administrator cannot unassign an already assigned lead
-- =====================================================================================
select pg_temp.login_as(:'a_owner');
select lives_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'setup: ordinary owner assigns A2 to staff');
select pg_temp.logout();
select is((select assigned_to from public.leads where id = :'lead_a2'), :'a_staff'::uuid, 'setup: A2 assigned to staff');
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.set_lead_assignee(%L, null)$$, :'lead_a2'), 'P0002', null, 'dual-role administrator (owner) cannot unassign');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_manager'), 'P0002', null, 'dual-role administrator (owner) cannot reassign');
-- 6. same-value request is rejected, not reported as a successful no-op
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'dual-role administrator (owner) same-value request is rejected rather than a no-op');
select pg_temp.logout();
select is((select assigned_to from public.leads where id = :'lead_a2'), :'a_staff'::uuid, 'A2 still assigned to staff');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'), 1::bigint, 'only the ordinary owner assignment is audited');

-- =====================================================================================
-- 5. BUSINESS_MANAGER membership changes nothing
-- =====================================================================================
update public.business_memberships set role = 'BUSINESS_MANAGER' where user_id = :'admin' and business_id = :'biz_a';
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_manager'), 'P0002', null, 'dual-role administrator (manager) cannot reassign');
select throws_ok(format($$select * from public.set_lead_assignee(%L, null)$$, :'lead_a2'), 'P0002', null, 'dual-role administrator (manager) cannot unassign');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'dual-role administrator (manager) same-value request is rejected');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a3', :'a_staff'), 'P0002', null, 'dual-role administrator (manager) cannot assign an unassigned lead either');
select pg_temp.logout();
select is((select assigned_to from public.leads where id = :'lead_a2'), :'a_staff'::uuid, 'A2 unchanged after manager-role attempts');
select is((select assigned_to is null from public.leads where id = :'lead_a3'), true, 'A3 unchanged after manager-role attempts');
select is((select count(*) from public.lead_activities where activity_type = 'assignment_changed'), 1::bigint, 'still exactly one assignment activity overall');

-- =====================================================================================
-- granting the platform role to an ordinary owner revokes assignment the same way
-- =====================================================================================
update public.profiles set platform_role = 'PLATFORM_ADMIN' where id = :'b_owner';
select pg_temp.login_as(:'b_owner');
select throws_ok(format($$select * from public.set_lead_assignee(%L, null)$$, :'lead_b1'), 'P0002', null, 'an owner promoted to platform administrator loses assignment in their own business');
select pg_temp.logout();
update public.profiles set platform_role = null where id = :'b_owner';
select is((select assigned_to from public.leads where id = :'lead_b1'), :'b_owner'::uuid, 'B1 unchanged');

-- =====================================================================================
-- 7. ordinary owners and managers (no platform role) keep full capability
-- =====================================================================================
select pg_temp.login_as(:'a_manager');
create temp table h1 as select * from public.set_lead_assignee(:'lead_a2', null);
select is((select changed from h1) and (select assigned_to is null from public.leads where id = :'lead_a2'), true, 'ordinary manager unassigns');
select pg_temp.logout();
select pg_temp.login_as(:'a_owner');
create temp table h2 as select * from public.set_lead_assignee(:'lead_a2', :'a_manager');
select is((select changed from h2) and (select assigned_to = :'a_manager'::uuid from public.leads where id = :'lead_a2'), true, 'ordinary owner assigns');
create temp table h3 as select * from public.set_lead_assignee(:'lead_a2', :'a_manager');
select is((select changed from h3), false, 'ordinary owner same-value request is still a successful no-op');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
create temp table h4 as select * from public.set_lead_assignee(:'lead_b1', null);
select is((select changed from h4), true, 'owner B (platform role restored to null) unassigns again');
select pg_temp.logout();
select is((select count(*) from public.lead_activities where activity_type = 'assignment_changed'), 4::bigint, 'every ordinary change was audited exactly once (1 + 3)');

select * from finish();
rollback;
