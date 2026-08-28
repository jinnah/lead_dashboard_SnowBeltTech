-- Batch 4B: invitation-only customer provisioning and membership management.
-- Proven as real database personas; synthetic fixtures only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(125);

-- Synthetic invited auth users X (owner) and Y (staff) are inserted LATER, at the
-- moment the real flow would create them (after preparation, before mark-sent),
-- because admin_prepare_customer_invitation rejects already-registered emails.
\set inv_x 'c1000000-0000-4000-8000-000000000001'
\set inv_y 'c1000000-0000-4000-8000-000000000002'

-- =====================================================================================
-- posture: tables
-- =====================================================================================
select has_table('public', 'customer_invitations', 'customer_invitations exists');
select has_table('public', 'customer_access_events', 'customer_access_events exists');
select is((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('public.customer_invitations'::regclass, 'public.customer_access_events'::regclass)), true, 'RLS enabled AND forced on both tables');
select is((select count(*) from pg_policies where tablename in ('customer_invitations', 'customer_access_events')), 2::bigint, 'exactly one policy per table');
select is((select bool_and(cmd = 'SELECT' and roles = '{authenticated}') from pg_policies where tablename in ('customer_invitations', 'customer_access_events')), true, 'both policies are SELECT for authenticated only');
select is((select bool_or(has_table_privilege('authenticated', t, p)) from unnest(array['public.customer_invitations', 'public.customer_access_events']) t, unnest(array['INSERT', 'UPDATE', 'DELETE']) p), false, 'authenticated has no direct writes on invitations or events');
select is((select bool_or(has_table_privilege('anon', t, p)) from unnest(array['public.customer_invitations', 'public.customer_access_events']) t, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p), false, 'anon has nothing');
select has_trigger('public', 'customer_invitations', 'trg_customer_invitations_protect', 'invitations protect trigger');
select has_trigger('public', 'customer_access_events', 'trg_customer_access_events_append_only', 'events append-only trigger');
select is((select count(*) from pg_constraint where conrelid in ('public.customer_invitations'::regclass, 'public.customer_access_events'::regclass) and contype = 'f' and confrelid = 'public.profiles'::regclass), 0::bigint, 'no FK to profiles: history survives account removal');
select has_index('public', 'customer_invitations', 'uq_customer_invitations_live_email', 'live-email uniqueness index');
select ok((select indisunique from pg_index where indexrelid = 'public.uq_customer_invitations_live_email'::regclass), 'live-email index is unique');
select has_index('public', 'customer_invitations', 'ix_customer_invitations_business_created', 'invitation business index');
select has_index('public', 'customer_access_events', 'ix_customer_access_events_business_created', 'events business index');

-- =====================================================================================
-- posture: the seven RPCs
-- =====================================================================================
create temp table inv_fns (sig text) on commit drop;
insert into inv_fns values
  ('public.admin_prepare_customer_invitation(uuid,text,text,text)'),
  ('public.admin_mark_customer_invitation_sent(uuid,uuid)'),
  ('public.admin_mark_customer_invitation_failed(uuid)'),
  ('public.admin_revoke_customer_invitation(uuid,uuid)'),
  ('public.accept_customer_invitation()'),
  ('public.admin_set_business_member_role(uuid,uuid,text)'),
  ('public.admin_set_business_member_status(uuid,uuid,text)');
