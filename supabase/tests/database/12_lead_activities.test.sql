-- Lead activity ledger: posture, automatic audit of status/follow-up changes,
-- and the idempotent note RPC — proven as authenticated/anon with JWT claims.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(73);

-- =====================================================================================
-- posture
-- =====================================================================================
select has_table('public', 'lead_activities', 'lead_activities exists');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.lead_activities'::regclass), 'RLS enabled+forced');
select is((select count(*) from pg_policies where tablename = 'lead_activities'), 1::bigint, 'exactly one policy');
select is((select cmd || ':' || array_to_string(roles, ',') from pg_policies where tablename = 'lead_activities'), 'SELECT:authenticated', 'the policy is SELECT for authenticated only');
select is((select count(*) from pg_policies where schemaname = 'public' and cmd in ('DELETE', 'ALL', 'INSERT')), 0::bigint, 'still no INSERT/DELETE/ALL policies anywhere');
select is((select bool_or(has_table_privilege('anon', 'public.lead_activities', p)) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p)
          or (select bool_or(has_any_column_privilege('anon', 'public.lead_activities', p)) from unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p), false, 'anon has no privilege');
select is((select bool_or(has_table_privilege('authenticated', 'public.lead_activities', p)) from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p)
          or (select bool_or(has_any_column_privilege('authenticated', 'public.lead_activities', p)) from unnest(array['INSERT','UPDATE','REFERENCES']) p), false, 'authenticated has no write privilege');
select is(has_table_privilege('authenticated', 'public.lead_activities', 'SELECT'), true, 'authenticated may SELECT (rows via RLS)');
select ok((select exists (select 1 from pg_constraint where conname = 'fk_lead_activities_lead_same_business' and contype = 'f')), 'composite FK enforces same-business lead');
select has_trigger('public', 'leads', 'trg_zz_leads_audit_changes', 'audit trigger on leads');
select has_trigger('public', 'lead_activities', 'trg_lead_activities_append_only', 'append-only trigger');
select is((select prosecdef from pg_proc where oid = 'private.audit_lead_changes()'::regprocedure), true, 'audit function is SECURITY DEFINER');
select is((select prosecdef from pg_proc where oid = 'public.add_lead_note(uuid,text,uuid)'::regprocedure), true, 'add_lead_note is SECURITY DEFINER');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('private', 'public') and not exists (select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))), 0::bigint,
  'every private/public function pins an empty search_path');
select is(has_function_privilege('anon', 'public.add_lead_note(uuid,text,uuid)', 'EXECUTE'), false, 'anon cannot execute add_lead_note');
select is(has_function_privilege('public', 'public.add_lead_note(uuid,text,uuid)', 'EXECUTE'), false, 'PUBLIC cannot execute add_lead_note');
select is(has_function_privilege('authenticated', 'public.add_lead_note(uuid,text,uuid)', 'EXECUTE'), true, 'authenticated can execute add_lead_note');
select is(has_function_privilege('authenticated', 'private.audit_lead_changes()', 'EXECUTE'), false, 'authenticated cannot execute the audit function directly');
select set_eq($$select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'$$,
  array['ingest_lead_event', 'add_lead_note'], 'public schema exposes exactly the two reviewed RPCs');

-- =====================================================================================
-- automatic audit of status / follow-up (authenticated member)
-- =====================================================================================
select pg_temp.login_as(:'a_staff');
update public.leads set status = 'contacted' where id = :'lead_a1';
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1'), 1::bigint, 'status change created exactly one activity');
select is((select activity_type || '|' || old_value || '|' || new_value || '|' || actor_id::text || '|' || actor_display_name from public.lead_activities where lead_id = :'lead_a1'),
  'status_changed|new|contacted|' || :'a_staff' || '|Staff A (synthetic)', 'activity records type, old/new, actor from auth.uid() and name snapshot');
update public.leads set status = 'contacted' where id = :'lead_a1';   -- no-op
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1'), 1::bigint, 'no-op status update created no activity');
update public.leads set follow_up_at = '2026-09-01T14:00:00Z' where id = :'lead_a1';
select is((select old_value is null and new_value = '2026-09-01T14:00:00Z' from public.lead_activities where lead_id = :'lead_a1' and activity_type = 'follow_up_changed'), true, 'follow-up set is audited with ISO UTC values');
update public.leads set follow_up_at = null where id = :'lead_a1';
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1' and activity_type = 'follow_up_changed' and new_value is null), 1::bigint, 'clearing follow-up is audited');
update public.leads set status = 'qualified', follow_up_at = '2026-09-02T09:00:00Z' where id = :'lead_a1';
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1'
             and ((activity_type = 'status_changed' and old_value = 'contacted' and new_value = 'qualified')
               or (activity_type = 'follow_up_changed' and old_value is null and new_value = '2026-09-02T09:00:00Z'))),
  2::bigint, 'changing both fields produces one deterministic record per field');
