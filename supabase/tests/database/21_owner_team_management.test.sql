-- Customer-owner team management: shared authorization gate, owner-scoped
-- invitation lifecycle, member role/status management, owner restrictions
-- (no OWNER provisioning, no self, no other owners, opaque admin targets),
-- invitation visibility policy, and unchanged administrator authority.
-- Synthetic fixtures only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(66);

-- =====================================================================================
-- posture: helpers, policy inventory, unchanged public surface
-- =====================================================================================
select has_function('private', 'team_management_actor', array['uuid'], 'team_management_actor exists');
select is((select prosecdef from pg_proc where oid = 'private.team_management_actor(uuid)'::regprocedure), true, 'gate is SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'private.team_management_actor(uuid)'::regprocedure), 'gate pins an empty search_path');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'private.team_management_actor(uuid)'::regprocedure), 'postgres', 'gate owned by postgres');
select is(has_function_privilege('authenticated', 'private.team_management_actor(uuid)', 'EXECUTE'), false, 'authenticated cannot call the gate directly');
select has_function('private', 'owner_business_ids', 'owner_business_ids exists');
select is((select prosecdef from pg_proc where oid = 'private.owner_business_ids()'::regprocedure), true, 'owner_business_ids is SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'private.owner_business_ids()'::regprocedure), 'owner_business_ids pins an empty search_path');
select is(has_function_privilege('authenticated', 'private.owner_business_ids()', 'EXECUTE'), true, 'authenticated may evaluate owner_business_ids (policy use)');
select is(has_function_privilege('anon', 'private.owner_business_ids()', 'EXECUTE'), false, 'anon may not');
select is((select count(*) from pg_policies where schemaname = 'public'), 13::bigint, 'policy inventory: the 13 reviewed policies');
select ok((select exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_invitations' and policyname = 'customer_invitations_select_business_owner' and cmd = 'SELECT')), 'the new owner policy is SELECT-only');
select set_eq($$select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'$$,
  array['ingest_lead_event', 'add_lead_note', 'set_lead_assignee', 'admin_create_business', 'admin_set_business_status', 'admin_create_integration_source', 'admin_set_integration_source_status',
  'admin_prepare_customer_invitation', 'admin_mark_customer_invitation_sent', 'admin_mark_customer_invitation_failed', 'admin_revoke_customer_invitation', 'accept_customer_invitation', 'admin_set_business_member_role', 'admin_set_business_member_status', 'search_leads'],
  'public RPC inventory unchanged (15)');

-- =====================================================================================
-- owner invitation lifecycle (Business A owner, synthetic .invalid emails)
-- =====================================================================================
select pg_temp.login_as(:'a_owner');
select lives_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'team-mgr@a.example.invalid', 'Team Mgr', 'BUSINESS_MANAGER')$$, :'biz_a'), 'owner prepares a MANAGER invitation');
select lives_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'team-staff@a.example.invalid', 'Team Staff', 'BUSINESS_STAFF')$$, :'biz_a'), 'owner prepares a STAFF invitation');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'team-mgr@a.example.invalid', 'Dup', 'BUSINESS_STAFF')$$, :'biz_a'), '23505', null, 'one live invitation per email holds for owner invitations');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'team-own@a.example.invalid', 'Nope', 'BUSINESS_OWNER')$$, :'biz_a'), '22023', null, 'owner cannot provision another OWNER');
select is((select count(*) from public.customer_invitations), 2::bigint, 'owner reads exactly their own business''s invitations');
select pg_temp.logout();

create temp table ti on commit drop as
  select (select id from public.customer_invitations where email = 'team-mgr@a.example.invalid') as mgr_id,
         (select id from public.customer_invitations where email = 'team-staff@a.example.invalid') as staff_id;
grant select on ti to public;
select is((select count(*) from public.customer_invitations i where i.created_by = :'a_owner' and i.status = 'prepared'), 2::bigint, 'both invitations recorded with the owner as creator');
select is((select count(*) from public.customer_access_events e where e.event_type = 'invitation_prepared' and e.actor_id = :'a_owner'), 2::bigint, 'invitation_prepared audited with the owner actor');