select is((select count(*) from inv_fns where to_regprocedure(sig) is null), 0::bigint, 'all seven RPCs exist with the expected signatures');
select is((select bool_and((select prosecdef from pg_proc where oid = sig::regprocedure)) from inv_fns), true, 'all seven are SECURITY DEFINER');
select is((select bool_and((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = sig::regprocedure)) from inv_fns), true, 'all seven pin an empty search_path');
select is((select bool_and((select pg_get_userbyid(proowner) from pg_proc where oid = sig::regprocedure) = 'postgres') from inv_fns), true, 'all seven owned by postgres');
select is((select bool_and((select provolatile from pg_proc where oid = sig::regprocedure) = 'v') from inv_fns), true, 'all seven explicitly VOLATILE');
select is((select bool_or(has_function_privilege('anon', sig, 'EXECUTE') or has_function_privilege('public', sig, 'EXECUTE')) from inv_fns), false, 'anon and PUBLIC cannot execute any of them');
select is((select bool_and(has_function_privilege('authenticated', sig, 'EXECUTE')) from inv_fns), true, 'authenticated can execute (authorization inside)');
select is(pg_get_function_result('public.admin_prepare_customer_invitation(uuid,text,text,text)'::regprocedure), 'TABLE(invitation_id uuid)', 'prepare returns only the invitation id');
select is(pg_get_function_result('public.accept_customer_invitation()'::regprocedure), 'TABLE(business_id uuid, replayed boolean)', 'accept returns business id + replay flag');
select is(pg_get_function_result('public.admin_revoke_customer_invitation(uuid,uuid)'::regprocedure), 'TABLE(auth_user_id uuid, changed boolean)', 'revoke returns the bound auth user + changed');

-- =====================================================================================
-- administrator authorization (fail closed)
-- =====================================================================================
create temp table cb as select * from public.admin_create_business('x','x','hvac','UTC') where false;
drop table cb;
select pg_temp.login_anon();
select throws_ok($$select * from public.admin_prepare_customer_invitation('a0000000-0000-4000-8000-000000000001', 'x@y.invalid', 'X', 'BUSINESS_STAFF')$$, '42501', null, 'anon cannot prepare invitations');
select throws_ok($$select * from public.accept_customer_invitation()$$, '42501', null, 'anon cannot accept');
select pg_temp.logout();
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'x@y.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '42501', null, 'business owner cannot invite');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'business owner cannot change member roles');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'a_staff'), '42501', null, 'business owner cannot change membership status');
select throws_ok($$insert into public.customer_invitations (business_id, email, display_name, role, expires_at, created_by) values ('a0000000-0000-4000-8000-000000000001', 'x@y.invalid', 'X', 'BUSINESS_STAFF', now(), 'a1000000-0000-4000-8000-000000000001')$$, '42501', null, 'customer cannot insert invitations directly');
select is((select count(*) from public.customer_invitations), 0::bigint, 'customer reads no invitation rows');
select is((select count(*) from public.customer_access_events), 0::bigint, 'customer reads no access events');
select pg_temp.logout();
select pg_temp.login_as(:'a_staff');
select throws_ok(format($$select * from public.admin_revoke_customer_invitation(%L, '00000000-0000-4000-8000-00000000dead')$$, :'biz_a'), '42501', null, 'staff cannot revoke');
select pg_temp.logout();
update public.profiles set is_active = false where id = :'admin';
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'x@y.invalid', 'X', 'BUSINESS_STAFF')$$, :'biz_a'), '42501', null, 'inactive administrator refused');
select pg_temp.logout();
update public.profiles set is_active = true where id = :'admin';