select is((select count(*) from public.lead_activities), 5::bigint, 'staff A reads the 5 activities of its business');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'status_changed', 'new', 'won')$$, :'biz_a', :'lead_a1'), '42501', null, 'customer cannot fabricate an activity directly');
select throws_ok($$update public.lead_activities set new_value = 'won'$$, '42501', null, 'customer cannot update activities');
select throws_ok($$delete from public.lead_activities$$, '42501', null, 'customer cannot delete activities');
select throws_ok(format($$select * from public.add_lead_note(%L, 'x', gen_random_uuid())$$, :'lead_b1'), 'P0002', null, 'note on a foreign lead is an opaque not-found');
select pg_temp.logout();

-- other members of the same business read the same history; B sees none
select pg_temp.login_as(:'a_owner');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1'), 5::bigint, 'owner A reads the same activities');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.lead_activities), 0::bigint, 'owner B sees no Business A activities');
update public.leads set status = 'spam' where id = :'lead_a1';
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_a1'), 'qualified', 'owner B could not change a Business A lead');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a1'), 5::bigint, 'and no audit row was created for it');

-- =====================================================================================
-- immutability (privileged role: only constraints/triggers answer)
-- =====================================================================================
select throws_ok($$update public.lead_activities set new_value = 'x' where activity_type = 'status_changed'$$, '23514', null, 'activities cannot be updated even by privileged roles');
select throws_ok(format($$update public.lead_activities set business_id = %L$$, :'biz_b'), '23514', null, 'tenant key immutable');
select throws_ok(format($$update public.lead_activities set actor_id = %L$$, :'b_owner'), '23514', null, 'actor immutable');
select throws_ok($$update public.lead_activities set created_at = now()$$, '23514', null, 'created_at immutable');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'status_changed', 'new', 'won')$$, :'biz_b', :'lead_a1'), '23503', null, 'an activity cannot reference a lead of another business (composite FK)');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'status_changed', 'new', 'new')$$, :'biz_a', :'lead_a1'), '23514', null, 'a change record must carry a genuine difference');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, note) values (%L, %L, 'note_added', 'no request id')$$, :'biz_a', :'lead_a1'), '23514', null, 'a note record needs a request id');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, note, request_id, old_value) values (%L, %L, 'note_added', 'x', gen_random_uuid(), 'new')$$, :'biz_a', :'lead_a1'), '23514', null, 'a note cannot carry change values (no masquerading)');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, note, request_id) values (%L, %L, 'note_added', %L, gen_random_uuid())$$, :'biz_a', :'lead_a1', repeat('x', 2001)), '23514', null, 'notes over 2000 characters are rejected at the database');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'assigned', 'a', 'b')$$, :'biz_a', :'lead_a1'), '23514', null, 'unknown activity types are rejected');
select throws_ok(format($$update public.leads set business_id = %L where id = %L$$, :'biz_b', :'lead_a1'), '23514', null, 'lead tenant key still immutable');

-- =====================================================================================
-- revocation: no mutation and no audit rows
-- =====================================================================================
update public.business_memberships set status = 'inactive' where user_id = :'a_manager';
select pg_temp.login_as(:'a_manager');
update public.leads set status = 'won' where id = :'lead_a2';
select throws_ok(format($$select * from public.add_lead_note(%L, 'x', gen_random_uuid())$$, :'lead_a2'), 'P0002', null, 'inactive membership cannot add a note');
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_a2') || '|' || (select count(*) from public.lead_activities where lead_id = :'lead_a2')::text, 'new|0', 'inactive membership changed nothing and audited nothing');
update public.business_memberships set status = 'active' where user_id = :'a_manager';
update public.profiles set is_active = false where id = :'a_manager';
select pg_temp.login_as(:'a_manager');
update public.leads set status = 'won' where id = :'lead_a2';
select throws_ok(format($$select * from public.add_lead_note(%L, 'x', gen_random_uuid())$$, :'lead_a2'), 'P0002', null, 'inactive profile cannot add a note');
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_a2') || '|' || (select count(*) from public.lead_activities where lead_id = :'lead_a2')::text, 'new|0', 'inactive profile changed nothing');
update public.profiles set is_active = true where id = :'a_manager';
update public.businesses set status = 'suspended' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
update public.leads set status = 'won' where id = :'lead_a2';
select is((select count(*) from public.lead_activities), 0::bigint, 'suspended business: owner reads no activities');
select throws_ok(format($$select * from public.add_lead_note(%L, 'x', gen_random_uuid())$$, :'lead_a2'), 'P0002', null, 'suspended business cannot add a note');
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_a2'), 'new', 'suspended business changed nothing');
update public.businesses set status = 'active' where id = :'biz_a';

