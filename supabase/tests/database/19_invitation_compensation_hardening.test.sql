-- Batch 4B corrective hardening: delivery-failure Auth cleanup candidates and
-- archived-business membership non-operability. Synthetic fixtures; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(39);

\set ua 'e1000000-0000-4000-8000-000000000001'
\set uc 'e1000000-0000-4000-8000-000000000003'
\set ud 'e1000000-0000-4000-8000-000000000004'

-- =====================================================================================
-- posture: the extended failed RPC and the replaced member RPCs
-- =====================================================================================
select is(pg_get_function_result('public.admin_mark_customer_invitation_failed(uuid)'::regprocedure),
  'TABLE(invitation_id uuid, status text, cleanup_auth_user_id uuid)', 'failed RPC returns the cleanup candidate');
create temp table hard_fns (sig text) on commit drop;
insert into hard_fns values
  ('public.admin_mark_customer_invitation_failed(uuid)'),
  ('public.admin_set_business_member_role(uuid,uuid,text)'),
  ('public.admin_set_business_member_status(uuid,uuid,text)');
select is((select bool_and((select prosecdef from pg_proc where oid = sig::regprocedure)) from hard_fns), true, 'all three SECURITY DEFINER');
select is((select bool_and((select provolatile from pg_proc where oid = sig::regprocedure) = 'v') from hard_fns), true, 'all three VOLATILE');
select is((select bool_and((select pg_get_userbyid(proowner) from pg_proc where oid = sig::regprocedure) = 'postgres') from hard_fns), true, 'all three owned by postgres');
select is((select bool_and((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = sig::regprocedure)) from hard_fns), true, 'all three pin an empty search_path');
select is((select bool_or(has_function_privilege('anon', sig, 'EXECUTE') or has_function_privilege('public', sig, 'EXECUTE')) from hard_fns), false, 'anon and PUBLIC cannot execute');
select is((select bool_and(has_function_privilege('authenticated', sig, 'EXECUTE')) from hard_fns), true, 'authenticated can execute');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'), 14::bigint, 'public RPC inventory unchanged (14)');
select is((select count(*) from pg_policies where schemaname = 'public'), 12::bigint, 'policy inventory unchanged (12)');
select is(pg_get_function_result('public.admin_set_business_member_role(uuid,uuid,text)'::regprocedure), 'TABLE(user_id uuid, role text, changed boolean)', 'member role return contract unchanged');
select is(pg_get_function_result('public.admin_set_business_member_status(uuid,uuid,text)'::regprocedure), 'TABLE(user_id uuid, status text, changed boolean)', 'member status return contract unchanged');

-- =====================================================================================
-- delivery-failure cleanup candidate: exact and fail-closed
-- =====================================================================================
-- F1: the account created by THIS attempt -> candidate returned and bound
select pg_temp.login_as(:'admin');
create temp table f1 as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-a@example.invalid', 'Cand A', 'BUSINESS_STAFF');
grant select on f1 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'ua', 'authenticated', 'authenticated', 'cand-a@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());
select pg_temp.login_as(:'admin');
create temp table r1 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f1));
select is((select status || '|' || cleanup_auth_user_id::text from r1), 'failed|' || :'ua', 'freshly created matching account is returned as the cleanup candidate');
select pg_temp.logout();
select is((select status || '|' || auth_user_id::text from public.customer_invitations where id = (select invitation_id from f1)), 'failed|' || :'ua', 'candidate UUID bound on the failed invitation');
select is((select count(*) from public.customer_access_events where invitation_id = (select invitation_id from f1) and event_type = 'invitation_failed'), 1::bigint, 'invitation_failed audited');

-- F2: an account OLDER than the invitation is never a candidate
select pg_temp.login_as(:'admin');
create temp table f2 as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-b@example.invalid', 'Cand B', 'BUSINESS_STAFF');
grant select on f2 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cand-b@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now() - interval '1 hour', now());
select pg_temp.login_as(:'admin');
create temp table r2 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f2));
select is((select cleanup_auth_user_id from r2), null, 'pre-existing account (older than the invitation) is never a candidate');
select pg_temp.logout();

-- F3: an account with a profile (an established user) is never a candidate
select pg_temp.login_as(:'admin');
create temp table f3 as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-c@example.invalid', 'Cand C', 'BUSINESS_STAFF');
grant select on f3 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'uc', 'authenticated', 'authenticated', 'cand-c@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());
insert into public.profiles (id, display_name, platform_role, is_active) values (:'uc', 'Cand C (established)', null, true);
select pg_temp.login_as(:'admin');
create temp table r3 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f3));
select is((select cleanup_auth_user_id from r3), null, 'an account with an application profile is never a candidate');
select pg_temp.logout();

