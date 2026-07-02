// seed-cells.test.mjs — unit coverage for the in-flight capture propagator cell (seed-cells.mjs).
// Pure logic, no server: stages fold MONOTONICALLY (advance only, never rewind), the cell pushes on
// every transition, a late subscriber is caught up immediately, title/chatId upsert, bounds + TTL hold,
// and owners are isolated (one owner never sees another's captures).
import '@endo/init'; // lockdown + harden, FIRST
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedCells } from './seed-cells.mjs';

test('a capture: received → understanding → proposed advances monotonically; snapshot reflects it', () => {
  const sc = makeSeedCells();
  sc.stage('root', 'chat-1', 'received');
  let v = sc.snapshot('root');
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 'chat-1');
  assert.equal(v[0].stage, 'received');

  sc.stage('root', 'chat-1', 'understanding');
  v = sc.snapshot('root');
  assert.equal(v[0].stage, 'understanding');

  sc.stage('root', 'chat-1', 'proposed', { title: 'Buy milk', chatId: 'chat-1' });
  v = sc.snapshot('root');
  assert.equal(v[0].stage, 'proposed');
  assert.equal(v[0].title, 'Buy milk');
  assert.equal(v[0].chatId, 'chat-1');
});

test('monotonic: a stale out-of-order emit cannot move a capture backward', () => {
  const sc = makeSeedCells();
  sc.stage('root', 'c', 'understanding');
  sc.stage('root', 'c', 'received'); // stale — must NOT rewind
  assert.equal(sc.snapshot('root')[0].stage, 'understanding');
});

test('the cell pushes on every transition and catches a late subscriber up', () => {
  const sc = makeSeedCells();
  sc.stage('root', 'c', 'received');
  const seen = [];
  const unsub = sc.cellFor('root').subscribe(v => seen.push(v));
  assert.equal(seen.length, 1, 'late subscriber gets the CURRENT value immediately');
  assert.equal(seen[0][0].stage, 'received');
  sc.stage('root', 'c', 'understanding');
  sc.stage('root', 'c', 'proposed', { chatId: 'c' });
  assert.equal(seen.length, 3);
  assert.equal(seen[2][0].stage, 'proposed');
  unsub();
  sc.stage('root', 'c', 'done');
  assert.equal(seen.length, 3, 'unsubscribed → no more pushes');
});

test('owners are isolated: one owner never sees another owner\'s captures', () => {
  const sc = makeSeedCells();
  sc.stage('root', 'a', 'received');
  sc.stage('u:beef', 'b', 'received');
  assert.deepEqual(sc.snapshot('root').map(c => c.id), ['a']);
  assert.deepEqual(sc.snapshot('u:beef').map(c => c.id), ['b']);
});

test('TTL: a finished capture is pruned after its window; an in-flight one is kept', () => {
  let t = 1000;
  const sc = makeSeedCells({ ttlMs: 100, now: () => t });
  sc.stage('root', 'fin', 'proposed', { chatId: 'fin' });
  sc.stage('root', 'live', 'understanding');
  t = 1050; // within TTL
  sc.stage('root', 'live', 'understanding'); // re-emit drives a prune pass
  assert.equal(sc.snapshot('root').length, 2, 'both still present within TTL');
  t = 1200; // past TTL for the finished one
  sc.stage('root', 'live', 'understanding');
  const ids = sc.snapshot('root').map(c => c.id);
  assert.deepEqual(ids, ['live'], 'finished capture pruned; in-flight one kept');
});

test('bounds: an owner cannot grow past max (oldest fall off)', () => {
  let t = 0;
  const sc = makeSeedCells({ max: 3, now: () => (t += 1) });
  for (let i = 0; i < 6; i++) sc.stage('root', `c${i}`, 'understanding');
  const v = sc.snapshot('root');
  assert.equal(v.length, 3);
  assert.ok(v.every(c => Number(c.id.slice(1)) >= 3), 'the three most recent survive');
});

test('malformed calls are no-ops (unknown stage, missing id/owner)', () => {
  const sc = makeSeedCells();
  sc.stage('root', 'c', 'nonsense'); // unknown stage
  sc.stage('root', '', 'received'); // no id
  sc.stage('', 'c', 'received'); // no owner
  assert.equal(sc.snapshot('root').length, 0);
});
