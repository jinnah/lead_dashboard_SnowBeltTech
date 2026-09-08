begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select no_plan();

select is((select prosecdef from pg_proc where oid = 'public.admin_begin_customer_invitation_reissue(uuid,uuid)'::regprocedure), true, 'reissue is a justified definer boundary');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.admin_begin_customer_invitation_reissue(uuid,uuid)'::regprocedure), 'postgres', 'trusted owner');
select ok((select proconfig @> array['search_path=""'] or proconfig @> array['search_path='] from pg_proc where oid = 'public.admin_begin_customer_invitation_reissue(uuid,uuid)'::regprocedure), 'empty search path');
select is(has_function_privilege('public', 'public.admin_begin_customer_invitation_reissue(uuid,uuid)', 'EXECUTE'), false, 'PUBLIC revoked');
select is(has_function_privilege('anon', 'public.admin_begin_customer_invitation_reissue(uuid,uuid)', 'EXECUTE'), false, 'anon revoked');
select is(has_function_privilege('service_role', 'public.admin_begin_customer_invitation_reissue(uuid,uuid)', 'EXECUTE'), false, 'service role not used');
select is(has_function_privilege('authenticated', 'public.admin_begin_customer_invitation_reissue(uuid,uuid)', 'EXECUTE'), true, 'session caller only');
select is(has_table_privilege('authenticated', 'public.customer_invitations', 'UPDATE'), false, 'no direct writes');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.customer_invitations'::regclass), 'forced RLS preserved');
select is((select count(*) from pg_policies where schemaname = 'public'), 13::bigint, 'policy inventory preserved');

-- Fixture creation only is privileged. Every mutation under test uses the
-- ordinary authenticated role and JWT persona. No credential/token fixtures.
create function pg_temp.reissue_fixture(p_role text default 'BUSINESS_STAFF', p_status text default 'sent', p_age interval default interval '1 hour')
returns uuid language plpgsql as $$
declare i uuid := gen_random_uuid(); u uuid := gen_random_uuid(); e text := i::text || '@reissue.example.invalid';
begin
  insert into auth.users (id, email, created_at, raw_user_meta_data)
    values (u, e, now(), jsonb_build_object('portal_invitation_id', i::text));
  insert into public.customer_invitations (id, business_id, email, display_name, role, status, auth_user_id, sent_at, accepted_at, closed_at, expires_at, created_by)
    values (i, 'a0000000-0000-4000-8000-000000000001', e, 'Reissue Synthetic', p_role, p_status,
      case when p_status <> 'prepared' then u end,
      case when p_status <> 'prepared' then now() - p_age end,
      case when p_status = 'accepted' then now() end,
      case when p_status in ('failed','revoked') then now() end,
      now() - interval '1 second', '10000000-0000-4000-8000-000000000001');
  return i;
end;
$$;
create temp table fixtures (label text primary key, id uuid);
insert into fixtures values ('eligible', pg_temp.reissue_fixture()), ('owner', pg_temp.reissue_fixture('BUSINESS_OWNER')),
  ('manager', pg_temp.reissue_fixture('BUSINESS_MANAGER')), ('recent', pg_temp.reissue_fixture('BUSINESS_STAFF', 'sent', interval '4 minutes')),
  ('prepared', pg_temp.reissue_fixture('BUSINESS_STAFF','prepared')), ('accepted', pg_temp.reissue_fixture('BUSINESS_STAFF','accepted')),
  ('failed', pg_temp.reissue_fixture('BUSINESS_STAFF','failed')), ('revoked', pg_temp.reissue_fixture('BUSINESS_STAFF','revoked')),
  ('mismatch', pg_temp.reissue_fixture()), ('profiled', pg_temp.reissue_fixture()), ('missing', pg_temp.reissue_fixture());
grant select on fixtures to public;

select pg_temp.login_as(:'a_manager');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002','invitation not available','manager denied');
select pg_temp.logout();
select pg_temp.login_as(:'a_staff');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002','invitation not available','staff denied');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002','invitation not available','foreign owner denied opaquely');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000dead')$$,'P0002','invitation not available','unknown byte-identical');
select pg_temp.logout();
select pg_temp.login_anon();
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',null)$$,'42501',null,'anonymous denied');
select pg_temp.logout();

