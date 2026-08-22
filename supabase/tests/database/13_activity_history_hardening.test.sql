-- Batch 3B-H proofs: history survives account removal; audit values keep
-- microsecond precision. Synthetic fixtures only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(37);

-- =====================================================================================
-- posture: only the actor FK is gone; everything else is intact
-- =====================================================================================
select is((select count(*) from pg_constraint where conrelid = 'public.lead_activities'::regclass and contype = 'f' and confrelid = 'public.profiles'::regclass), 0::bigint,
  'no foreign key from lead_activities.actor_id to profiles');
select ok((select exists (select 1 from pg_constraint where conname = 'fk_lead_activities_lead_same_business' and contype = 'f')), 'composite same-business lead FK still present');
select is((select count(*) from pg_constraint where conrelid = 'public.lead_activities'::regclass and contype = 'f'), 2::bigint, 'exactly two FKs remain (business, composite lead)');
select has_trigger('public', 'lead_activities', 'trg_lead_activities_append_only', 'append-only trigger still present');
select is((select count(*) from pg_policies where tablename = 'lead_activities'), 1::bigint, 'RLS policy set unchanged (one SELECT policy)');
select is((select bool_or(has_table_privilege('authenticated', 'public.lead_activities', p)) from unnest(array['INSERT','UPDATE','DELETE']) p), false, 'authenticated still has no write privilege');
select is((select prosecdef from pg_proc where oid = 'private.audit_lead_changes()'::regprocedure), true, 'audit function still SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'private.audit_lead_changes()'::regprocedure), 'audit function still pins an empty search_path');
select is(has_function_privilege('authenticated', 'private.audit_lead_changes()', 'EXECUTE'), false, 'audit function still not executable by authenticated');
select ok((select pg_get_functiondef('private.audit_lead_changes()'::regprocedure) like '%SS.US"Z"%'), 'audit function uses the microsecond UTC format');

-- =====================================================================================
-- F1: history survives profile removal (and auth-user cascade)
-- =====================================================================================
\set req1 '33333333-3333-4333-8333-333333333333'
select pg_temp.login_as(:'a_staff');
create temp table n1 as select * from public.add_lead_note(:'lead_a2', 'Staff note that must outlive the account.', :'req1');
update public.leads set status = 'contacted' where id = :'lead_a2';
select pg_temp.logout();
select is((select count(*) from public.lead_activities where actor_id = :'a_staff'), 2::bigint, 'setup: staff A authored a note and a status change');

-- delete the profile directly (FK action no longer touches the ledger)
delete from public.profiles where id = :'a_staff';
select is((select count(*) from public.profiles where id = :'a_staff'), 0::bigint, 'profile deletion succeeds');
select is((select count(*) from public.lead_activities where actor_id = :'a_staff'), 2::bigint, 'both activities still exist');
select is((select actor_id::text || '|' || actor_display_name || '|' || note from public.lead_activities where id = (select activity_id from n1)),
  :'a_staff' || '|Staff A (synthetic)|Staff note that must outlive the account.', 'historical actor UUID, name snapshot and note are unchanged');
select is((select old_value || '>' || new_value || '|' || actor_display_name from public.lead_activities where actor_id = :'a_staff' and activity_type = 'status_changed'),
  'new>contacted|Staff A (synthetic)', 'audit old/new values and actor snapshot unchanged');

-- the auth-user cascade path (manager): auth.users -> profiles -> memberships; ledger untouched
select pg_temp.login_as(:'a_manager');
create temp table n2 as select * from public.add_lead_note(:'lead_a3', 'Manager note.', '44444444-4444-4444-8444-444444444444');
select pg_temp.logout();
delete from auth.users where id = :'a_manager';
select is((select count(*) from public.profiles where id = :'a_manager'), 0::bigint, 'auth user deletion cascades through the profile');
select is((select actor_id::text || '|' || actor_display_name || '|' || note from public.lead_activities where id = (select activity_id from n2)),
  :'a_manager' || '|Manager A (synthetic)|Manager note.', 'activity authored by the removed account is intact');

-- visibility after removal
select pg_temp.login_as(:'a_owner');
select is((select count(*) from public.lead_activities where actor_id in (:'a_staff', :'a_manager')), 3::bigint, 'remaining active member still reads the history');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select is((select count(*) from public.lead_activities where actor_id in (:'a_staff', :'a_manager')), 3::bigint, 'platform admin still reads the history');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.lead_activities), 0::bigint, 'other businesses still read nothing');
select throws_ok($$delete from public.lead_activities$$, '42501', null, 'authenticated users still cannot delete activities');
select throws_ok($$update public.lead_activities set actor_id = null$$, '42501', null, 'authenticated users still cannot update activities');
select pg_temp.logout();

