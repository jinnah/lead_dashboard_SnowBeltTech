-- Business status gates tenant access: members of a suspended or archived
-- business lose all tenant-scoped access; the platform admin keeps it.
-- Status changes are made as the privileged setup role; access is proven as
-- the `authenticated` role with JWT claims. Everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(33);

-- ---- active business: access present ----------------------------------------------
select is((select status from public.businesses where id = :'biz_a'), 'active', 'setup: Business A starts active');
select pg_temp.login_as(:'a_owner');
select set_eq('select * from private.active_business_ids()', array[:'biz_a'::uuid], 'active member of an active business receives that business id');
select is((select count(*) from public.businesses where id = :'biz_a'), 1::bigint, 'member reads the active business');
select is((select count(*) from public.leads where business_id = :'biz_a'), 3::bigint, 'member reads all 3 leads of the active business');
select pg_temp.logout();

-- ---- suspended ---------------------------------------------------------------------------
update public.businesses set status = 'suspended' where id = :'biz_a';
select is((select status from public.businesses where id = :'biz_a'), 'suspended', 'setup: Business A is suspended');

select pg_temp.login_as(:'a_owner');
select is(current_user, 'authenticated', 'owner A runs as authenticated');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'suspended: active_business_ids() returns nothing');
select is((select count(*) from public.businesses), 0::bigint, 'suspended: owner A sees zero businesses');
select is((select count(*) from public.leads), 0::bigint, 'suspended: owner A sees zero leads');
select is((select count(*) from public.business_memberships), 0::bigint, 'suspended: owner A sees zero memberships');
update public.leads set status = 'contacted' where id = :'lead_a1';
update public.leads set follow_up_at = '2032-01-01T00:00:00Z' where id = :'lead_a2';
update public.leads set status = 'spam';   -- unfiltered, must hit nothing
select set_eq('select id from public.profiles', array[:'a_owner'::uuid], 'suspended: owner A still sees exactly their own profile');
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_a1'), 'new', 'suspended: lead status update affected nothing');
select is((select follow_up_at from public.leads where id = :'lead_a2'), null, 'suspended: follow_up_at update affected nothing');
select is((select count(*) from public.leads where status = 'spam'), 0::bigint, 'suspended: unfiltered update affected nothing');

-- the other members of the suspended business are cut off too
select pg_temp.login_as(:'a_staff');
select is((select count(*) from public.leads), 0::bigint, 'suspended: staff A sees zero leads');
select is((select count(*) from public.businesses), 0::bigint, 'suspended: staff A sees zero businesses');
select pg_temp.logout();

-- Business B is unaffected
select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.leads), 2::bigint, 'suspended A: owner B still sees both Business B leads');
select pg_temp.logout();

-- platform admin continuity
select pg_temp.login_as(:'admin');
select is((select count(*) from public.businesses where id = :'biz_a'), 1::bigint, 'suspended: platform admin still sees Business A');
select is((select status from public.businesses where id = :'biz_a'), 'suspended', 'suspended: platform admin sees its suspended status');
select is((select count(*) from public.leads where business_id = :'biz_a'), 3::bigint, 'suspended: platform admin still sees all 3 Business A leads');
select is((select count(*) from public.business_memberships where business_id = :'biz_a'), 4::bigint, 'suspended: platform admin still sees Business A memberships');
select is((select count(*) from public.leads), 5::bigint, 'suspended: platform admin still sees all 5 leads overall');
select pg_temp.logout();

-- ---- archived ----------------------------------------------------------------------------
update public.businesses set status = 'archived' where id = :'biz_a';
select is((select status from public.businesses where id = :'biz_a'), 'archived', 'setup: Business A is archived');

select pg_temp.login_as(:'a_owner');
select is((select count(*) from private.active_business_ids()), 0::bigint, 'archived: active_business_ids() returns nothing');
select is((select count(*) from public.businesses), 0::bigint, 'archived: owner A sees zero businesses');
select is((select count(*) from public.leads), 0::bigint, 'archived: owner A sees zero leads');
select is((select count(*) from public.business_memberships), 0::bigint, 'archived: owner A sees zero memberships');
update public.leads set status = 'contacted' where id = :'lead_a1';
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_a1'), 'new', 'archived: lead status update affected nothing');

select pg_temp.login_as(:'admin');
select is((select count(*) from public.businesses where id = :'biz_a'), 1::bigint, 'archived: platform admin still sees Business A');
select is((select count(*) from public.leads where business_id = :'biz_a'), 3::bigint, 'archived: platform admin still sees its leads');
select pg_temp.logout();

-- ---- restoration -------------------------------------------------------------------------
update public.businesses set status = 'active' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select set_eq('select * from private.active_business_ids()', array[:'biz_a'::uuid], 'restored: active_business_ids() returns Business A again');
select is((select count(*) from public.leads), 3::bigint, 'restored: owner A sees all 3 leads again');
update public.leads set status = 'contacted' where id = :'lead_a1';
select is((select status from public.leads where id = :'lead_a1'), 'contacted', 'restored: owner A can update lead status again');
select pg_temp.logout();

select * from finish();
rollback;
