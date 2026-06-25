// improvement-backlog.test.mjs — the FAPO-style improvement backlog the self-improvement loop drains.
//   node --test packages/chat/voice-agent/improvement-backlog.test.mjs
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
// point the backlog at a throwaway file BEFORE importing (the module reads the env per call).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-test-'));
process.env.IMPROVEMENT_BACKLOG = path.join(tmp, 'backlog.json');
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
const { addBacklog, listBacklog, nextOpen, recordOutcome, clearResolved, normalizeTestCmd, goalTargets, missingTargets, FAILURE_THRESHOLD } = await import('./improvement-backlog.mjs');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('pre-flight target guard: a goal whose named paths all 404 is rejected; a real path (or none) passes', () => {
  const exists = p => new Set(['packages/ocapn-noise/codemode.mjs', 'packages/chat/voice-agent/agent-caps.mjs']).has(p);
  // phantom file → not ok
  let r = missingTargets('In packages/chat/voice-agent/eval/improvement-executor.mjs, replace yarn with npm', exists);
  assert.equal(r.ok, false); assert.deepEqual(r.missing, ['packages/chat/voice-agent/eval/improvement-executor.mjs']);
  // wrong path (real file is packages/ocapn-noise) → not ok
  assert.equal(missingTargets('In packages/chat/ocapn-noise/codemode.mjs, add a retry', exists).ok, false);
  // real source + a NEW test file alongside → ok (at least one path exists)
  assert.equal(missingTargets('In packages/ocapn-noise/codemode.mjs add X and packages/ocapn-noise/codemode.test.mjs', exists).ok, true);
  // a goal that names no file path at all → ok (not all targets are file-scoped)
  assert.equal(missingTargets('Improve the agent persona to be more concise', exists).ok, true);
  assert.deepEqual(goalTargets('touch packages/a/b.mjs and packages/a/b.mjs again'), ['packages/a/b.mjs'], 'dedupes path tokens');
});

test('normalizeTestCmd rewrites the wrong runner (npm/yarn test → node --test) and leaves a correct one alone', () => {
  assert.equal(normalizeTestCmd('npm test packages/ocapn-noise/codemode.test.mjs'), 'node --test packages/ocapn-noise/codemode.test.mjs');
  assert.equal(normalizeTestCmd('yarn test foo.test.mjs'), 'node --test foo.test.mjs');
  assert.equal(normalizeTestCmd('npm run test bar.test.mjs'), 'node --test bar.test.mjs');
  assert.equal(normalizeTestCmd('node --test already.test.mjs'), 'node --test already.test.mjs', 'a correct command is untouched');
  assert.equal(normalizeTestCmd('  npm test x'), 'node --test x', 'tolerates leading whitespace');
  assert.equal(normalizeTestCmd(''), '', 'empty stays empty');
});

test('a precise target is added; a larger architectural goal is ALSO allowed (suite is the gate); only too-SHORT is refused', () => {
  const ok = addBacklog({ goal: 'In packages/chat/voice-agent/improvement-backlog.mjs, add an exported foo() returning 1, and a test asserting foo()===1.', priority: 5 });
  assert.equal(ok.ok, true); assert.ok(ok.id);
  // file-scoping is no longer required — a broader architectural goal is accepted (it lands only if the suite stays green)
  const arch = addBacklog({ goal: 'refactor the orchestration layer to share one tool-ring resolver across delegate/employ/specialists' });
  assert.equal(arch.ok, true, 'a larger architectural goal is allowed');
  // only a too-short goal (< 12 chars) is refused
  const tiny = addBacklog({ goal: 'fix it' });
  assert.equal(tiny.ok, false, 'a too-short goal is refused');
});

test('nextOpen returns the highest-priority OPEN target; recordOutcome staged/merged removes it from open', () => {
  addBacklog({ goal: 'In some/file.mjs, add a clearly described lower-priority change plus its test asserting it works.', priority: 1 });
  const top = nextOpen();
  assert.equal(top.priority, 5, 'highest priority first');
  recordOutcome(top.id, { status: 'staged', branch: 'agentwt/x' });
  assert.equal(listBacklog({ status: 'staged' }).length, 1, 'the staged target is recorded');
  assert.ok(nextOpen().priority === 1, 'next open is now the lower-priority one');
});