-- =====================================================================================
-- invitation validation (fresh unprovisioned business "india")
-- =====================================================================================
select pg_temp.login_as(:'admin');
create temp table ib as select * from public.admin_create_business('India Landscaping (synthetic)', 'india-landscaping', 'landscaping', 'UTC');
grant select on ib to public;
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'india-staff@example.invalid', 'India Staff', 'BUSINESS_STAFF')$$, (select business_id from ib)), '22023', null, 'first member must be a business owner');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'not-an-email', 'X', 'BUSINESS_OWNER')$$, (select business_id from ib)), '22023', null, 'malformed email rejected');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, '   ', 'X', 'BUSINESS_OWNER')$$, (select business_id from ib)), '22023', null, 'whitespace email rejected');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, %L, 'X', 'BUSINESS_OWNER')$$, (select business_id from ib), repeat('x', 315) || '@e.invalid'), '22023', null, 'overlong email rejected');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'a b@e.invalid', 'X', 'BUSINESS_OWNER')$$, (select business_id from ib)), '22023', null, 'email with spaces rejected');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'x@e.invalid', '', 'BUSINESS_OWNER')$$, (select business_id from ib)), '22023', null, 'empty display name rejected');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'x@e.invalid', %L, 'BUSINESS_OWNER')$$, (select business_id from ib), repeat('n', 101)), '22023', null, 'overlong display name rejected');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'x@e.invalid', 'X', 'PLATFORM_ADMIN')$$, (select business_id from ib)), '22023', null, 'PLATFORM_ADMIN is never an invitation role');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'x@e.invalid', 'X', 'OWNER')$$, (select business_id from ib)), '22023', null, 'unknown role rejected');
select throws_ok($$select * from public.admin_prepare_customer_invitation('00000000-0000-4000-8000-00000000dead', 'x@e.invalid', 'X', 'BUSINESS_OWNER')$$, 'P0002', null, 'unknown business rejected');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'owner-a@example.invalid', 'X', 'BUSINESS_OWNER')$$, (select business_id from ib)), '22023', null, 'existing auth email rejected');
create temp table i1 as select * from public.admin_prepare_customer_invitation((select business_id from ib), '  India-Owner@Example.INVALID  ', '  India Owner  ', 'BUSINESS_OWNER');
grant select on i1 to public;
select is((select i.email || '|' || i.display_name || '|' || i.role || '|' || i.status || '|' || i.created_by::text || '|' || i.created_by_display_name from public.customer_invitations i where i.id = (select invitation_id from i1)),
  'india-owner@example.invalid|India Owner|BUSINESS_OWNER|prepared|' || :'admin' || '|Platform Admin (synthetic)', 'invitation stored normalized with the administrator snapshot');
select is((select e.event_type || '|' || e.actor_id::text || '|' || coalesce(e.target_user_id::text, '-') from public.customer_access_events e where e.invitation_id = (select invitation_id from i1)), 'invitation_prepared|' || :'admin' || '|-', 'invitation_prepared audited');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'INDIA-OWNER@example.invalid', 'Dup', 'BUSINESS_OWNER')$$, (select business_id from ib)), '23505', null, 'duplicate live invitation rejected (case-normalized)');
select lives_ok(format($$select * from public.admin_set_business_status(%L, 'suspended')$$, (select business_id from ib)), 'setup: suspend india');
select throws_ok(format($$select * from public.admin_prepare_customer_invitation(%L, 'x2@e.invalid', 'X', 'BUSINESS_OWNER')$$, (select business_id from ib)), '55000', null, 'suspended business cannot receive invitations');
select lives_ok(format($$select * from public.admin_set_business_status(%L, 'active')$$, (select business_id from ib)), 'setup: reactivate india');
select pg_temp.logout();

