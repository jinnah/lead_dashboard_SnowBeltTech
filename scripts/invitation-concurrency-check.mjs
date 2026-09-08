// Local-only synthetic parallel-session proof. No Auth credentials or tokens.
import { spawn, spawnSync } from 'node:child_process';
const container = 'supabase_db_Dashboard_SnowBeltTech';
const biz = 'c0000000-0000-4000-8000-0000000000c1';
const inv = 'c1000000-0000-4000-8000-0000000000c1';
const user = 'c2000000-0000-4000-8000-0000000000c1';
const admin = '10000000-0000-4000-8000-000000000001';
const args = ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c'];
function sql(q) {
  const r = spawnSync('docker', [...args, q], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('invitation concurrency SQL failed');
  return r.stdout.trim();
}
function parallel(q) {
  return new Promise((resolve) => {
    const p = spawn('docker', [...args, q]); let out = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.resume();
    p.on('close', code => resolve({ code, out }));
  });
}
function check(ok, message) { if (!ok) throw new Error(message); }
function cleanup() {
  sql(`delete from public.customer_access_events where business_id='${biz}';
    delete from public.customer_invitations where business_id='${biz}';
    delete from auth.users where id='${user}';
    delete from public.businesses where id='${biz}';`);
}
function fixture() {
  cleanup();
  sql(`insert into public.businesses(id,name,slug,industry,timezone) values ('${biz}','Invitation race synthetic','invitation-race-synthetic','other','UTC');
    insert into auth.users(id,email,created_at,raw_user_meta_data) values ('${user}','race@reissue.example.invalid',now(),jsonb_build_object('portal_invitation_id','${inv}'));
    insert into public.customer_invitations(id,business_id,email,display_name,role,status,auth_user_id,sent_at,expires_at,created_by)
      values ('${inv}','${biz}','race@reissue.example.invalid','Race Synthetic','BUSINESS_OWNER','sent','${user}',now()-interval '6 minutes',now()+interval '1 hour','${admin}');`);
}
const asUser = (id, q) => `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${id}',true); ${q}; commit;`;
const reissue = `select count(*) from public.admin_begin_customer_invitation_reissue('${biz}','${inv}')`;
const accept = 'select count(*) from public.accept_customer_invitation()';

// A transaction holds the invitation lock. Waiters are observed in pg_stat_activity
// before release, rather than assuming a startup sleep creates a race.
async function heldRace(first, waiter) {
  const lock = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1']);
  lock.stdout.resume(); lock.stderr.resume();
  const done = new Promise(resolve => lock.on('close', resolve));
  const label = 'snowbelt_reissue_barrier';
  lock.stdin.write(`set application_name='${label}'; begin; select id from public.customer_invitations where id='${inv}' for update;\n`);
  const deadline = Date.now() + 10000;
  try {
    while (sql(`select count(*) from pg_stat_activity where application_name='${label}' and state='idle in transaction'`) !== '1') {
      check(Date.now() < deadline, 'lock holder did not start'); await new Promise(r => setTimeout(r, 30));
    }
    const waiting = parallel(waiter);
    while (sql(`select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%${inv}%'`) === '0') {
      check(Date.now() < deadline, 'race waiter did not block'); await new Promise(r => setTimeout(r, 30));
    }
    lock.stdin.end(`${first}; commit;\n`);
    check(await done === 0, 'lock holder operation failed');
    return await waiting;
  } finally { if (lock.exitCode === null) { lock.stdin.end('rollback;\n'); await done; } }
}

export async function checkInvitationConcurrency() {
  try {
    fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => parallel(asUser(admin, reissue))));
    check(results.filter(r => r.code === 0).length === 1, 'exactly one reissue must win');
    check(sql(`select count(*) from public.customer_access_events where business_id='${biz}' and event_type='invitation_reissue_requested'`) === '1', 'one reissue ledger entry');
    console.log('[invitation concurrency] 8 simultaneous claims: exactly 1 winner');
    fixture();
    const accepted = await heldRace(`set local role authenticated; select set_config('request.jwt.claim.sub','${user}',true); ${accept}`, asUser(admin,reissue));
    check(accepted.code !== 0, 'reissue must lose after acceptance');
    check(sql(`select status from public.customer_invitations where id='${inv}'`) === 'accepted', 'acceptance won');
    check(sql(`select count(*) from public.business_memberships where user_id='${user}'`) === '1', 'exactly one accepted membership');
    console.log('[invitation concurrency] acceptance holds lock first: reissue denied, membership preserved');
    fixture();
    // Acceptance query does not contain the invitation UUID; add a harmless
    // comment to identify the blocked session in pg_stat_activity.
    const replaced = await heldRace(`set local role authenticated; select set_config('request.jwt.claim.sub','${admin}',true); ${reissue}`, asUser(user,`${accept} /* ${inv} */`));
    check(replaced.code !== 0, 'acceptance must lose after reissue');
    check(sql(`select status from public.customer_invitations where id='${inv}'`) === 'revoked', 'reissue won');
    check(sql(`select count(*) from public.business_memberships where user_id='${user}'`) === '0', 'no old membership');
    console.log('[invitation concurrency] reissue holds lock first: old acceptance denied');
  } finally {
    cleanup();
    check(sql(`select count(*) from public.businesses where id='${biz}'`) === '0', 'harness cleanup');
    console.log('[invitation concurrency] harness removed');
  }
}
