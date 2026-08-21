-- Platform administrator access via NORMAL authentication (authenticated role
-- + JWT sub). No service-role credential is used anywhere in these proofs.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(17);

select pg_temp.login_as(:'admin');
select is(current_user, 'authenticated', 'platform admin runs as the ordinary authenticated role');
select is((select private.is_platform_admin()), true, 'helper recognises the seeded platform admin');
select is((select count(*) from public.businesses), 2::bigint, 'platform admin sees both businesses');
select is((select count(*) from public.leads), 5::bigint, 'platform admin sees all 5 seeded leads');
select is((select count(distinct business_id) from public.leads), 2::bigint, 'platform admin leads span both businesses');
select is((select count(*) from public.profiles), 6::bigint, 'platform admin sees all profiles');
select is((select count(*) from public.business_memberships), 5::bigint, 'platform admin sees all memberships');
select is((select count(*) from public.integration_sources), 3::bigint, 'platform admin sees all integration sources');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'platform admin is not a business member (access is by role, not membership)');
select pg_temp.logout();

-- the SAME queries as a non-admin stay tenant-scoped
select pg_temp.login_as(:'b_owner');
select is((select private.is_platform_admin()), false, 'owner B is not a platform admin');
select is((select count(*) from public.businesses), 1::bigint, 'same businesses query as owner B returns 1');
select is((select count(*) from public.leads), 2::bigint, 'same leads query as owner B returns 2');
select is((select count(*) from public.integration_sources), 0::bigint, 'same integration_sources query as owner B returns 0');

-- a business user cannot grant themselves (or anyone) the platform role
select throws_ok(
  format($$update public.profiles set platform_role = 'PLATFORM_ADMIN' where id = %L$$, :'b_owner'),
  '42501', null, 'owner B cannot set their own platform_role (column privilege denied)');
select throws_ok(
  format($$update public.profiles set is_active = false where id = %L$$, :'b_owner'),
  '42501', null, 'owner B cannot change their own is_active');
select pg_temp.logout();

-- a deactivated platform admin loses admin access (profile is_active gate)
update public.profiles set is_active = false where id = :'admin';
select pg_temp.login_as(:'admin');
select is((select private.is_platform_admin()), false, 'inactive platform admin is no longer recognised');
select is((select count(*) from public.leads), 0::bigint, 'inactive platform admin sees no leads');
select pg_temp.logout();

select * from finish();
rollback;