-- =====================================================================================
-- transitions: prepared -> sent (verified binding), failed, revoked
-- =====================================================================================
-- the invited Auth account for X now exists (as inviteUserByEmail would create it)
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'inv_x', 'authenticated', 'authenticated', 'india-owner@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_mark_customer_invitation_sent(%L, '00000000-0000-4000-8000-00000000dead')$$, (select invitation_id from i1)), '22023', null, 'unknown auth user cannot be bound');
select throws_ok(format($$select * from public.admin_mark_customer_invitation_sent(%L, %L)$$, (select invitation_id from i1), :'a_staff'), '22023', null, 'auth user with a different email cannot be bound');
select throws_ok(format($$select * from public.admin_mark_customer_invitation_failed('00000000-0000-4000-8000-00000000dead')$$), 'P0002', null, 'unknown invitation cannot be failed');
create temp table s1 as select * from public.admin_mark_customer_invitation_sent((select invitation_id from i1), :'inv_x');
select is((select status from s1), 'sent', 'prepared -> sent');
select is((select i.auth_user_id::text || '|' || (i.sent_at is not null)::text from public.customer_invitations i where i.id = (select invitation_id from i1)), :'inv_x' || '|true', 'auth user bound with sent time');
select is((select count(*) from public.customer_access_events where invitation_id = (select invitation_id from i1) and event_type = 'invitation_sent' and target_user_id = :'inv_x'), 1::bigint, 'invitation_sent audited with the target user');
select throws_ok(format($$select * from public.admin_mark_customer_invitation_sent(%L, %L)$$, (select invitation_id from i1), :'inv_x'), '55000', null, 'sent cannot be marked sent again');
select throws_ok(format($$select * from public.admin_mark_customer_invitation_failed(%L)$$, (select invitation_id from i1)), '55000', null, 'sent cannot be marked failed');
-- a second prepared invitation demonstrates prepared -> failed
-- (an owner invitation: india has no effective owner yet, so staff would be refused)
create temp table i2 as select * from public.admin_prepare_customer_invitation((select business_id from ib), 'india-second@example.invalid', 'India Second', 'BUSINESS_OWNER');
grant select on i2 to public;
create temp table f1 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from i2));
select is((select status from f1), 'failed', 'prepared -> failed');
select is((select count(*) from public.customer_access_events where invitation_id = (select invitation_id from i2) and event_type = 'invitation_failed'), 1::bigint, 'invitation_failed audited');
select throws_ok(format($$select * from public.admin_revoke_customer_invitation(%L, %L)$$, (select business_id from ib), (select invitation_id from i2)), '55000', null, 'failed invitation is not revocable');
select pg_temp.logout();

-- =====================================================================================
-- acceptance: bound user only, atomic profile + membership, idempotent replay
-- =====================================================================================
select pg_temp.login_as(:'a_staff');
select throws_ok($$select * from public.accept_customer_invitation()$$, 'P0002', null, 'a different authenticated user cannot accept (opaque)');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select throws_ok($$select * from public.accept_customer_invitation()$$, 'P0002', null, 'a platform administrator can never accept');
select pg_temp.logout();
-- expired invitations are refused before any state change
update public.customer_invitations set expires_at = now() - interval '1 minute' where id = (select invitation_id from i1);
select pg_temp.login_as(:'inv_x');
select throws_ok($$select * from public.accept_customer_invitation()$$, 'P0002', null, 'expired invitation refused');
select pg_temp.logout();
update public.customer_invitations set expires_at = now() + interval '1 hour' where id = (select invitation_id from i1);
select pg_temp.login_as(:'inv_x');
create temp table acc1 as select * from public.accept_customer_invitation();
select is((select business_id = (select business_id from ib) and not replayed from acc1), true, 'acceptance lands in the invited business');
select is((select p.display_name || '|' || coalesce(p.platform_role, '-') || '|' || p.is_active::text from public.profiles p where p.id = :'inv_x'), 'India Owner|-|true', 'profile created with the invitation display name and NO platform role');
select is((select m.role || '|' || m.status from public.business_memberships m where m.user_id = :'inv_x' and m.business_id = (select business_id from ib)), 'BUSINESS_OWNER|active', 'active owner membership created');
create temp table acc2 as select * from public.accept_customer_invitation();
select is((select replayed from acc2), true, 'replay is idempotent');
select set_eq('select * from private.active_business_ids()', array[(select business_id from ib)], 'accepted owner has exactly the invited business');
select pg_temp.logout();
-- invitation/event state asserted OUTSIDE the invitee session (RLS hides these rows from customers)
select is((select i.status || '|' || (i.accepted_at is not null)::text from public.customer_invitations i where i.id = (select invitation_id from i1)), 'accepted|true', 'invitation accepted');
select is((select count(*) from public.customer_access_events where invitation_id = (select invitation_id from i1) and event_type = 'invitation_accepted' and target_user_id = :'inv_x' and actor_id = :'inv_x'), 1::bigint, 'invitation_accepted audited with the accepting user as actor and target');
select is((select count(*) from public.business_memberships where user_id = :'inv_x'), 1::bigint, 'no duplicate membership on replay');
select is((select count(*) from public.customer_access_events where event_type = 'invitation_accepted'), 1::bigint, 'no duplicate event on replay');
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_revoke_customer_invitation(%L, %L)$$, (select business_id from ib), (select invitation_id from i1)), '55000', null, 'accepted invitation cannot be revoked');
select pg_temp.logout();