-- immutability for privileged roles is intact
select throws_ok(format($$update public.lead_activities set actor_id = %L$$, :'b_owner'), '23514', null, 'actor_id cannot be rewritten even by postgres');
select throws_ok($$update public.lead_activities set actor_display_name = 'x'$$, '23514', null, 'actor_display_name cannot be rewritten');
select throws_ok($$update public.lead_activities set note = 'x' where activity_type = 'note_added'$$, '23514', null, 'note text cannot be rewritten');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'status_changed', 'new', 'won')$$, :'biz_b', :'lead_a1'),
  '23503', null, 'same-business lead FK still enforced');

-- idempotency for active users unchanged
select pg_temp.login_as(:'a_owner');
create temp table o1 as select * from public.add_lead_note(:'lead_a3', 'Owner note', '55555555-5555-4555-8555-555555555555');
create temp table o2 as select * from public.add_lead_note(:'lead_a3', 'Owner note replay', '55555555-5555-4555-8555-555555555555');
select is((select replayed from o2) and (select activity_id from o1) = (select activity_id from o2), true, 'note replay still idempotent');
select pg_temp.logout();

-- =====================================================================================
-- F2: microsecond precision in follow-up audit values
-- =====================================================================================
select pg_temp.login_as(:'a_owner');
update public.leads set follow_up_at = '2032-01-01T14:00:00.100001Z' where id = :'lead_a1';
select is((select new_value from public.lead_activities where lead_id = :'lead_a1' and activity_type = 'follow_up_changed'),
  '2032-01-01T14:00:00.100001Z', 'setting from null records the full-precision value (old is null)');
select lives_ok(format($$update public.leads set follow_up_at = '2032-01-01T14:00:00.900009Z' where id = %L$$, :'lead_a1'),
  'a follow-up change within the same second now succeeds');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1' and activity_type = 'follow_up_changed'), 2::bigint, 'exactly one additional audit row');
select is((select old_value || '>' || new_value from public.lead_activities where lead_id = :'lead_a1' and activity_type = 'follow_up_changed' and old_value is not null),
  '2032-01-01T14:00:00.100001Z>2032-01-01T14:00:00.900009Z', 'both distinct full-precision values recorded');
select is((select follow_up_at from public.leads where id = :'lead_a1'), '2032-01-01T14:00:00.900009Z'::timestamptz, 'stored lead timestamp equals the requested value');
update public.leads set follow_up_at = '2032-01-01T14:00:00.900009Z' where id = :'lead_a1';   -- identical
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1' and activity_type = 'follow_up_changed'), 2::bigint, 'repeating the exact timestamp creates no activity');
update public.leads set follow_up_at = '2032-02-02T10:00:00Z' where id = :'lead_a1';
select is((select new_value from public.lead_activities where lead_id = :'lead_a1' and activity_type = 'follow_up_changed' and old_value = '2032-01-01T14:00:00.900009Z'),
  '2032-02-02T10:00:00.000000Z', 'whole-second values use the same fixed-width representation');
update public.leads set follow_up_at = null where id = :'lead_a1';
select is((select old_value from public.lead_activities where lead_id = :'lead_a1' and activity_type = 'follow_up_changed' and new_value is null),
  '2032-02-02T10:00:00.000000Z', 'clearing records the previous value and a null new value');
update public.leads set status = 'won', follow_up_at = '2032-03-03T09:30:15.123456Z' where id = :'lead_a1';
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1'
             and ((activity_type = 'status_changed' and new_value = 'won')
               or (activity_type = 'follow_up_changed' and old_value is null and new_value = '2032-03-03T09:30:15.123456Z'))),
  2::bigint, 'simultaneous status + fractional follow-up change yields both records');
select ok((select bool_and(v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$')
           from (select old_value v from public.lead_activities where activity_type = 'follow_up_changed' and old_value is not null
                 union all select new_value from public.lead_activities where activity_type = 'follow_up_changed' and new_value is not null) x),
  'every follow-up audit value is fixed-width microsecond UTC');
select pg_temp.logout();

select * from finish();
rollback;
