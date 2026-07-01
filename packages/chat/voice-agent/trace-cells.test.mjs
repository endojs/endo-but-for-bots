// trace-cells.test.mjs — unit coverage for the per-chat trace propagator cell (trace-cells.mjs).
// Pure logic, no server: the step-event stream folds into a MONOTONIC value (append + settle, never
// rewind), the cell pushes on every accepted event, a late subscriber is caught up immediately,
// bounds hold, and ownership binds first-writer.
import '@endo/init'; // lockdown + harden, FIRST
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTraceCells } from './trace-cells.mjs';

test('a turn: begin → start/done fold monotonically; end settles status', () => {
  const tc = makeTraceCells();
  tc.begin('s1');
  let v = tc.snapshot('s1');
  assert.equal(v.turn, 1);
  assert.equal(v.status, 'running');
  assert.equal(v.progress, 'Thinking…');

  tc.feed('s1', { t: 'start', name: 'research', detail: 'vacuums', call: 'research({q})' });
  v = tc.snapshot('s1');
  assert.equal(v.steps.length, 1);
  assert.equal(v.steps[0].status, 'running');
  assert.equal(v.steps[0].name, 'research');

  tc.feed('s1', { t: 'done', name: 'research', ok: true, result: 'a report', children: [{ name: 'fetchUrl', detail: 'x' }] });
  v = tc.snapshot('s1');
  assert.equal(v.steps.length, 1, 'done MERGES into the running step (no duplicate row)');
  assert.equal(v.steps[0].status, 'done');
  assert.equal(v.steps[0].ok, true);
  assert.equal(v.steps[0].result, 'a report');
  assert.equal(v.steps[0].children.length, 1);

  tc.feed('s1', { t: 'end' });
  v = tc.snapshot('s1');
  assert.equal(v.status, 'done');
  assert.equal(v.progress, '');
});

test('parallel same-name calls settle in order; an unmatched done appends settled (never rewinds)', () => {
  const tc = makeTraceCells();
  tc.begin('s2');
  tc.feed('s2', { t: 'start', name: 'web' });
  tc.feed('s2', { t: 'start', name: 'web' });
  tc.feed('s2', { t: 'done', name: 'web', ok: false });
  let v = tc.snapshot('s2');
  assert.equal(v.steps[0].status, 'done');
  assert.equal(v.steps[0].ok, false);
  assert.equal(v.steps[1].status, 'running', 'the SECOND same-name call is still in flight');
  tc.feed('s2', { t: 'done', name: 'searchNotes', ok: true }); // no matching start (joined past the buffer)
  v = tc.snapshot('s2');
  assert.equal(v.steps.length, 3, 'an unmatched done APPENDS as already-settled');
  assert.equal(v.steps[2].status, 'done');
});

test('the cell pushes on every accepted event and catches a late subscriber up', () => {
  const tc = makeTraceCells();
  tc.begin('s3');
  tc.feed('s3', { t: 'start', name: 'a' });
  const seen = [];
  const unsub = tc.cellFor('s3').subscribe(v => seen.push(v));
  assert.equal(seen.length, 1, 'late subscriber gets the CURRENT value immediately');
  assert.equal(seen[0].steps.length, 1);
  tc.feed('s3', { t: 'progress', text: 'working on it' });
  tc.feed('s3', { t: 'done', name: 'a', ok: true });
  assert.equal(seen.length, 3);
  assert.equal(seen[1].progress, 'working on it');
  assert.ok(seen[2].rev > seen[1].rev, 'rev only grows');
  unsub();
  tc.feed('s3', { t: 'end' });
  assert.equal(seen.length, 3, 'unsubscribed → no more pushes');
});

test('a NEW turn bumps turn and resets steps; rev keeps growing (ordered across turns)', () => {
  const tc = makeTraceCells();
  tc.begin('s4');
  tc.feed('s4', { t: 'start', name: 'a' });
  tc.feed('s4', { t: 'end' });
  const v1 = tc.snapshot('s4');
  tc.begin('s4');
  const v2 = tc.snapshot('s4');
  assert.equal(v2.turn, v1.turn + 1);
  assert.equal(v2.steps.length, 0);
  assert.ok(v2.rev > v1.rev);
});

test('rnode upserts by key (state refreshes, rows never vanish); child-done folds in', () => {
  const tc = makeTraceCells();
  tc.begin('s5');
  tc.feed('s5', { t: 'rnode', parent: 'research', key: 's0', kind: 'subq', label: '❓ q1', state: 'pending' });
  tc.feed('s5', { t: 'rnode', key: 's0', state: 'done', info: 'answered' });
  let v = tc.snapshot('s5');
  assert.equal(v.nodes.length, 1);
  assert.equal(v.nodes[0].state, 'done');
  assert.equal(v.nodes[0].label, '❓ q1', 'earlier fields survive the upsert');
  tc.feed('s5', { t: 'child-done', parent: 'delegateTask', name: 'agentExec', ok: true });
  v = tc.snapshot('s5');
  assert.equal(v.nodes.length, 2);
  assert.equal(v.nodes[1].state, 'done');
});

test('bounds: steps cap out with a visible truncated flag (still monotonic)', () => {
  const tc = makeTraceCells({ maxSteps: 3 });
  tc.begin('s6');
  for (let i = 0; i < 5; i++) tc.feed('s6', { t: 'start', name: `t${i}` });
  const v = tc.snapshot('s6');
  assert.equal(v.steps.length, 3);
  assert.equal(v.truncated, true);
});

test('ownership binds first-writer and reads back', () => {
  const tc = makeTraceCells();
  tc.bindOwner('s7', 'u:abc');
  tc.bindOwner('s7', 'u:OTHER'); // second writer must NOT steal it
  assert.equal(tc.ownerOf('s7'), 'u:abc');
  assert.equal(tc.ownerOf('s-unknown'), '');
});

test('malformed events are dropped without breaking the cell', () => {
  const tc = makeTraceCells();
  tc.begin('s8');
  tc.feed('s8', null);
  tc.feed('s8', 'garbage');
  tc.feed('s8', { t: 'nonsense', name: 'x' });
  const v = tc.snapshot('s8');
  assert.equal(v.steps.length, 0);
  assert.equal(v.status, 'running');
});