-- F4: a different email is never a candidate
select pg_temp.login_as(:'admin');
create temp table f4 as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-d@example.invalid', 'Cand D', 'BUSINESS_STAFF');
grant select on f4 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'ud', 'authenticated', 'authenticated', 'unrelated-d@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());
select pg_temp.login_as(:'admin');
create temp table r4 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f4));
select is((select cleanup_auth_user_id from r4), null, 'a mismatched email is never a candidate');
select throws_ok(format($$select * from public.admin_mark_customer_invitation_failed(%L)$$, (select invitation_id from f4)), '55000', null, 'a failed invitation cannot be failed again');
select pg_temp.logout();

-- the failed invitation grants nothing, and history survives Auth cleanup
select pg_temp.login_as(:'ua');
select throws_ok($$select * from public.accept_customer_invitation()$$, 'P0002', null, 'the bound account still cannot accept the failed invitation');
select pg_temp.logout();
delete from auth.users where id = :'ua';   -- the server-side Auth cleanup the coordinator performs
select is((select status || '|' || auth_user_id::text from public.customer_invitations where id = (select invitation_id from f1)), 'failed|' || :'ua', 'failed invitation keeps the historical UUID after Auth cleanup');
select is((select count(*) from public.customer_access_events where invitation_id = (select invitation_id from f1)), 2::bigint, 'prepared + failed events intact after Auth cleanup');
select pg_temp.login_as(:'admin');
select lives_ok($$select * from public.admin_prepare_customer_invitation('a0000000-0000-4000-8000-000000000001', 'cand-a@example.invalid', 'Cand A again', 'BUSINESS_STAFF')$$, 'the email is reinvitable after cleanup (no live invitation, no registered account)');
select pg_temp.logout();

-- =====================================================================================
-- archived businesses: membership management is non-operable at the database boundary
-- =====================================================================================
create temp table ev_before as select count(*) as n from public.customer_access_events;
update public.businesses set status = 'archived' where id = :'biz_a';
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '55000', null, 'archived business: role change rejected with 55000');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'a_staff'), '55000', null, 'archived business: status change rejected with 55000');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'a_staff'), '55000', null, 'archived business: even a would-be no-op is rejected');
select pg_temp.logout();
select is((select role || '|' || status from public.business_memberships where user_id = :'a_staff'), 'BUSINESS_STAFF|active', 'membership row unchanged');
select is((select count(*) from public.customer_access_events), (select n from ev_before), 'no access event from rejected archived operations');

-- suspended businesses: membership administration still works
update public.businesses set status = 'suspended' where id = :'biz_a';
select pg_temp.login_as(:'admin');
create temp table s1 as select * from public.admin_set_business_member_role(:'biz_a', :'a_staff', 'BUSINESS_MANAGER');
select is((select changed from s1), true, 'suspended business: role change still works');
create temp table s2 as select * from public.admin_set_business_member_status(:'biz_a', :'a_staff', 'inactive');
select is((select changed from s2), true, 'suspended business: status change still works');
create temp table s3 as select * from public.admin_set_business_member_status(:'biz_a', :'a_staff', 'active');
create temp table s4 as select * from public.admin_set_business_member_role(:'biz_a', :'a_staff', 'BUSINESS_STAFF');
select is((select changed from s3) and (select changed from s4), true, 'suspended business: restored to the seeded values');
select pg_temp.logout();
select is((select count(*) from public.customer_access_events) - (select n from ev_before), 4::bigint, 'the four real suspended-business changes were audited');

-- active businesses: unchanged behavior incl. no-ops, last-owner and target rules
update public.businesses set status = 'active' where id = :'biz_a';
select pg_temp.login_as(:'admin');
create temp table a1 as select * from public.admin_set_business_member_role(:'biz_a', :'a_staff', 'BUSINESS_STAFF');
select is((select changed from a1), false, 'active business: same-role no-op still reports changed=false');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'a_owner'), '55000', null, 'last active owner still cannot be demoted');
select throws_ok(format($$select * from public.admin_set_business_member_status(%L, %L, 'inactive')$$, :'biz_a', :'a_owner'), '55000', null, 'last active owner still cannot be deactivated');
select throws_ok(format($$select * from public.admin_set_business_member_role('00000000-0000-4000-8000-00000000dead', %L, 'BUSINESS_STAFF')$$, :'a_staff'), 'P0002', null, 'unknown business stays opaque (P0002)');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'b_owner'), 'P0002', null, 'cross-business mismatch stays opaque');
select pg_temp.logout();
select pg_temp.logout();
insert into public.business_memberships (business_id, user_id, role, status) values (:'biz_a', :'admin', 'BUSINESS_OWNER', 'active');
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'admin'), 'P0002', null, 'platform-admin target still rejected');
select pg_temp.logout();
delete from public.business_memberships where user_id = :'admin';
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_set_business_member_role(%L, %L, 'BUSINESS_MANAGER')$$, :'biz_a', :'a_staff'), '42501', null, 'customer callers remain denied');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
update public.leads set status = 'contacted' where id = :'lead_a1';
select is((select status from public.leads where id = :'lead_a1'), 'new', 'administrator lead access remains read-only');
select pg_temp.logout();

select * from finish();
rollback;
