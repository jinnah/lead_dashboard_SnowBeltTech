-- Batch 3C: audited lead assignment. Proven as authenticated/anon personas;
-- synthetic fixtures only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/personas.psql
select plan(66);

-- =====================================================================================
-- posture
-- =====================================================================================
select has_function('public', 'set_lead_assignee', array['uuid', 'uuid'], 'set_lead_assignee(uuid, uuid) exists');
select is((select pronargs from pg_proc where oid = 'public.set_lead_assignee(uuid,uuid)'::regprocedure), 2::smallint, 'takes exactly two arguments');
select is((select prosecdef from pg_proc where oid = 'public.set_lead_assignee(uuid,uuid)'::regprocedure), true, 'SECURITY DEFINER');
select ok((select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""')) from pg_proc where oid = 'public.set_lead_assignee(uuid,uuid)'::regprocedure), 'empty fixed search_path');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.set_lead_assignee(uuid,uuid)'::regprocedure), 'postgres', 'owned by the reviewed privileged owner');
select is(has_function_privilege('anon', 'public.set_lead_assignee(uuid,uuid)', 'EXECUTE'), false, 'anon cannot execute');
select is(has_function_privilege('public', 'public.set_lead_assignee(uuid,uuid)', 'EXECUTE'), false, 'PUBLIC cannot execute');
select is(has_function_privilege('authenticated', 'public.set_lead_assignee(uuid,uuid)', 'EXECUTE'), true, 'authenticated can execute');
select is(has_column_privilege('authenticated', 'public.leads', 'assigned_to', 'UPDATE'), false, 'authenticated still lacks direct UPDATE on leads.assigned_to');
select is((select bool_or(has_column_privilege('authenticated', 'public.leads', c, 'UPDATE')) from unnest(array['business_id','lead_number','source','source_event_id','created_at','archived_at']) c), false, 'system-managed lead columns still protected');
select has_index('public', 'leads', 'ix_leads_business_assignee_created', 'workload index exists');
select ok((select pg_get_triggerdef(oid) ilike '%assigned_to%' from pg_trigger where tgname = 'trg_zz_leads_audit_changes'), 'audit trigger now fires on assigned_to');
select has_column('public', 'lead_activities', 'old_display_value', 'old_display_value column');
select has_column('public', 'lead_activities', 'new_display_value', 'new_display_value column');
select set_eq($$select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'$$,
  array['ingest_lead_event', 'add_lead_note', 'set_lead_assignee'], 'public schema exposes exactly the three reviewed RPCs');

-- =====================================================================================
-- owner / manager can assign and unassign; history is recorded once
-- =====================================================================================
select pg_temp.login_as(:'a_owner');
create temp table r1 as select * from public.set_lead_assignee(:'lead_a2', :'a_staff');
select is((select changed from r1), true, 'owner assigns an unassigned lead');
select is((select assigned_to from public.leads where id = :'lead_a2'), :'a_staff'::uuid, 'lead now assigned to staff');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'), 1::bigint, 'exactly one assignment activity');
select is((select actor_id::text || '|' || actor_display_name || '|' || coalesce(old_value, '-') || '|' || new_value || '|' || coalesce(old_display_value, '-') || '|' || new_display_value
           from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'),
  :'a_owner' || '|Owner A (synthetic)|-|' || :'a_staff' || '|-|Staff A (synthetic)', 'actor, old/new UUIDs and display snapshots recorded');
create temp table r2 as select * from public.set_lead_assignee(:'lead_a2', :'a_staff');
select is((select changed from r2), false, 'reassigning to the current assignee is a no-op');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'), 1::bigint, 'no-op created no activity');
select pg_temp.logout();

select pg_temp.login_as(:'a_manager');
create temp table r3 as select * from public.set_lead_assignee(:'lead_a2', :'a_owner');
select is((select changed from r3), true, 'manager reassigns');
select is((select old_value || '>' || new_value || '|' || old_display_value || '>' || new_display_value from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed' and old_value = :'a_staff'),
  :'a_staff' || '>' || :'a_owner' || '|Staff A (synthetic)>Owner A (synthetic)', 'reassignment records both assignees with snapshots');
create temp table r4 as select * from public.set_lead_assignee(:'lead_a2', null);
select is((select changed from r4) and (select assigned_to is null from public.leads where id = :'lead_a2'), true, 'manager unassigns with NULL');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed' and new_value is null and old_value = :'a_owner'), 1::bigint, 'unassignment audited with the previous assignee');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'), 3::bigint, 'three assignment activities in total');
select pg_temp.logout();

