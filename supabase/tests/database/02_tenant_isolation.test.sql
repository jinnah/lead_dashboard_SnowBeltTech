-- Tenant isolation, proven as the `authenticated` / `anon` database roles with
-- JWT claims — never as postgres, the table owner, or service_role.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(38);

-- ---- anonymous: nothing -----------------------------------------------------
select pg_temp.login_anon();
select is(current_user, 'anon', 'running as anon');
select throws_ok('select count(*) from public.leads',                '42501', null, 'anon cannot select leads');
select throws_ok('select count(*) from public.businesses',           '42501', null, 'anon cannot select businesses');
select throws_ok('select count(*) from public.profiles',             '42501', null, 'anon cannot select profiles');
select throws_ok('select count(*) from public.business_memberships', '42501', null, 'anon cannot select memberships');
select throws_ok('select count(*) from public.integration_sources',  '42501', null, 'anon cannot select integration_sources');
select throws_ok(format($$insert into public.leads (business_id, lead_number, source) values (%L, 'INQ-ANON-1', 'manual')$$, :'biz_a'), '42501', null, 'anon cannot insert leads');
select throws_ok($$update public.leads set status = 'spam'$$, '42501', null, 'anon cannot update leads');
select throws_ok($$delete from public.leads$$, '42501', null, 'anon cannot delete leads');
select throws_ok('select private.is_platform_admin()', '42501', null, 'anon cannot call security helpers');
select pg_temp.logout();

-- ---- Business A: every ACTIVE member sees ALL of A's leads, none of B's ----------
select pg_temp.login_as(:'a_owner');
select is(current_user, 'authenticated', 'running as authenticated (owner A)');
select is((select count(*) from public.leads), 3::bigint, 'owner A sees all 3 Business A leads');
select is((select count(*) from public.leads where business_id = :'biz_b'), 0::bigint, 'owner A sees zero Business B leads');
select is((select count(*) from public.businesses), 1::bigint, 'owner A sees exactly one business');
select is((select id from public.businesses), :'biz_a'::uuid, 'owner A sees Business A only');
select pg_temp.logout();

select pg_temp.login_as(:'a_manager');
select is((select count(*) from public.leads), 3::bigint, 'manager A sees all 3 Business A leads');
select is((select count(*) from public.leads where business_id = :'biz_b'), 0::bigint, 'manager A sees zero Business B leads');
select pg_temp.logout();

select pg_temp.login_as(:'a_staff');
select is((select count(*) from public.leads), 3::bigint, 'staff A sees all 3 Business A leads (not restricted to assigned)');
select is((select count(*) from public.leads where assigned_to is not null), 1::bigint, 'staff A sees the lead assigned to someone else');
select is((select count(*) from public.leads where assigned_to is null), 2::bigint, 'staff A sees the unassigned leads too');
select is((select count(*) from public.leads where business_id = :'biz_b'), 0::bigint, 'staff A sees zero Business B leads');
select is((select count(*) from public.leads where id = :'lead_b1'), 0::bigint, 'staff A cannot fetch a Business B lead by primary key');
select pg_temp.logout();

-- ---- Business B --------------------------------------------------------------
select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.leads), 2::bigint, 'owner B sees both Business B leads');
select is((select count(*) from public.leads where business_id = :'biz_a'), 0::bigint, 'owner B sees zero Business A leads');
select is((select count(*) from public.businesses where id = :'biz_a'), 0::bigint, 'owner B cannot see Business A');
select pg_temp.logout();

-- ---- inactive membership: no access ---------------------------------------------
select pg_temp.login_as(:'a_former');
select is((select count(*) from public.leads), 0::bigint, 'former staff (inactive membership) sees no leads');
select is((select count(*) from public.businesses), 0::bigint, 'former staff sees no businesses');
select is((select count(*) from public.business_memberships), 0::bigint, 'former staff sees no memberships');
select is((select count(*) from public.profiles), 1::bigint, 'former staff sees only their own profile');
select pg_temp.logout();

-- ---- profiles / memberships do not leak across tenants -----------------------------
select pg_temp.login_as(:'a_staff');
select set_eq(
  'select id from public.profiles',
  array[:'a_owner'::uuid, :'a_manager'::uuid, :'a_staff'::uuid, :'a_former'::uuid],
  'staff A sees exactly the Business A member profiles (incl. inactive member, excl. B and platform admin)');
select is((select count(*) from public.profiles where id = :'b_owner'), 0::bigint, 'staff A cannot see owner B profile');
select is((select count(*) from public.profiles where id = :'admin'), 0::bigint, 'staff A cannot see the platform admin profile');
select is((select count(*) from public.business_memberships), 4::bigint, 'staff A sees the 4 Business A memberships');
select is((select count(*) from public.business_memberships where business_id = :'biz_b'), 0::bigint, 'staff A sees no Business B memberships');
select is((select count(*) from public.profiles where platform_role is not null), 0::bigint, 'no platform-admin identity is visible to a business user');
select pg_temp.logout();

-- ---- integration_sources are invisible to business users -----------------------------
select pg_temp.login_as(:'a_owner');
select is((select count(*) from public.integration_sources), 0::bigint, 'owner A sees no integration sources (even their own) in Batch 1');
select pg_temp.logout();

-- ---- an inactive PROFILE with an active membership also loses access -----------------
update public.profiles set is_active = false where id = :'a_manager';
select pg_temp.login_as(:'a_manager');
select is((select count(*) from public.leads), 0::bigint, 'deactivated profile sees no leads despite an active membership row');
select is((select count(*) from public.businesses), 0::bigint, 'deactivated profile sees no businesses');
select pg_temp.logout();

select * from finish();
rollback;
