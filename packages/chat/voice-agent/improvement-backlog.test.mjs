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
const { addBacklog, listBacklog, nextOpen, recordOutcome, clearResolved } = await import('./improvement-backlog.mjs');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('a precise target is added; a VAGUE one is rejected (precision is what makes the executor succeed)', () => {
  const ok = addBacklog({ goal: 'In packages/chat/voice-agent/improvement-backlog.mjs, add an exported foo() returning 1, and a test asserting foo()===1.', priority: 5 });
  assert.equal(ok.ok, true); assert.ok(ok.id);
  const vague = addBacklog({ goal: 'improve orchestration' });
  assert.equal(vague.ok, false, 'a one-liner vague goal is refused');
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