-- =====================================================================================
-- who cannot assign
-- =====================================================================================
select pg_temp.login_as(:'a_staff');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'staff cannot assign (opaque)');
select throws_ok(format($$update public.leads set assigned_to = %L where id = %L$$, :'a_staff', :'lead_a2'), '42501', null, 'staff cannot update assigned_to directly');
select is((select count(*) from public.leads where id = :'lead_a2'), 1::bigint, 'staff still sees the lead (assignment is not a visibility boundary)');
select pg_temp.logout();
select pg_temp.login_as(:'admin');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'platform admin cannot assign (read-only)');
select throws_ok(format($$update public.leads set assigned_to = %L where id = %L$$, :'a_staff', :'lead_a2'), '42501', null, 'platform admin cannot update assigned_to directly');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'), 3::bigint, 'platform admin reads the assignment history');
select pg_temp.logout();
select pg_temp.login_anon();
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), '42501', null, 'anon cannot execute');
select pg_temp.logout();

-- =====================================================================================
-- tenant / target controls (all opaque P0002)
-- =====================================================================================
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_b1', :'a_staff'), 'P0002', null, 'foreign-business lead rejected');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'b_owner'), 'P0002', null, 'cross-business assignee rejected');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_former'), 'P0002', null, 'inactive-membership assignee rejected');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'admin'), 'P0002', null, 'non-member (platform admin) assignee rejected');
select throws_ok($$select * from public.set_lead_assignee('00000000-0000-4000-8000-00000000dead', null)$$, 'P0002', null, 'unknown lead rejected with the same code');
select pg_temp.logout();
update public.profiles set is_active = false where id = :'a_staff';
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'inactive-profile assignee rejected');
select pg_temp.logout();
update public.profiles set is_active = true where id = :'a_staff';
select pg_temp.login_as(:'b_owner');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'b_owner'), 'P0002', null, 'owner B cannot assign a Business A lead');
select is((select count(*) from public.lead_activities where activity_type = 'assignment_changed'), 0::bigint, 'owner B reads no Business A assignment activity');
select pg_temp.logout();
select is((select assigned_to is null from public.leads where id = :'lead_a2'), true, 'lead A2 unchanged by rejected attempts');
select is((select count(*) from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed'), 3::bigint, 'no audit rows from rejected attempts');

-- =====================================================================================
-- caller revocation
-- =====================================================================================
update public.business_memberships set status = 'inactive' where user_id = :'a_manager';
select pg_temp.login_as(:'a_manager');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'inactive caller membership rejected');
select pg_temp.logout();
update public.business_memberships set status = 'active' where user_id = :'a_manager';
update public.profiles set is_active = false where id = :'a_manager';
select pg_temp.login_as(:'a_manager');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'inactive caller profile rejected');
select pg_temp.logout();
update public.profiles set is_active = true where id = :'a_manager';
update public.businesses set status = 'suspended' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'suspended business rejected');
select pg_temp.logout();
update public.businesses set status = 'archived' where id = :'biz_a';
select pg_temp.login_as(:'a_owner');
select throws_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'P0002', null, 'archived business rejected');
select pg_temp.logout();
update public.businesses set status = 'active' where id = :'biz_a';
select pg_temp.login_as(:'a_manager');
select lives_ok(format($$select * from public.set_lead_assignee(%L, %L)$$, :'lead_a2', :'a_staff'), 'restored access restores assignment capability');
select pg_temp.logout();