-- =====================================================================================
-- notes via the RPC
-- =====================================================================================
\set req1 '11111111-1111-4111-8111-111111111111'
select pg_temp.login_as(:'a_owner');
create temp table n1 as select * from public.add_lead_note(:'lead_a2', '  Called back, left voicemail.  ', :'req1');
select is((select replayed from n1), false, 'first note is not a replay');
select is((select note || '|' || actor_id::text || '|' || actor_display_name from public.lead_activities where id = (select activity_id from n1)),
  'Called back, left voicemail.|' || :'a_owner' || '|Owner A (synthetic)', 'note trimmed, actor from auth.uid(), name snapshot');
create temp table n2 as select * from public.add_lead_note(:'lead_a2', 'DIFFERENT TEXT same request id', :'req1');
select is((select replayed from n2), true, 'same request id is a replay');
select is((select activity_id from n2), (select activity_id from n1), 'replay returns the existing activity');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'note_added'), 1::bigint, 'replay created no second note');
select is((select note from public.lead_activities where id = (select activity_id from n1)), 'Called back, left voicemail.', 'original note text unchanged by the replay');
select lives_ok(format($$select * from public.add_lead_note(%L, 'Second note', gen_random_uuid())$$, :'lead_a2'), 'a different request id creates another note');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'note_added'), 2::bigint, 'two notes now');
select throws_ok(format($$select * from public.add_lead_note(%L, '   ', gen_random_uuid())$$, :'lead_a2'), '22023', null, 'blank note rejected');
select throws_ok(format($$select * from public.add_lead_note(%L, %L, gen_random_uuid())$$, :'lead_a2', repeat('y', 2001)), '22023', null, 'oversized note rejected by the RPC');
select throws_ok(format($$select * from public.add_lead_note(%L, 'x', null)$$, :'lead_a2'), '22023', null, 'missing request id rejected');
select throws_ok($$select * from public.add_lead_note('00000000-0000-4000-8000-00000000dead', 'x', gen_random_uuid())$$, 'P0002', null, 'nonexistent lead is an opaque not-found');
select pg_temp.logout();
select pg_temp.login_as(:'a_staff');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'note_added'), 2::bigint, 'staff A reads the owner''s notes');
select lives_ok(format($$select * from public.add_lead_note(%L, 'Staff note', gen_random_uuid())$$, :'lead_a2'), 'staff can add notes');
select pg_temp.logout();
select pg_temp.login_as(:'a_manager');
select lives_ok(format($$select * from public.add_lead_note(%L, 'Manager note', gen_random_uuid())$$, :'lead_a2'), 'manager can add notes');
select pg_temp.logout();
select pg_temp.login_as(:'b_owner');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2'), 0::bigint, 'owner B cannot read Business A notes');
select throws_ok(format($$select * from public.add_lead_note(%L, 'intrusion', gen_random_uuid())$$, :'lead_a2'), 'P0002', null, 'owner B cannot add a note to a Business A lead');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'note_added'), 4::bigint, 'platform admin reads customer notes through RLS');
select is((select count(distinct business_id) from public.lead_activities), 1::bigint, 'platform admin sees activities across businesses (only A has any so far)');
update public.leads set status = 'won' where id = :'lead_a2';
select throws_ok(format($$select * from public.add_lead_note(%L, 'admin note', gen_random_uuid())$$, :'lead_a2'), 'P0002', null, 'platform admin is read-only: cannot add notes');
select pg_temp.logout();
select is((select status from public.leads where id = :'lead_a2'), 'new', 'platform admin could not change lead status (read-only policy)');

select * from finish();
rollback;