-- visibility: managers, staff, foreign owners see nothing; admins see everything
select pg_temp.login_as(:'a_manager');
select is((select count(*) from public.customer_invitations), 0::bigint, 'manager reads no invitations');
select pg_temp.logout();
select pg_temp.login_as(:'a_staff');
select is((select count(*) from public.customer_invitations), 0::bigint, 'staff reads no invitations');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.customer_invitations), 0::bigint, 'a foreign owner reads no Business A invitations');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select is((select count(*) from public.customer_invitations), 2::bigint, 'administrator visibility unchanged');
select pg_temp.logout();

-- mark-sent under the owner (the Auth account fixture mirrors the coordinator)
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'team-mgr@a.example.invalid',
        extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}',
        jsonb_build_object('portal_invitation_id', (select mgr_id from ti)::text), false, '', '', '', '', now(), now());
select pg_temp.login_as(:'a_owner');
select lives_ok($$select * from public.admin_mark_customer_invitation_sent((select mgr_id from ti), 'f1000000-0000-4000-8000-000000000001')$$, 'owner marks their invitation sent');
select pg_temp.logout();
select is((select status from public.customer_invitations where id = (select mgr_id from ti)), 'sent', 'invitation is sent and bound');

-- foreign/unknown invitation targets are indistinguishable (opaque P0002)
select pg_temp.login_as(:'a_manager');
select throws_ok($$select * from public.admin_mark_customer_invitation_sent((select mgr_id from ti), 'f1000000-0000-4000-8000-000000000001')$$, 'P0002', null, 'manager probing a real invitation gets opaque not-found');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select throws_ok($$select * from public.admin_mark_customer_invitation_failed((select staff_id from ti))$$, 'P0002', null, 'foreign owner probing a real invitation gets opaque not-found');
select pg_temp.logout();
select pg_temp.login_as(:'a_owner');
select throws_ok($$select * from public.admin_mark_customer_invitation_failed('00000000-0000-4000-8000-00000000dead')$$, 'P0002', null, 'an unknown invitation id is byte-identical: opaque not-found');

-- owner revoke + idempotent replay + owner failed-delivery compensation contract
select lives_ok(format($$select * from public.admin_revoke_customer_invitation(%L, (select mgr_id from ti))$$, :'biz_a'), 'owner revokes their sent invitation');
select is((select status from public.customer_invitations where id = (select mgr_id from ti)), 'revoked', 'revocation landed');
select is((select changed from public.admin_revoke_customer_invitation(:'biz_a'::uuid, (select mgr_id from ti))), false, 'replayed revocation is a safe no-op');
select is((select cleanup_auth_user_id is null from public.admin_mark_customer_invitation_failed((select staff_id from ti))), true, 'owner failure compensation returns no cleanup candidate without the exact provenance marker');
select pg_temp.logout();
select is((select count(*) from public.customer_access_events where event_type = 'invitation_revoked' and actor_id = :'a_owner'), 1::bigint, 'exactly one revocation audit row');
select is((select status from public.customer_invitations where id = (select staff_id from ti)), 'failed', 'owner-marked failure landed');

-- =====================================================================================
-- owner member management: allowed changes, forbidden targets
-- =====================================================================================
select pg_temp.login_as(:'a_owner');
select is((select changed from public.admin_set_business_member_role(:'biz_a'::uuid, :'a_staff'::uuid, 'BUSINESS_MANAGER')), true, 'owner promotes staff to manager');
select is((select changed from public.admin_set_business_member_role(:'biz_a'::uuid, :'a_staff'::uuid, 'BUSINESS_MANAGER')), false, 'repeating the same change is a no-op');
select is((select changed from public.admin_set_business_member_role(:'biz_a'::uuid, :'a_staff'::uuid, 'BUSINESS_STAFF')), true, 'owner demotes back to staff');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_OWNER')$$, :'biz_a', :'a_manager'), '22023', null, 'owner cannot promote anyone INTO ownership');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_owner'), '22023', null, 'owner cannot change their own role');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'a_owner'), '22023', null, 'owner cannot deactivate themselves');
select is((select changed from public.admin_set_business_member_status(:'biz_a'::uuid, :'a_staff'::uuid, 'inactive')), true, 'owner deactivates staff');
select is((select changed from public.admin_set_business_member_status(:'biz_a'::uuid, :'a_staff'::uuid, 'inactive')), false, 'repeated deactivation is idempotent');
select is((select changed from public.admin_set_business_member_status(:'biz_a'::uuid, :'a_staff'::uuid, 'active')), true, 'owner reactivates staff');
select pg_temp.logout();
select is((select count(*) from public.customer_access_events where event_type = 'membership_role_changed' and actor_id = :'a_owner'), 2::bigint, 'role changes audited with the owner actor');
select is((select count(*) from public.customer_access_events where event_type = 'membership_status_changed' and actor_id = :'a_owner'), 2::bigint, 'status changes audited once per real change');

