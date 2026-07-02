// turn-watchdog.test.mjs — unit coverage for the P1-6 unanswered-turn detectors (turn-watchdog.mjs).
// Pure logic, no server: detectStuckRuns finds a 'running' run with a dead controller OR one overrun past
// the deadline (and leaves live/finished runs alone); scanUnansweredBundle finds a persisted chat ending on
// a user message with no assistant reply, bounded to recent breakage.
import '@endo/init';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStuckRuns, scanUnansweredBundle } from './turn-watchdog.mjs';

const NOW = 1_000_000_000_000;
const DEADLINE = 360_000;

test('detectStuckRuns: a running run with NO live controller is stuck (the /chat/result "running" lie)', () => {
  const runResults = new Map([['sid-dead', { state: 'running', text: 'hi', startedAt: NOW - 1000 }]]);
  const runs = new Map(); // no controller for sid-dead
  const out = detectStuckRuns({ runResults, runs, now: NOW, deadlineMs: DEADLINE });
  assert.equal(out.length, 1);
  assert.equal(out[0].sid, 'sid-dead');
  assert.equal(out[0].reason, 'no-run');
  assert.equal(out[0].text, 'hi');
});

test('detectStuckRuns: a running run OVERRUN past the deadline is stuck even if it still has a controller', () => {
  const runResults = new Map([['sid-slow', { state: 'running', text: 'slow', startedAt: NOW - DEADLINE - 1 }]]);
  const runs = new Map([['sid-slow', { abort() {} }]]); // controller still present
  const out = detectStuckRuns({ runResults, runs, now: NOW, deadlineMs: DEADLINE });
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'stale');
});

test('detectStuckRuns: a genuinely in-flight run (controller present, within deadline) is NOT stuck', () => {
  const runResults = new Map([['sid-live', { state: 'running', text: 'live', startedAt: NOW - 5000 }]]);
  const runs = new Map([['sid-live', { abort() {} }]]);
  assert.deepEqual(detectStuckRuns({ runResults, runs, now: NOW, deadlineMs: DEADLINE }), []);
});

test('detectStuckRuns: finished runs (done/error/timedOut) are never stuck', () => {
  const runResults = new Map([
    ['a', { state: 'done', startedAt: NOW - 999999 }],
    ['b', { state: 'error', startedAt: NOW - 999999 }],
    ['c', { state: 'timedOut', startedAt: NOW - 999999 }],
  ]);
  assert.deepEqual(detectStuckRuns({ runResults, runs: new Map(), now: NOW, deadlineMs: DEADLINE }), []);
});

test('scanUnansweredBundle: a chat ending on a user message with no assistant reply is unanswered', () => {
  const bundle = {
    chats: [{ id: 'c1', title: 'Groceries', lastMsgAt: NOW - DEADLINE - 1000 }],
    tx: { c1: [{ who: 'you', text: 'buy milk', at: NOW - DEADLINE - 1000 }] },
  };
  const out = scanUnansweredBundle(bundle, { now: NOW, deadlineMs: DEADLINE });
  assert.equal(out.length, 1);
  assert.equal(out[0].chatId, 'c1');
  assert.equal(out[0].lastUserText, 'buy milk');
});

test('scanUnansweredBundle: a chat whose last turn IS an assistant reply is fine', () => {
  const bundle = {
    chats: [{ id: 'c1' }],
    tx: { c1: [{ who: 'you', text: 'hi', at: NOW - 500000 }, { who: 'agent', text: 'hello!', at: NOW - 499000 }] },
  };
  assert.deepEqual(scanUnansweredBundle(bundle, { now: NOW, deadlineMs: DEADLINE }), []);
});

test('scanUnansweredBundle: too-fresh (within deadline) and too-old (past maxAge) are ignored', () => {
  const fresh = { chats: [{ id: 'f' }], tx: { f: [{ who: 'you', text: 'just now', at: NOW - 1000 }] } };
  const ancient = { chats: [{ id: 'a' }], tx: { a: [{ who: 'you', text: 'last week', at: NOW - 7 * 24 * 3600 * 1000 }] } };
  assert.deepEqual(scanUnansweredBundle(fresh, { now: NOW, deadlineMs: DEADLINE }), [], 'fresh: turn may still be running');
  assert.deepEqual(scanUnansweredBundle(ancient, { now: NOW, deadlineMs: DEADLINE }), [], 'ancient: past the recent-breakage window');
});

test('scanUnansweredBundle: empty/whitespace user messages are skipped', () => {
  const bundle = { chats: [{ id: 'c1' }], tx: { c1: [{ who: 'you', text: '   ', at: NOW - 500000 }] } };
  assert.deepEqual(scanUnansweredBundle(bundle, { now: NOW, deadlineMs: DEADLINE }), []);
});