test('a FAILED attempt is recorded with its reason and returns to OPEN (bounded retry), with attribution', () => {
  const r = addBacklog({ goal: 'In another/file.mjs, add a described change X and a test that proves X.' });
  recordOutcome(r.id, { status: 'failed', reason: 'the implementer produced no branch' });
  const it = listBacklog().find(x => x.id === r.id);
  assert.equal(it.status, 'open', 'failed → back to open for a bounded retry');
  assert.equal(it.attempts, 1);
  assert.match(it.lastOutcome.reason, /no branch/, 'the failure reason is kept (attribution)');
  // after maxAttempts, nextOpen skips it (no infinite churn)
  recordOutcome(r.id, { status: 'failed', reason: 'again' });
  assert.ok(nextOpen({ maxAttempts: 2 })?.id !== r.id, 'a target that failed maxAttempts is no longer picked');
});

test('de-dupe: re-proposing an identical OPEN goal does not duplicate it', () => {
  const g = 'In dedupe/file.mjs, add a uniquely-worded change Q and a test for Q.';
  const a = addBacklog({ goal: g }); const b = addBacklog({ goal: g });
  assert.equal(a.ok, true); assert.equal(b.deduped, true);
  assert.equal(listBacklog().filter(i => i.goal === g).length, 1);
});

test('clearResolved removes merged + staged items and leaves OPEN ones, returning the count removed', () => {
  process.env.IMPROVEMENT_BACKLOG = path.join(tmp, 'clear-resolved.json');
  const m = addBacklog({ goal: 'In clear/file.mjs, add a merged-bound change M plus a test asserting M.' });
  const s = addBacklog({ goal: 'In clear/file.mjs, add a staged-bound change S plus a test asserting S.' });
  const o = addBacklog({ goal: 'In clear/file.mjs, add an open change O plus a test asserting O, left untouched.' });
  recordOutcome(m.id, { status: 'merged' });
  recordOutcome(s.id, { status: 'staged' });
  const removed = clearResolved();
  assert.equal(removed, 2, 'the merged + staged items are removed');
  const remaining = listBacklog();
  assert.equal(remaining.length, 1, 'only the open item remains');
  assert.equal(remaining[0].id, o.id, 'the remaining item is the open one');
  assert.equal(remaining[0].status, 'open');
});

test('FAILURE THRESHOLD: a target is auto-moved to terminal "failed" after 3 unsuccessful attempts so it cannot block the queue', () => {
  process.env.IMPROVEMENT_BACKLOG = path.join(tmp, 'failure-threshold.json');
  assert.equal(FAILURE_THRESHOLD, 3, 'the default failure threshold is 3 attempts');
  const stuck = addBacklog({ goal: 'In stuck/file.mjs, attempt an impossible change that keeps failing, plus a test.', priority: 9 });
  const other = addBacklog({ goal: 'In other/file.mjs, a healthy lower-priority change L plus a test asserting L.', priority: 1 });

  // attempt 1: failed → still open (bounded retry), still the top target
  let r = recordOutcome(stuck.id, { status: 'failed', reason: 'fail 1' });
  assert.equal(r.status, 'open'); assert.equal(r.attempts, 1);
  assert.equal(nextOpen().id, stuck.id, 'still picked after 1 failure');

  // attempt 2: failed → still open
  r = recordOutcome(stuck.id, { status: 'failed', reason: 'fail 2' });
  assert.equal(r.status, 'open'); assert.equal(r.attempts, 2);
  assert.equal(nextOpen().id, stuck.id, 'still picked after 2 failures (under the threshold)');

  // attempt 3: hits the threshold → terminal 'failed', drops out of the open queue
  r = recordOutcome(stuck.id, { status: 'failed', reason: 'fail 3' });
  assert.equal(r.status, 'failed', 'auto-moved to terminal failed at the 3rd unsuccessful attempt');
  assert.equal(r.attempts, 3);
  const it = listBacklog().find(x => x.id === stuck.id);
  assert.equal(it.status, 'failed', 'persisted as terminal failed');

  // the failing target NO LONGER blocks the queue — nextOpen now drains the OTHER target
  const nxt = nextOpen();
  assert.ok(nxt && nxt.id === other.id, 'a single failing target no longer blocks the whole queue');
  assert.notEqual(nxt.id, stuck.id, 'the exhausted target is never picked again');

  // a custom failureThreshold is honored (e.g. fail fast after 1)
  process.env.IMPROVEMENT_BACKLOG = path.join(tmp, 'failure-threshold-custom.json');
  const ff = addBacklog({ goal: 'In ff/file.mjs, a change that should be parked after a single failure, plus a test.' });
  const fr = recordOutcome(ff.id, { status: 'failed', reason: 'one and done', failureThreshold: 1 });
  assert.equal(fr.status, 'failed', 'a failureThreshold of 1 parks the target after one failure');
  assert.equal(nextOpen(), null, 'no open target remains once the only target is parked');
});