-- another OWNER is read-only for owners; platform-admin targets stay opaque
insert into public.business_memberships (business_id, user_id, role, status) values (:'biz_a', :'b_owner', 'BUSINESS_OWNER', 'active');
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'b_owner'), '22023', null, 'owner cannot change another owner');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'b_owner'), '22023', null, 'owner cannot deactivate another owner');
select pg_temp.logout();
delete from public.business_memberships where business_id = :'biz_a' and user_id = :'b_owner';
insert into public.business_memberships (business_id, user_id, role, status) values (:'biz_a', :'admin', 'BUSINESS_MANAGER', 'active');
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'admin'), 'P0002', null, 'platform-administrator targets stay opaque for owners');
select pg_temp.logout();
delete from public.business_memberships where business_id = :'biz_a' and user_id = :'admin';

-- =====================================================================================
-- everyone else stays denied; revoked identities and states grant nothing
-- =====================================================================================
select pg_temp.login_as(:'a_manager');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'manager cannot manage the team');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'nm@a.example.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '42501', null, 'manager cannot invite');
select pg_temp.logout();
select pg_temp.login_as(:'a_staff');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'ns@a.example.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '42501', null, 'staff cannot invite');
select pg_temp.logout();
select pg_temp.login_as(:'a_former');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'nf@a.example.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '42501', null, 'inactive membership cannot invite');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'nb@a.example.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '42501', null, 'a foreign owner cannot invite into Business A');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'a foreign owner cannot manage Business A members');
select pg_temp.logout();
select pg_temp.login_anon();
select throws_ok(format($$select * from public.admin_revoke_customer_invitation(%L, '00000000-0000-4000-8000-00000000dead')$$, :'biz_a'), '42501', null, 'anonymous callers stay denied');
select pg_temp.logout();

update public.businesses set status = 'suspended' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'sx@a.example.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '42501', null, 'owner of a suspended business loses team management');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'sx@a.example.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '55000', null, 'administrator invitation rule for suspended businesses is unchanged');
select lives_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'a_staff'), 'administrator can still manage members of a suspended business');
select lives_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'active')$$, :'biz_a', :'a_staff'), 'and restore them');
select pg_temp.logout();
update public.businesses set status = 'archived' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'owner of an archived business loses team management');
select pg_temp.logout();
update public.businesses set status = 'active' where id = :'biz_a';

update public.profiles set is_active = false where id = :'a_owner';
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'dx@a.example.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '42501', null, 'a deactivated owner profile grants nothing');
select is((select count(*) from public.customer_invitations), 0::bigint, 'a deactivated owner profile reads no invitations');
select pg_temp.logout();
update public.profiles set is_active = true where id = :'a_owner';

-- direct writes stay impossible for owners; last-owner protection intact
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$insert into public.customer_invitations (business_id, email, display_name, role, expires_at, created_by) values (%L, 'di@a.example.invalid', 'X', 'BUSINESS_STAFF', now(), %L)$$, :'biz_a', :'a_owner'), '42501', null, 'owner cannot insert invitations directly');
select throws_ok($$update public.customer_invitations set status = 'accepted'$$, '42501', null, 'owner cannot update invitations directly');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'a_owner'), '55000', null, 'the last effective active owner still cannot be demoted (admin path unchanged)');
select pg_temp.logout();

select * from finish();
rollback;
