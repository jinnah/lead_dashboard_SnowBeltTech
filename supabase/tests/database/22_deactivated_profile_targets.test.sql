-- Corrective coverage: a business owner can never manage a Manager/Staff
-- membership whose PROFILE SnowBeltTech has deactivated (profile activation is
-- platform-level); platform administrators keep their existing authority over
-- the same target. Posture of the replaced functions is re-proven. Synthetic
-- fixtures only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(35);

-- =====================================================================================
-- posture of the replaced functions is unchanged
-- =====================================================================================
select is((select prosecdef from pg_proc where oid = 'public.admin_set_business_member_role(uuid,uuid,text)'::regprocedure), true, 'member-role RPC still SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'public.admin_set_business_member_role(uuid,uuid,text)'::regprocedure), 'member-role RPC still pins an empty search_path');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.admin_set_business_member_role(uuid,uuid,text)'::regprocedure), 'postgres', 'member-role RPC still owned by postgres');
select is((select prosecdef from pg_proc where oid = 'public.admin_set_business_member_status(uuid,uuid,text)'::regprocedure), true, 'member-status RPC still SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'public.admin_set_business_member_status(uuid,uuid,text)'::regprocedure), 'member-status RPC still pins an empty search_path');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.admin_set_business_member_status(uuid,uuid,text)'::regprocedure), 'postgres', 'member-status RPC still owned by postgres');
select is(has_function_privilege('authenticated', 'public.admin_set_business_member_role(uuid,uuid,text)', 'EXECUTE'), true, 'authenticated can still execute member-role');
select is(has_function_privilege('anon', 'public.admin_set_business_member_role(uuid,uuid,text)', 'EXECUTE'), false, 'anon still cannot execute member-role');
select is(has_function_privilege('authenticated', 'public.admin_set_business_member_status(uuid,uuid,text)', 'EXECUTE'), true, 'authenticated can still execute member-status');
select is(has_function_privilege('anon', 'public.admin_set_business_member_status(uuid,uuid,text)', 'EXECUTE'), false, 'anon still cannot execute member-status');
select is((select count(*) from pg_policies where schemaname = 'public'), 13::bigint, 'policy inventory unchanged (13)');
select set_eq($$select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'$$,
  array['ingest_lead_event', 'add_lead_note', 'set_lead_assignee', 'admin_create_business', 'admin_set_business_status', 'admin_create_integration_source', 'admin_set_integration_source_status',
  'admin_prepare_customer_invitation', 'admin_mark_customer_invitation_sent', 'admin_mark_customer_invitation_failed', 'admin_revoke_customer_invitation', 'accept_customer_invitation', 'admin_set_business_member_role', 'admin_set_business_member_status', 'search_leads'],
  'public RPC inventory unchanged (15)');

-- =====================================================================================
-- fixture: SnowBeltTech deactivates staff A's PROFILE (platform-level control)
-- =====================================================================================
select is((select m.role || '|' || m.status from public.business_memberships m where m.business_id = :'biz_a' and m.user_id = :'a_staff'), 'BUSINESS_STAFF|active', 'setup: staff membership starts active');
update public.profiles set is_active = false where id = :'a_staff';

-- owner: every mutation against the deactivated-profile target is rejected
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '22023', null, 'owner cannot change the role of a profile-deactivated member');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'a_staff'), '22023', null, 'owner cannot deactivate the membership of a profile-deactivated member');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'active')$$, :'biz_a', :'a_staff'), '22023', null, 'owner cannot even re-affirm the membership of a profile-deactivated member');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, '00000000-0000-4000-8000-00000000dead', 'inactive')$$, :'biz_a'), 'P0002', null, 'unknown targets keep the pre-existing opaque not-found (no new distinction leaks)');
select pg_temp.logout();
select is((select m.role || '|' || m.status from public.business_memberships m where m.business_id = :'biz_a' and m.user_id = :'a_staff'), 'BUSINESS_STAFF|active', 'membership role and status are unchanged');
select is((select count(*) from public.customer_access_events where target_user_id = :'a_staff' and event_type in ('membership_role_changed', 'membership_status_changed')), 0::bigint, 'no audit event was written');

-- the same holds when the membership is ALSO inactive: the owner cannot "reactivate"
update public.business_memberships set status = 'inactive' where business_id = :'biz_a' and user_id = :'a_staff';
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'active')$$, :'biz_a', :'a_staff'), '22023', null, 'owner cannot reactivate a membership whose profile is deactivated');
select pg_temp.logout();
select is((select m.status from public.business_memberships m where m.business_id = :'biz_a' and m.user_id = :'a_staff'), 'inactive', 'the inactive membership stayed inactive');

-- platform administrators retain their existing authority over the SAME target
select pg_temp.login_as(:'admin');
select is((select changed from public.admin_set_business_member_status(:'biz_a'::uuid, :'a_staff'::uuid, 'active')), true, 'administrator can still reactivate the membership of a profile-deactivated user');
select is((select changed from public.admin_set_business_member_role(:'biz_a'::uuid, :'a_staff'::uuid, 'BUSINESS_MANAGER')), true, 'administrator can still change that role');
select is((select changed from public.admin_set_business_member_role(:'biz_a'::uuid, :'a_staff'::uuid, 'BUSINESS_STAFF')), true, 'and change it back');
select pg_temp.logout();
select is((select count(*) from public.customer_access_events where target_user_id = :'a_staff' and actor_id = :'admin'), 3::bigint, 'administrator actions are audited as before');

-- everyone else stays exactly as before
select pg_temp.login_as(:'b_owner');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'foreign owner posture unchanged');
select pg_temp.logout();
select pg_temp.login_as(:'a_manager');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'manager posture unchanged');
select pg_temp.logout();
select pg_temp.login_as(:'a_former');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'active')$$, :'biz_a', :'a_staff'), '42501', null, 'inactive-membership caller posture unchanged');
select pg_temp.logout();
select pg_temp.login_anon();
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'anon posture unchanged');
select pg_temp.logout();
select pg_temp.login_service();
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'service_role posture unchanged (no grant)');
select pg_temp.logout();

-- =====================================================================================
-- regression: with the profile ACTIVE again, owner management works exactly as approved
-- =====================================================================================
update public.profiles set is_active = true where id = :'a_staff';
select pg_temp.login_as(:'a_owner');
select is((select changed from public.admin_set_business_member_role(:'biz_a'::uuid, :'a_staff'::uuid, 'BUSINESS_MANAGER')), true, 'owner can again promote an active-profile member');
select is((select changed from public.admin_set_business_member_role(:'biz_a'::uuid, :'a_staff'::uuid, 'BUSINESS_STAFF')), true, 'and demote back');
select is((select changed from public.admin_set_business_member_status(:'biz_a'::uuid, :'a_staff'::uuid, 'inactive')), true, 'owner can again deactivate an active-profile membership');
select is((select changed from public.admin_set_business_member_status(:'biz_a'::uuid, :'a_staff'::uuid, 'active')), true, 'and reactivate it');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'a_owner'), '22023', null, 'owner self-protection unchanged');
select pg_temp.logout();

select * from finish();
rollback;