-- =====================================================================================
-- revocation and suspended-business acceptance (second invitee Y)
-- =====================================================================================
select pg_temp.login_as(:'admin');
create temp table i3 as select * from public.admin_prepare_customer_invitation((select business_id from ib), 'india-staff@example.invalid', 'India Staff', 'BUSINESS_STAFF');
grant select on i3 to public;
select pg_temp.logout();
-- Y's Auth account is created at delivery time, exactly like the real flow (privileged fixture)
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'inv_y', 'authenticated', 'authenticated', 'india-staff@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());
select pg_temp.login_as(:'admin');
create temp table s3 as select * from public.admin_mark_customer_invitation_sent((select invitation_id from i3), :'inv_y');
create temp table r1 as select * from public.admin_revoke_customer_invitation((select business_id from ib), (select invitation_id from i3));
select is((select auth_user_id = :'inv_y'::uuid and changed from r1), true, 'revocation returns the bound auth user for cleanup');
select is((select count(*) from public.customer_access_events where invitation_id = (select invitation_id from i3) and event_type = 'invitation_revoked'), 1::bigint, 'invitation_revoked audited');
create temp table r2 as select * from public.admin_revoke_customer_invitation((select business_id from ib), (select invitation_id from i3));
select is((select changed from r2), false, 'repeated revocation is a safe no-op');
select is((select count(*) from public.customer_access_events where invitation_id = (select invitation_id from i3)), 3::bigint, 'no duplicate event (prepared + sent + revoked only)');
select throws_ok(format($$select * from public.admin_revoke_customer_invitation(%L, %L)$$, :'biz_a', (select invitation_id from i3)), 'P0002', null, 'wrong business cannot revoke (opaque)');
select pg_temp.logout();
select pg_temp.login_as(:'inv_y');
select throws_ok($$select * from public.accept_customer_invitation()$$, 'P0002', null, 'revoked invitation cannot be accepted');
select pg_temp.logout();
select is((select count(*) from public.business_memberships where user_id = :'inv_y'), 0::bigint, 'revocation left no membership');
-- the revoked invitation's unaccepted Auth account is removed (as the trusted route does)
delete from auth.users where id = :'inv_y';
-- suspended business blocks acceptance of a live invitation
select pg_temp.login_as(:'admin');
create temp table i4 as select * from public.admin_prepare_customer_invitation((select business_id from ib), 'india-staff@example.invalid', 'India Staff', 'BUSINESS_STAFF');
grant select on i4 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'inv_y', 'authenticated', 'authenticated', 'india-staff@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());
select pg_temp.login_as(:'admin');
create temp table s4 as select * from public.admin_mark_customer_invitation_sent((select invitation_id from i4), :'inv_y');
create temp table sb as select * from public.admin_set_business_status((select business_id from ib), 'suspended');
select pg_temp.logout();
select pg_temp.login_as(:'inv_y');
select throws_ok($$select * from public.accept_customer_invitation()$$, 'P0002', null, 'suspended business blocks acceptance');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
create temp table sb2 as select * from public.admin_set_business_status((select business_id from ib), 'active');
select pg_temp.logout();
select pg_temp.login_as(:'inv_y');
create temp table acc3 as select * from public.accept_customer_invitation();
select is((select not replayed from acc3), true, 'reactivated business permits acceptance');
select is((select m.role || '|' || m.status from public.business_memberships m where m.user_id = :'inv_y'), 'BUSINESS_STAFF|active', 'staff membership created from the invitation role');
select pg_temp.logout();

