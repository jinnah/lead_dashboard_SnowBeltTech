-- Lead mutations as authenticated business users: allowed workflow updates,
-- cross-tenant attempts, and every system-managed field rejection.
-- Column grants are the primary control; the trigger layer is proven
-- independently by temporarily widening a grant inside this transaction.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(34);

-- ---- allowed updates -------------------------------------------------------------
select pg_temp.login_as(:'a_staff');
update public.leads set status = 'contacted' where id = :'lead_a1';
select is((select status from public.leads where id = :'lead_a1'), 'contacted', 'staff A updated status on a Business A lead');
update public.leads set follow_up_at = '2030-01-01T00:00:00Z' where id = :'lead_a2';
select is((select follow_up_at from public.leads where id = :'lead_a2'), '2030-01-01T00:00:00Z'::timestamptz, 'staff A set follow_up_at on a Business A lead');
update public.leads set status = 'qualified', follow_up_at = null where id = :'lead_a3';
select is((select status || '/' || coalesce(follow_up_at::text, 'null') from public.leads where id = :'lead_a3'), 'qualified/null', 'staff A updated both approved columns together');
select ok((select updated_at > created_at from public.leads where id = :'lead_a1'), 'updated_at advanced automatically');
select throws_ok($$update public.leads set status = 'bogus' where id = $$ || quote_literal(:'lead_a1'), '23514', null,
  'status is restricted to the allowed set');

-- ---- cross-tenant updates affect zero rows ---------------------------------------------------
update public.leads set status = 'spam' where id = :'lead_b1';
update public.leads set status = 'spam' where business_id = :'biz_b';
update public.leads set follow_up_at = '2031-01-01T00:00:00Z';   -- deliberately unfiltered
select is((select count(*) from public.leads where follow_up_at = '2031-01-01T00:00:00Z'), 3::bigint, 'an unfiltered update (as staff A) touched exactly the 3 visible Business A leads');
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_b1'), 'new', 'Business B lead status untouched by staff A (checked as postgres)');
select is((select count(*) from public.leads where business_id = :'biz_b' and status = 'spam'), 0::bigint, 'no Business B lead was updated by the business-wide attempt');
select is((select count(*) from public.leads where business_id = :'biz_b' and follow_up_at = '2031-01-01T00:00:00Z'), 0::bigint, 'the unfiltered update did not reach Business B');

-- ---- direct insert / delete rejected ----------------------------------------------------------------
select pg_temp.login_as(:'a_owner');
select throws_ok(
  format($$insert into public.leads (business_id, lead_number, source) values (%L, 'INQ-X-1', 'manual')$$, :'biz_a'),
  '42501', null, 'owner A cannot insert a lead directly, even into their own business');
select throws_ok(
  format($$delete from public.leads where id = %L$$, :'lead_a1'),
  '42501', null, 'owner A cannot delete a lead');
select throws_ok(
  format($$insert into public.businesses (name, slug, industry) values ('X', 'x-biz', 'other')$$),
  '42501', null, 'owner A cannot create a business');
select throws_ok(
  format($$insert into public.business_memberships (business_id, user_id, role) values (%L, %L, 'BUSINESS_STAFF')$$, :'biz_a', :'b_owner'),
  '42501', null, 'owner A cannot create a membership');
select throws_ok(
  format($$insert into public.integration_sources (business_id, kind, external_id) values (%L, 'website_form', 'x')$$, :'biz_a'),
  '42501', null, 'owner A cannot create an integration source');
select throws_ok(
  format($$delete from public.business_memberships where business_id = %L$$, :'biz_a'),
  '42501', null, 'owner A cannot delete memberships');

-- ---- system-managed lead fields: every one rejected at the grant layer ---------------------
select throws_ok(format($$update public.leads set business_id = %L where id = %L$$, :'biz_b', :'lead_a1'),     '42501', null, 'business_id change rejected');
select throws_ok(format($$update public.leads set id = gen_random_uuid() where id = %L$$, :'lead_a1'),          '42501', null, 'id change rejected');
select throws_ok(format($$update public.leads set lead_number = 'INQ-9999' where id = %L$$, :'lead_a1'),        '42501', null, 'lead_number change rejected');
select throws_ok(format($$update public.leads set source = 'manual' where id = %L$$, :'lead_a1'),               '42501', null, 'source change rejected');
select throws_ok(format($$update public.leads set source_event_id = 'other' where id = %L$$, :'lead_a1'),       '42501', null, 'source_event_id change rejected');
select throws_ok(format($$update public.leads set email = 'x@example.invalid' where id = %L$$, :'lead_a1'),     '42501', null, 'contact evidence (email) change rejected');
select throws_ok(format($$update public.leads set sms_consent = false where id = %L$$, :'lead_a1'),             '42501', null, 'consent flag change rejected');
select throws_ok(format($$update public.leads set sms_consent_text = 'x' where id = %L$$, :'lead_a1'),          '42501', null, 'consent text change rejected');
select throws_ok(format($$update public.leads set sms_consent_at = now() where id = %L$$, :'lead_a1'),          '42501', null, 'consent timestamp change rejected');
select throws_ok(format($$update public.leads set call_id = 'x' where id = %L$$, :'lead_a2'),                   '42501', null, 'voice evidence (call_id) change rejected');
select throws_ok(format($$update public.leads set call_classification = 'spam' where id = %L$$, :'lead_a2'),    '42501', null, 'voice evidence (classification) change rejected');
select throws_ok(format($$update public.leads set created_at = now() where id = %L$$, :'lead_a1'),              '42501', null, 'created_at change rejected');
select throws_ok(format($$update public.leads set assigned_to = %L where id = %L$$, :'a_owner', :'lead_a1'),    '42501', null, 'assigned_to change rejected (deferred to server-side ops)');
select throws_ok(format($$update public.leads set archived_at = now() where id = %L$$, :'lead_a1'),             '42501', null, 'archived_at change rejected (deferred to server-side ops)');
select throws_ok(format($$update public.leads set custom_fields = '{}' where id = %L$$, :'lead_a1'),            '42501', null, 'custom_fields change rejected in Batch 1');
select pg_temp.logout();

-- ---- trigger layer proven independently of grants -------------------------------------------
-- Temporarily widen the grant (rolled back with the transaction) and show the
-- protect_system_fields trigger still refuses the change for business users.
grant update (lead_number, business_id) on public.leads to authenticated;
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$update public.leads set lead_number = 'INQ-HACK' where id = %L$$, :'lead_a1'),
  '42501', null, 'with the grant widened, the trigger still blocks lead_number for business users');
select throws_ok(format($$update public.leads set business_id = %L where id = %L$$, :'biz_b', :'lead_a1'),
  '23514', null, 'with the grant widened, moving a lead to another business still fails (identity trigger fires before RLS WITH CHECK)');
select pg_temp.logout();

-- ---- universal tenant-key immutability, even for a privileged (bypassrls) role --------------
select throws_ok(format($$update public.leads set business_id = %L where id = %L$$, :'biz_b', :'lead_a1'),
  '23514', null, 'business_id is immutable even for postgres (identity trigger)');
select throws_ok(format($$update public.business_memberships set business_id = %L where user_id = %L$$, :'biz_b', :'a_owner'),
  '23514', null, 'membership business_id is immutable even for postgres');

select * from finish();
rollback;
