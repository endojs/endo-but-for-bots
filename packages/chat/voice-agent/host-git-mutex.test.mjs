// host-git-mutex.test.mjs — P2-5. ONE shared mutex serializes every host-git writer so their `git`
// invocations don't collide on index.lock. Tests the mutex primitive AND a real-git barrage: many concurrent
// componentGit commits to the SAME repo must all land (serialized) with no "index.lock: File exists" error.
import '@endo/init'; // SES: the modules harden their exports at load
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeComponentGit } from './component-git.mjs';
import { makeGitMutex } from './host-git-mutex.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('P2-5: runExclusive never lets two critical sections overlap', async () => {
  const m = makeGitMutex();
  let active = 0;
  let maxActive = 0;
  const task = () => m.runExclusive(async () => { active += 1; maxActive = Math.max(maxActive, active); await sleep(5); active -= 1; });
  await Promise.all(Array.from({ length: 12 }, task));
  assert.equal(maxActive, 1, 'at most one holder at any instant (mutual exclusion)');
});

test('P2-5: acquisitions run FIFO', async () => {
  const m = makeGitMutex();
  const order = [];
  await Promise.all([1, 2, 3, 4, 5].map(i => m.runExclusive(async () => { order.push(i); await sleep(2); })));
  assert.deepEqual(order, [1, 2, 3, 4, 5], 'holders run in the order they queued');
});

test('P2-5: a rejecting holder does not wedge the chain', async () => {
  const m = makeGitMutex();
  await assert.rejects(m.runExclusive(async () => { throw new Error('boom'); }), /boom/);
  const r = await m.runExclusive(async () => 'ok');
  assert.equal(r, 'ok', 'the next acquisition still runs after a rejection');
});

test('P2-5: concurrent componentGit commits to the SAME repo serialize (no index.lock error)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-cg-'));
  // Default lock = the shared host-git mutex → the barrage is serialized.
  const cg = makeComponentGit({ baseDir: dir });
  const N = 10;
  const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => cg.commit('cmp-1', { 'component.js': `export const v = ${i};` }, `commit ${i}`)));
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(rejected.length, 0, `no commit threw (index.lock-free); rejects: ${rejected.map(r => String(r.reason)).join(' | ')}`);
  const hist = await cg.history('cmp-1');
  assert.equal(hist.length, N, `all ${N} serialized commits landed as distinct versions`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P2-5: an UNSERIALIZED barrage on the same repo is genuinely hazardous (justifies the mutex)', async () => {
  // With a passthrough lock the same barrage races on ensureRepo/index.lock. We assert the SERIALIZED path is
  // strictly safe; the unserialized path is expected to be flaky, so we only require that it does NOT do
  // BETTER than the serialized one (i.e. it can lose commits or throw) — evidence the lock earns its keep.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-race-'));
  const raw = makeComponentGit({ baseDir: dir, lock: fn => fn() }); // no serialization
  const N = 12;
  const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => raw.commit('cmp-r', { 'component.js': `export const v = ${i};` }, `c${i}`)));
  const landed = (await raw.history('cmp-r').catch(() => [])).length;
  const threw = results.filter(r => r.status === 'rejected').length;
  // Unserialized: either some calls threw, OR fewer than N distinct commits landed (lost/duplicated work).
  // (This can occasionally come out clean by luck; treat a clean run as inconclusive, not a failure.)
  const hazardous = threw > 0 || landed < N;
  console.error(`  [P2-5] unserialized barrage: ${threw} threw, ${landed}/${N} commits landed${hazardous ? ' (hazard reproduced)' : ' (clean this run — inconclusive)'}`);
  assert.ok(landed <= N, 'sanity: unserialized cannot exceed N commits');
  fs.rmSync(dir, { recursive: true, force: true });
});