-- =====================================================================================
-- membership management + last-owner protection
-- =====================================================================================
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, (select business_id from ib), :'inv_x'), '55000', null, 'the last active owner cannot be demoted');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, (select business_id from ib), :'inv_x'), '55000', null, 'the last active owner cannot be deactivated');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'SUPER_OWNER')$$, (select business_id from ib), :'inv_y'), '22023', null, 'unknown role rejected');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'suspended')$$, (select business_id from ib), :'inv_y'), '22023', null, 'unknown status rejected');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'inv_x'), 'P0002', null, 'cross-business mismatch rejected');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, '00000000-0000-4000-8000-00000000dead', 'BUSINESS_STAFF')$$, (select business_id from ib)), 'P0002', null, 'unknown member rejected');
-- platform administrators are never manageable targets (fixture membership inserted as postgres)
select pg_temp.logout();
insert into public.business_memberships (business_id, user_id, role, status) values (:'biz_a', :'admin', 'BUSINESS_OWNER', 'active');
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'admin'), 'P0002', null, 'platform-admin target rejected (role)');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'admin'), 'P0002', null, 'platform-admin target rejected (status)');
select pg_temp.logout();
delete from public.business_memberships where user_id = :'admin';
select pg_temp.login_as(:'admin');
-- promote Y to owner, then X can be demoted; audit rows carry old/new values
create temp table pr1 as select * from public.admin_set_business_member_role((select business_id from ib), :'inv_y', 'BUSINESS_OWNER');
select is((select changed from pr1), true, 'second member promoted to owner');
create temp table pr2 as select * from public.admin_set_business_member_role((select business_id from ib), :'inv_x', 'BUSINESS_MANAGER');
select is((select changed from pr2), true, 'former owner demoted after promotion');
select is((select old_value || '>' || new_value from public.customer_access_events where event_type = 'membership_role_changed' and target_user_id = :'inv_x'), 'BUSINESS_OWNER>BUSINESS_MANAGER', 'role change audited with old/new');
create temp table pr3 as select * from public.admin_set_business_member_role((select business_id from ib), :'inv_x', 'BUSINESS_MANAGER');
select is((select changed from pr3), false, 'repeating the current role is a no-op');
select is((select count(*) from public.customer_access_events where event_type = 'membership_role_changed'), 2::bigint, 'no audit row for the role no-op');
create temp table st1 as select * from public.admin_set_business_member_status((select business_id from ib), :'inv_x', 'inactive');
select is((select changed from st1), true, 'membership deactivated');
select is((select old_value || '>' || new_value from public.customer_access_events where event_type = 'membership_status_changed' and target_user_id = :'inv_x'), 'active>inactive', 'status change audited');
select pg_temp.logout();
select pg_temp.login_as(:'inv_x');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'deactivated membership revokes tenant access immediately');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
create temp table st2 as select * from public.admin_set_business_member_status((select business_id from ib), :'inv_x', 'active');
select is((select changed from st2), true, 'membership reactivated');
create temp table st3 as select * from public.admin_set_business_member_status((select business_id from ib), :'inv_x', 'active');
select is((select changed from st3), false, 'repeating the current status is a no-op');
select is((select count(*) from public.customer_access_events where event_type = 'membership_status_changed'), 2::bigint, 'no audit row for the status no-op');
-- Y is now the only active owner: protected in turn
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, (select business_id from ib), :'inv_y'), '55000', null, 'protection follows the current owner');
select pg_temp.logout();
select pg_temp.login_as(:'inv_x');
select set_eq('select * from private.active_business_ids()', array[(select business_id from ib)], 'reactivated member has tenant access again');
select pg_temp.logout();