update public.business_memberships set status='inactive' where user_id=:'a_owner';
select pg_temp.login_as(:'a_owner');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002',null,'inactive owner denied');
select pg_temp.logout();
update public.business_memberships set status='active' where user_id=:'a_owner';
update public.profiles set is_active=false where id=:'a_owner';
select pg_temp.login_as(:'a_owner');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002',null,'deactivated owner denied');
select pg_temp.logout();
update public.profiles set is_active=true where id=:'a_owner';
update public.profiles set is_active=false where id=:'admin';
select pg_temp.login_as(:'admin');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002',null,'deactivated admin denied');
select pg_temp.logout();
update public.profiles set is_active=true where id=:'admin';
update public.businesses set status='suspended' where id=:'biz_a';
select pg_temp.login_as(:'a_owner');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002',null,'suspended owner denied');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002',null,'admin cannot reissue for suspended business');
select pg_temp.logout();
update public.businesses set status='archived' where id=:'biz_a';
select pg_temp.login_as(:'a_owner');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002',null,'archived owner denied');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002',null,'archived admin denied');
select pg_temp.logout();
update public.businesses set status='active' where id=:'biz_a';

select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.admin_begin_customer_invitation_reissue(%L,%L)$$, :'biz_a', id),'P0002',null,'ineligible: ' || label)
  from fixtures where label in ('owner','prepared','accepted','failed','revoked','recent');
create temp table claimed as select * from public.admin_begin_customer_invitation_reissue(:'biz_a', (select id from fixtures where label='eligible'));
select is((select role from claimed),'BUSINESS_STAFF','authorized role returned from record');
select is((select display_name from claimed),'Reissue Synthetic','authorized name returned');
select is((select cleanup_auth_user_id from claimed),(select auth_user_id from public.customer_invitations where id=(select id from fixtures where label='eligible')),'exact old account only');
select is((select status from public.customer_invitations where id=(select id from fixtures where label='eligible')),'revoked','old invitation revoked before returning');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='eligible'))$$,'P0002',null,'repeat cannot claim it twice');
select lives_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='manager'))$$,'owner can reissue Manager');
select pg_temp.logout();
select is((select count(*) from public.customer_access_events where invitation_id=(select id from fixtures where label='eligible') and event_type='invitation_reissue_requested'),1::bigint,'reissue audited once');
select throws_ok($$update public.customer_access_events set actor_display_name='Changed' where event_type='invitation_reissue_requested'$$,'23514',null,'new audit type immutable');
select pg_temp.login_as((select auth_user_id from public.customer_invitations where id=(select id from fixtures where label='eligible')));
select throws_ok($$select * from public.accept_customer_invitation()$$,'P0002',null,'old account cannot accept after reissue claim');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select lives_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='owner'))$$,'admin may reissue Owner');
select pg_temp.logout();

update auth.users set raw_user_meta_data='{}' where id=(select auth_user_id from public.customer_invitations where id=(select id from fixtures where label='mismatch'));
insert into public.profiles (id, display_name, is_active)
  select auth_user_id,'Deactivated Synthetic',false from public.customer_invitations where id=(select id from fixtures where label='profiled');
delete from auth.users where id=(select auth_user_id from public.customer_invitations where id=(select id from fixtures where label='missing'));
select pg_temp.login_as(:'a_owner');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='mismatch'))$$,'P0002',null,'missing exact provenance denied');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='profiled'))$$,'P0002',null,'profile-deactivated target never deleted');
select is((select cleanup_auth_user_id from public.admin_begin_customer_invitation_reissue(:'biz_a',(select id from fixtures where label='missing'))),null,'absent old Auth identity needs no cleanup');
select pg_temp.logout();
select is((select count(*) from public.customer_invitations where id in (select id from fixtures where label in ('mismatch','profiled')) and status='sent'),2::bigint,'unsafe cleanup changes nothing');
update auth.users set raw_user_meta_data=jsonb_build_object('portal_invitation_id','00000000-0000-4000-8000-00000000dead') where id=(select auth_user_id from public.customer_invitations where id=(select id from fixtures where label='mismatch'));
select pg_temp.login_as(:'admin');
select throws_ok($$select * from public.admin_begin_customer_invitation_reissue('a0000000-0000-4000-8000-000000000001',(select id from fixtures where label='mismatch'))$$,'P0002',null,'different exact marker denied even for administrator');
select pg_temp.logout();
select * from finish();
rollback;
