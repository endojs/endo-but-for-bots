// timers-isolation.test.mjs — INC-2 (per-user isolation): durable timers are partitioned per user. Proves
// (a) user-0/legacy (no owner field) = root sees today's data, (b) tenant A's timers are invisible to tenant B
// and a foreign-owner cancel is refused (fail-closed), (c) the UNSCOPED list (the timer-runner daemon path)
// still sees EVERY owner's timers so they all fire.
//
//   node --test packages/chat/voice-agent/timers-isolation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timers-iso-'));
process.env.FIELD_TIMERS_STORE = path.join(TMP, 'schedule.json'); // NEVER touch dan's real ~/.local/state store

const { addTimer, listTimers, cancelTimer } = await import('../capture/timers.mjs');

const A = 'u:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'u:bbbbbbbbbbbbbbbbbbbbbbbb';
const N = t => ({ type: 'notify', title: t, message: '' });

test('legacy (owner-less) timer = user-0 = root; tenants are isolated; runner sees all', async () => {
  // seed a LEGACY record with no owner field (pre-INC-2 store)
  fs.writeFileSync(process.env.FIELD_TIMERS_STORE, JSON.stringify({ timers: [
    { id: 't-legacy', kind: 'once', label: 'legacy', action: N('legacy'), status: 'active', dueAt: new Date().toISOString() },
  ] }));

  const a = await addTimer({ kind: 'once', dueAt: new Date().toISOString(), action: N('A-timer'), owner: A });
  const b = await addTimer({ kind: 'once', dueAt: new Date().toISOString(), action: N('B-timer'), owner: B });

  const rootList = await listTimers('root');
  assert.ok(rootList.some(t => t.id === 't-legacy'), 'root (user-0) sees the legacy owner-less timer');
  assert.ok(!rootList.some(t => t.id === a.id || t.id === b.id), 'root does NOT see the tenants\' timers');

  const aList = await listTimers(A);
  const bList = await listTimers(B);
  assert.deepEqual(aList.map(t => t.id), [a.id], 'tenant A sees only its own timer');
  assert.deepEqual(bList.map(t => t.id), [b.id], 'tenant B sees only its own timer');

  // the UNSCOPED list (timer-runner) sees EVERY timer so they all fire
  const all = await listTimers();
  assert.equal(all.length, 3, 'unscoped listTimers() (the runner) sees legacy + A + B');
});

test('a foreign-owner cancel is REFUSED (fail-closed); the owner can cancel its own', async () => {
  fs.writeFileSync(process.env.FIELD_TIMERS_STORE, JSON.stringify({ timers: [] }));
  const a = await addTimer({ kind: 'once', dueAt: new Date().toISOString(), action: N('A-timer'), owner: A });

  const foreign = await cancelTimer(a.id, B);
  assert.equal(foreign.ok, false, 'tenant B cannot cancel tenant A\'s timer');
  assert.equal((await listTimers(A))[0].status, 'active', 'tenant A\'s timer is untouched by B\'s attempt');

  const own = await cancelTimer(a.id, A);
  assert.equal(own.ok, true, 'tenant A cancels its own timer');
  assert.equal((await listTimers(A))[0].status, 'cancelled', 'now cancelled');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