-- =====================================================================================
-- ledger immutability, no-email guarantee, survival of account removal
-- =====================================================================================
select pg_temp.login_as(:'admin');
select ok((select count(*) > 0 from public.customer_access_events), 'administrator reads the access ledger');
select throws_ok(format($$insert into public.customer_access_events (business_id, invitation_id, actor_id, event_type) values (%L, %L, %L, 'invitation_prepared')$$, (select business_id from ib), (select invitation_id from i1), :'admin'), '42501', null, 'administrator cannot insert events directly');
select throws_ok($$update public.customer_access_events set new_value = 'BUSINESS_STAFF'$$, '42501', null, 'administrator cannot update events');
select throws_ok($$delete from public.customer_access_events$$, '42501', null, 'administrator cannot delete events');
select throws_ok($$update public.customer_invitations set status = 'accepted'$$, '42501', null, 'administrator cannot update invitations directly');
select throws_ok($$delete from public.customer_invitations$$, '42501', null, 'administrator cannot delete invitations');
select pg_temp.logout();
select throws_ok($$update public.customer_access_events set new_value = 'BUSINESS_STAFF' where event_type = 'membership_role_changed'$$, '23514', null, 'events immutable even for postgres');
select is((select count(*) from public.customer_access_events where old_value like '%@%' or new_value like '%@%' or actor_display_name like '%@%'), 0::bigint, 'no email address anywhere in the event ledger');
select throws_ok(format($$insert into public.customer_access_events (business_id, actor_id, event_type, old_value, new_value) values (%L, %L, 'membership_role_changed', 'BUSINESS_OWNER', 'BUSINESS_OWNER')$$, (select business_id from ib), :'admin'), '23514', null, 'shape: role change needs a genuine difference');
select throws_ok(format($$insert into public.customer_access_events (business_id, actor_id, event_type) values (%L, %L, 'password_changed')$$, (select business_id from ib), :'admin'), '23514', null, 'unknown event type rejected');
-- account removal keeps history
delete from public.profiles where id = :'inv_x';
delete from auth.users where id = :'inv_x';
select is((select count(*) from public.customer_access_events where target_user_id = :'inv_x'), 5::bigint, 'events keep the historical target UUID after profile and auth-user removal (sent, accepted, role change, two status changes)');
select is((select i.auth_user_id::text from public.customer_invitations i where i.id = (select invitation_id from i1)), :'inv_x', 'invitation keeps the historical auth user id');
select is((select count(*) from public.customer_invitations where status = 'accepted'), 2::bigint, 'accepted invitation history preserved');

-- =====================================================================================
-- existing guarantees unchanged
-- =====================================================================================
select pg_temp.login_as(:'admin');
update public.leads set status = 'contacted' where id = :'lead_a1';
select is((select status from public.leads where id = :'lead_a1'), 'new', 'administrator lead access remains read-only');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.businesses where id = (select business_id from ib)), 0::bigint, 'foreign tenant cannot see the new business');
select is((select count(*) from public.customer_invitations), 0::bigint, 'foreign tenant reads no invitations');
select pg_temp.logout();
select pg_temp.login_service();
select lives_ok($$select * from public.ingest_lead_event('website_form', 'site-alpha-synthetic', 'evt-inv-test-1', '{"contact_name": "Synthetic"}')$$, 'ingestion unchanged');
select pg_temp.logout();
-- create one real lead activity so the immutability trigger actually fires
select pg_temp.login_as(:'a_owner');
update public.leads set status = 'contacted' where id = :'lead_a1';
select pg_temp.logout();
select throws_ok($$update public.lead_activities set new_value = 'x'$$, '23514', null, 'lead history remains immutable');
select throws_ok($$update public.platform_admin_events set new_value = 'x'$$, '23514', null, 'platform-operation history remains immutable');

select * from finish();
rollback;
