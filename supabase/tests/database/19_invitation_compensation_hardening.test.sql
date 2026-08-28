-- Batch 4B corrective hardening: delivery-failure Auth cleanup candidates and
-- archived-business membership non-operability. Synthetic fixtures; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(43);

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
-- The candidate REQUIRES the exact per-invitation provenance marker persisted
-- by inviteUserByEmail (user-metadata key portal_invitation_id = invitation
-- UUID). Email / temporal / profile / membership / binding checks remain as
-- defense in depth only.

-- F1: account created by THIS attempt (exact marker) -> returned and bound
select pg_temp.login_as(:'admin');
create temp table f1 as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-a@example.invalid', 'Cand A', 'BUSINESS_STAFF');
grant select on f1 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', :'ua', 'authenticated', 'authenticated', 'cand-a@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('portal_invitation_id', (select invitation_id from f1)::text), false, '', '', '', '', now(), now();
select pg_temp.login_as(:'admin');
create temp table r1 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f1));
select is((select status || '|' || cleanup_auth_user_id::text from r1), 'failed|' || :'ua', 'exact-marker stranded invite account is returned as the cleanup candidate');
select pg_temp.logout();
select is((select status || '|' || auth_user_id::text from public.customer_invitations where id = (select invitation_id from f1)), 'failed|' || :'ua', 'candidate UUID bound on the failed invitation');
select is((select count(*) from public.customer_access_events where invitation_id = (select invitation_id from f1) and event_type = 'invitation_failed'), 1::bigint, 'invitation_failed audited');

-- F1b: clean same-email account created AFTER the invitation but WITHOUT the
-- marker (the concurrent-signup race) -> never a candidate
select pg_temp.login_as(:'admin');
create temp table f1b as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-race@example.invalid', 'Cand Race', 'BUSINESS_STAFF');
grant select on f1b to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'cand-race@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb, false, '', '', '', '', now(), now();
select pg_temp.login_as(:'admin');
create temp table r1b as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f1b));
select is((select cleanup_auth_user_id from r1b), null, 'in-window same-email account WITHOUT the marker (concurrent signup) is never a candidate');
select pg_temp.logout();
select is((select count(*) from auth.users where id = 'e1000000-0000-4000-8000-00000000000b'), 1::bigint, 'the race account is untouched');

-- F1c: correct email and window but a DIFFERENT marker -> never a candidate
select pg_temp.login_as(:'admin');
create temp table f1c as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-other@example.invalid', 'Cand Other', 'BUSINESS_STAFF');
grant select on f1c to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'cand-other@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('portal_invitation_id', '00000000-0000-4000-8000-00000000dead'), false, '', '', '', '', now(), now();
select pg_temp.login_as(:'admin');
create temp table r1c as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f1c));
select is((select cleanup_auth_user_id from r1c), null, 'a different marker value is never a candidate');
select pg_temp.logout();

-- F2: correct marker but the account is OLDER than the invitation -> defensive temporal bound still excludes it
select pg_temp.login_as(:'admin');
create temp table f2 as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-b@example.invalid', 'Cand B', 'BUSINESS_STAFF');
grant select on f2 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cand-b@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('portal_invitation_id', (select invitation_id from f2)::text), false, '', '', '', '', now() - interval '1 hour', now();
select pg_temp.login_as(:'admin');
create temp table r2 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f2));
select is((select cleanup_auth_user_id from r2), null, 'an account older than the invitation is never a candidate even with the marker');
select pg_temp.logout();

-- F3: correct marker but the account has an application profile -> defensive exclusion holds
select pg_temp.login_as(:'admin');
create temp table f3 as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-c@example.invalid', 'Cand C', 'BUSINESS_STAFF');
grant select on f3 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', :'uc', 'authenticated', 'authenticated', 'cand-c@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('portal_invitation_id', (select invitation_id from f3)::text), false, '', '', '', '', now(), now();
insert into public.profiles (id, display_name, platform_role, is_active) values (:'uc', 'Cand C (established)', null, true);
select pg_temp.login_as(:'admin');
create temp table r3 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f3));
select is((select cleanup_auth_user_id from r3), null, 'an account with an application profile is never a candidate even with the marker');
select pg_temp.logout();

-- F4: correct marker but a DIFFERENT email -> defensive exclusion holds
select pg_temp.login_as(:'admin');
create temp table f4 as select * from public.admin_prepare_customer_invitation(:'biz_a', 'cand-d@example.invalid', 'Cand D', 'BUSINESS_STAFF');
grant select on f4 to public;
select pg_temp.logout();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', :'ud', 'authenticated', 'authenticated', 'unrelated-d@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('portal_invitation_id', (select invitation_id from f4)::text), false, '', '', '', '', now(), now();
select pg_temp.login_as(:'admin');
create temp table r4 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f4));
select is((select cleanup_auth_user_id from r4), null, 'a mismatched email is never a candidate even with the marker');
select throws_ok(format($$select * from public.admin_mark_customer_invitation_failed(%L)$$, (select invitation_id from f4)), '55000', null, 'a failed invitation cannot be failed again');
select pg_temp.logout();

-- F5: correct marker + email + window, but the account is bound to ANOTHER
-- invitation -> defensive exclusion holds (fixture-only rows: this shape is
-- unreachable through prepare, which rejects registered emails)
create temp table f5 (invitation_id uuid);
insert into f5 select gen_random_uuid();
grant select on f5 to public;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-00000000000f', 'authenticated', 'authenticated', 'cand-f@example.invalid', extensions.crypt('local-seed-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('portal_invitation_id', (select invitation_id from f5)::text), false, '', '', '', '', now(), now();
insert into public.customer_invitations (id, business_id, email, display_name, role, status, auth_user_id, sent_at, closed_at, expires_at, created_by)
values (gen_random_uuid(), :'biz_a', 'cand-f@example.invalid', 'Cand F old', 'BUSINESS_STAFF', 'revoked', 'e1000000-0000-4000-8000-00000000000f', now(), now(), now() + interval '1 hour', :'admin');
insert into public.customer_invitations (id, business_id, email, display_name, role, status, expires_at, created_by)
select invitation_id, :'biz_a', 'cand-f@example.invalid', 'Cand F', 'BUSINESS_STAFF', 'prepared', now() + interval '1 hour', :'admin' from f5;
select pg_temp.login_as(:'admin');
create temp table r5 as select * from public.admin_mark_customer_invitation_failed((select invitation_id from f5));
select is((select cleanup_auth_user_id from r5), null, 'an account bound to another invitation is never a candidate even with the marker');
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