-- =====================================================================================
-- existing auditing / notes / immutability unchanged
-- =====================================================================================
select pg_temp.login_as(:'a_staff');
update public.leads set status = 'qualified', follow_up_at = '2032-05-05T10:00:00.500000Z' where id = :'lead_a3';
select is((select count(*) from public.lead_activities where lead_id = :'lead_a3' and activity_type in ('status_changed', 'follow_up_changed')), 2::bigint, 'status/follow-up auditing unchanged');
create temp table n1 as select * from public.add_lead_note(:'lead_a3', 'note', '66666666-6666-4666-8666-666666666666');
create temp table n2 as select * from public.add_lead_note(:'lead_a3', 'note replay', '66666666-6666-4666-8666-666666666666');
select is((select replayed from n2) and (select activity_id from n1) = (select activity_id from n2), true, 'note idempotency unchanged');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'assignment_changed', null, %L)$$, :'biz_a', :'lead_a3', :'a_staff'), '42501', null, 'customer cannot fabricate an assignment activity');
select throws_ok($$update public.lead_activities set new_display_value = 'x'$$, '42501', null, 'customer cannot update activities');
select throws_ok($$delete from public.lead_activities$$, '42501', null, 'customer cannot delete activities');
select pg_temp.logout();
select throws_ok($$update public.lead_activities set new_display_value = 'x' where activity_type = 'assignment_changed'$$, '23514', null, 'assignment snapshots immutable even for postgres');
select throws_ok($$update public.lead_activities set old_value = null where activity_type = 'assignment_changed'$$, '23514', null, 'assignment old/new UUIDs immutable even for postgres');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'assignment_changed', null, %L)$$, :'biz_b', :'lead_a2', :'a_staff'), '23503', null, 'composite same-business FK still enforced');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, note, request_id, new_display_value) values (%L, %L, 'note_added', 'x', gen_random_uuid(), 'x')$$, :'biz_a', :'lead_a2'), '23514', null, 'note rows cannot carry display snapshots');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value, note) values (%L, %L, 'assignment_changed', null, %L, 'x')$$, :'biz_a', :'lead_a2', :'a_staff'), '23514', null, 'assignment rows cannot carry note text');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'assignment_changed', 'not-a-uuid', %L)$$, :'biz_a', :'lead_a2', :'a_staff'), '23514', null, 'assignment values must be UUID text');
select throws_ok(format($$insert into public.lead_activities (business_id, lead_id, activity_type, old_value, new_value) values (%L, %L, 'assignment_changed', %L, %L)$$, :'biz_a', :'lead_a2', :'a_staff', :'a_staff'), '23514', null, 'assignment rows need a genuine difference');

-- =====================================================================================
-- profile deletion of a current assignee: unassigns, preserves history, succeeds
-- =====================================================================================
select is((select assigned_to from public.leads where id = :'lead_a2'), :'a_staff'::uuid, 'setup: A2 assigned to staff');
select is((select assigned_to from public.leads where id = :'lead_a1'), :'a_manager'::uuid, 'setup: seeded A1 assigned to manager');
delete from public.profiles where id = :'a_staff';
select is((select assigned_to is null from public.leads where id = :'lead_a2'), true, 'deleting the assignee profile unassigns the lead');
select is((select actor_id is null and old_value = :'a_staff' and new_value is null and old_display_value is null
           from public.lead_activities where lead_id = :'lead_a2' and activity_type = 'assignment_changed' and old_value = :'a_staff' and new_value is null),
  true, 'the system-driven unassignment is audited with a null actor and the historical assignee UUID');
select is((select count(*) from public.lead_activities where actor_id = :'a_staff'), 3::bigint, 'historical activities authored by the removed account are intact (status, follow-up, note)');
select is((select min(new_display_value) from public.lead_activities where lead_id = :'lead_a2' and new_value = :'a_staff'), 'Staff A (synthetic)', 'earlier snapshots of the removed user are preserved');

select * from finish();
rollback;
