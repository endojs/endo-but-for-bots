// side-effect-ledger.test.mjs — the P1-5 idempotency ledger: a durable at-most-once guard for destructive verbs.
// Proves: a deterministic call key; the commit predicate (parked proposals + errors are NOT ledgered, real
// effects + auto-fires ARE); and — the crux — that a ledger reloaded from disk in a FRESH facet (a restarted
// process) recalls a prior destructive call so a recovery re-run returns the prior result instead of firing again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@endo/init';
import { makeSideEffectLedger, callKeyOf, didCommitSideEffect, DESTRUCTIVE_VERBS } from './side-effect-ledger.mjs';

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p15-ledger-'));

test('callKeyOf is deterministic + order-independent for args, and args-sensitive', () => {
  assert.equal(callKeyOf('proposeEmail', { to: 'a', subject: 's' }), callKeyOf('proposeEmail', { subject: 's', to: 'a' }), 'key ignores arg key order');
  assert.notEqual(callKeyOf('proposeEmail', { to: 'a' }), callKeyOf('proposeEmail', { to: 'b' }), 'different args → different key');
  assert.notEqual(callKeyOf('proposeEmail', { to: 'a' }), callKeyOf('notify', { to: 'a' }), 'verb name is part of the key');
});

test('didCommitSideEffect: parked proposals + errors are NOT committed; real effects + auto-fires ARE', () => {
  assert.equal(didCommitSideEffect({ proposed: true, id: 'p-1' }), false, 'a parked confirmation committed nothing');
  assert.equal(didCommitSideEffect({ ok: false, error: 'nope' }), false, 'an explicit failure committed nothing');
  assert.equal(didCommitSideEffect({ error: 'boom' }), false, 'an error-shaped result committed nothing');
  assert.equal(didCommitSideEffect({ idempotentSkip: true }), false, 'the no-op sentinel is not re-ledgered');
  assert.equal(didCommitSideEffect({ autoConfirmed: true, fired: false, error: 'x' }), false, 'an auto-confirm that did NOT fire committed nothing');
  assert.equal(didCommitSideEffect({ autoConfirmed: true, fired: true, result: {} }), true, 'an auto-FIRED proposal committed a real effect');
  assert.equal(didCommitSideEffect({ ok: true, sent: 1 }), true, 'a plain successful direct-effect verb committed');
  assert.equal(didCommitSideEffect({ ok: true, marker: 'TESTFIRE_OK' }), true, 'the test-fire result committs');
});

test('recall returns the PRIOR result for a committed call — across a simulated restart (fresh facet from disk)', () => {
  const dir = mkdir();
  try {
    const turnId = 'sess-1_do-the-thing';
    // ── original run
    const l1 = makeSideEffectLedger({ dir }).forTurn(turnId);
    const key = l1.callKey('notify', { title: 'hi', body: 'there' });
    assert.equal(l1.recall(key), null, 'nothing recalled before the first fire');
    l1.markPending(key);
    l1.settle(key, { ok: true, delivered: true }); // the verb fired + committed
    // ── SIMULATED RESTART: brand-new ledger + facet, same dir → loads the persisted entry from disk
    const l2 = makeSideEffectLedger({ dir }).forTurn(turnId);
    const hit = l2.recall(l2.callKey('notify', { body: 'there', title: 'hi' })); // same args, reordered
    assert.ok(hit && hit.hit === true, 'the prior committed call is recalled after a restart');
    assert.deepEqual(hit.result, { ok: true, delivered: true }, 'recall returns the EXACT prior result (no re-fire)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a PENDING (mid-effect crash) entry recalls a safe no-op sentinel, not a re-fire', () => {
  const dir = mkdir();
  try {
    const l1 = makeSideEffectLedger({ dir }).forTurn('t-pending');
    const key = l1.callKey('emailSend', { to: 'x' });
    l1.markPending(key); // crash here — effect MAY have committed; result never recorded
    const l2 = makeSideEffectLedger({ dir }).forTurn('t-pending'); // restart
    const hit = l2.recall(l2.callKey('emailSend', { to: 'x' }));
    assert.ok(hit && hit.hit === true, 'a pending entry is a recall HIT (do not re-run)');
    assert.equal(hit.result.idempotentSkip, true, 'it returns the safe no-op sentinel');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a PARKED proposal / errored verb is NOT ledgered → a replay may legitimately re-run it', () => {
  const dir = mkdir();
  try {
    const l = makeSideEffectLedger({ dir }).forTurn('t-parked');
    const k1 = l.callKey('proposeEmail', { to: 'a' });
    l.markPending(k1); l.settle(k1, { proposed: true, id: 'p-9' }); // parked, not fired
    assert.equal(l.recall(k1), null, 'a parked proposal leaves no ledger entry (re-park on replay)');
    const k2 = l.callKey('hostExec', { cmd: 'x' });
    l.markPending(k2); l.clearPending(k2); // the verb threw
    assert.equal(l.recall(k2), null, 'a thrown verb leaves no ledger entry (retry on replay)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('prune drops the turn ledger; a fresh facet then finds nothing (same-text turn LATER fires normally)', () => {
  const dir = mkdir();
  try {
    const l = makeSideEffectLedger({ dir }).forTurn('t-prune');
    const k = l.callKey('notify', { t: 1 });
    l.markPending(k); l.settle(k, { ok: true });
    l.prune();
    const l2 = makeSideEffectLedger({ dir }).forTurn('t-prune');
    assert.equal(l2.recall(l2.callKey('notify', { t: 1 })), null, 'after prune the ledger is empty → a later identical turn is NOT deduped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the destructive set includes the propose→confirm + direct-effect verbs, excludes reads', () => {
  for (const v of ['proposeEmail', 'proposeBufferPost', 'emailSend', 'hostExec', 'notify', 'scheduleWakeup', 'generateImage']) assert.ok(DESTRUCTIVE_VERBS.has(v), `${v} is guarded`);
  for (const v of ['searchNotes', 'readNote', 'fetchUrl', 'webSearch', 'listObjects', 'answer']) assert.ok(!DESTRUCTIVE_VERBS.has(v), `${v} (read/meta) is NOT guarded`);
});
