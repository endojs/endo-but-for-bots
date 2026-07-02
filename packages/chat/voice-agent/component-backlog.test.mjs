// component-backlog.test.mjs — unit coverage for the per-component/fork backlog store
// (component-backlog.mjs). Pure logic, no server: items merge (dedupe-by-count lattice join),
// bounds hold, status verbs work, and the propagator cell PUSHES on every mutation.
import '@endo/init'; // lockdown + harden, FIRST
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeComponentBacklog } from './component-backlog.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-test-'));
const setup = (opts = {}) => {
  const dir = tmp();
  const file = path.join(dir, 'backlog.json');
  return { dir, file, backlog: makeComponentBacklog({ file, ...opts }) };
};

test('creation endowment: ensure() makes an EMPTY backlog keyed by the component id', () => {
  const { backlog } = setup();
  assert.equal(backlog.ensure('uicomp-abc123'), true);
  assert.deepEqual(backlog.list('uicomp-abc123'), []);
  assert.deepEqual(backlog.counts('uicomp-abc123'), { open: 0, total: 0 });
  assert.equal(backlog.ensure(''), false, 'no id → no backlog');
});

test('add files an item with kind/title/body/from + open status', () => {
  const { backlog } = setup();
  const r = backlog.add('fork-aa11', { kind: 'error', title: 'x is not defined', body: 'source began: (e,p)=>…', from: 'runtime' });
  assert.equal(r.ok, true);
  assert.equal(r.deduped, false);
  const [it] = backlog.list('fork-aa11');
  assert.equal(it.kind, 'error');
  assert.equal(it.title, 'x is not defined');
  assert.equal(it.from, 'runtime');
  assert.equal(it.status, 'open');
  assert.equal(it.count, 1);
});

test('merge discipline: same kind+title dedupes into count (monotonic join), not a duplicate row', () => {
  const { backlog } = setup();
  backlog.add('fork-aa11', { kind: 'error', title: 'boom', from: 'runtime' });
  const r2 = backlog.add('fork-aa11', { kind: 'error', title: 'boom', from: 'runtime' });
  assert.equal(r2.deduped, true);
  assert.equal(r2.count, 2);
  assert.equal(backlog.list('fork-aa11').length, 1);
  // a DIFFERENT kind with the same title is new information → its own row
  backlog.add('fork-aa11', { kind: 'issue', title: 'boom', from: 'owner' });
  assert.equal(backlog.list('fork-aa11').length, 2);
  // a RESOLVED item does not absorb a fresh report — the recurrence re-opens as a new row
  const [first] = backlog.list('fork-aa11');
  backlog.setStatus('fork-aa11', first.id, 'done');
  const r3 = backlog.add('fork-aa11', { kind: 'error', title: 'boom', from: 'runtime' });
  assert.equal(r3.deduped, false, 'a done item is not the join target — the error came BACK');
});

test('unknown kind coerces to issue; empty title refused; bad status refused cleanly', () => {
  const { backlog } = setup();
  const r = backlog.add('uicomp-x', { kind: 'weird', title: 'hello' });
  assert.equal(backlog.list('uicomp-x')[0].kind, 'issue');
  assert.equal(backlog.add('uicomp-x', { kind: 'issue', title: '   ' }).ok, false);
  assert.equal(backlog.setStatus('uicomp-x', 'bl-nope', 'done').ok, false);
  assert.equal(backlog.setStatus('uicomp-x', r.id, 'sideways').ok, true, 'unknown status coerces to done');
  assert.equal(backlog.list('uicomp-x')[0].status, 'done');
});

test('ack/done clear the OPEN view (and re-open restores it)', () => {
  const { backlog } = setup();
  const a = backlog.add('uicomp-x', { kind: 'issue', title: 'one' });
  backlog.add('uicomp-x', { kind: 'issue', title: 'two' });
  assert.equal(backlog.open('uicomp-x').length, 2);
  backlog.setStatus('uicomp-x', a.id, 'ack');
  assert.equal(backlog.open('uicomp-x').length, 1);
  assert.deepEqual(backlog.counts('uicomp-x'), { open: 1, total: 2 });
  backlog.setStatus('uicomp-x', a.id, 'open');
  assert.equal(backlog.open('uicomp-x').length, 2);
});

test('bounded: past maxItems, resolved items fall off first, then the oldest', () => {
  const { backlog } = setup({ maxItems: 5 });
  for (let i = 0; i < 5; i++) backlog.add('fork-b', { kind: 'issue', title: `t${i}` });
  const items = backlog.list('fork-b');
  backlog.setStatus('fork-b', items[2].id, 'done');
  backlog.add('fork-b', { kind: 'issue', title: 't5' });
  const after = backlog.list('fork-b');
  assert.equal(after.length, 5, 'bounded at maxItems');
  assert.ok(!after.some(it => it.title === 't2'), 'the resolved item was evicted first');
  backlog.add('fork-b', { kind: 'issue', title: 't6' });
  const after2 = backlog.list('fork-b');
  assert.equal(after2.length, 5);
  assert.ok(!after2.some(it => it.title === 't0'), 'no resolved items left → oldest falls off');
});

test('the cell PUSHES a fresh snapshot on add and on setStatus (propagator, not poll)', () => {
  const { backlog } = setup();
  const cell = backlog.cellFor('fork-cell');
  const seen = [];
  const unsub = cell.subscribe(v => seen.push(v));
  assert.equal(seen.length, 1, 'a late subscriber is caught up immediately');
  assert.deepEqual(seen[0].counts, { open: 0, total: 0 });
  const r = backlog.add('fork-cell', { kind: 'error', title: 'boom', from: 'runtime' });
  assert.equal(seen.length, 2, 'add pushed');
  assert.equal(seen[1].counts.open, 1);
  assert.equal(seen[1].open[0].title, 'boom');
  backlog.add('fork-cell', { kind: 'error', title: 'boom', from: 'runtime' }); // dedupe still pushes (count changed = new info)
  assert.equal(seen[2].open[0].count, 2);
  backlog.setStatus('fork-cell', r.id, 'ack');
  assert.equal(seen[3].counts.open, 0, 'ack pushed the cleared open view');
  unsub();
  backlog.add('fork-cell', { kind: 'issue', title: 'after unsub' });
  assert.equal(seen.length, 4, 'unsubscribed — no more pushes');
});

test('cell value is render-safe pure data (JSON round-trips; no functions/secrets)', () => {
  const { backlog } = setup();
  backlog.add('fork-safe', { kind: 'issue', title: 'hi', from: 'share-deadbeef' });
  const v = backlog.cellFor('fork-safe').get();
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});

test('contextNote carries the open view for the edit-chat agent; empty when clear', () => {
  const { backlog } = setup();
  assert.equal(backlog.contextNote('fork-n', 'My fork'), '');
  backlog.add('fork-n', { kind: 'error', title: 'x is not defined', from: 'runtime' });
  backlog.add('fork-n', { kind: 'issue', title: 'make it teal', from: 'share-ab12cd34' });
  const note = backlog.contextNote('fork-n', 'My fork');
  assert.ok(/OPEN BACKLOG for "My fork"/.test(note));
  assert.ok(/\[error\] x is not defined/.test(note));
  assert.ok(/\[issue\] make it teal/.test(note));
  assert.ok(/resolveBacklogItem/.test(note));
});

test('persistence: a reloaded store sees the same items', () => {
  const { file, backlog } = setup();
  backlog.add('uicomp-p', { kind: 'issue', title: 'persists' });
  const again = makeComponentBacklog({ file });
  assert.equal(again.list('uicomp-p')[0].title, 'persists');
});

test('remove drops the whole backlog (and pushes the empty view)', () => {
  const { backlog } = setup();
  backlog.add('uicomp-r', { kind: 'issue', title: 'gone soon' });
  const seen = [];
  backlog.cellFor('uicomp-r').subscribe(v => seen.push(v));
  assert.equal(backlog.remove('uicomp-r'), true);
  assert.deepEqual(backlog.counts('uicomp-r'), { open: 0, total: 0 });
  assert.equal(seen[seen.length - 1].counts.total, 0);
});

test('SEC-15 addOnlyFacet: STRUCTURAL add-only — bound to one id, exposes ONLY add', () => {
  const { backlog } = setup();
  const facet = backlog.addOnlyFacet('uicomp-sec15');
  // the facet's SHAPE is the boundary: it carries add and nothing else (no read/list/resolve/remove).
  assert.deepEqual(Object.keys(facet), ['add'], 'facet exposes exactly { add }');
  for (const forbidden of ['list', 'open', 'counts', 'setStatus', 'remove', 'cellFor', 'contextNote']) {
    assert.equal(facet[forbidden], undefined, `facet must NOT expose ${forbidden}`);
  }
  // it files against the id it was bound to…
  const r = facet.add({ kind: 'issue', title: 'reported via share link', from: 'abc' });
  assert.equal(r.ok, true);
  assert.equal(backlog.list('uicomp-sec15').length, 1, 'the add landed on the bound component');
  // …and CANNOT reach any other component's backlog (add ignores any id in the item payload).
  facet.add({ id: 'uicomp-other', kind: 'issue', title: 'attempt to cross-file' });
  assert.deepEqual(backlog.counts('uicomp-other'), { open: 0, total: 0 }, 'no cross-object write');
  assert.equal(backlog.list('uicomp-sec15').length, 2, 'the second add also stayed on the bound id');
});

test('SEC-15 addOnlyFacet is frozen (hardened) — cannot be augmented with a read verb', () => {
  const { backlog } = setup();
  const facet = backlog.addOnlyFacet('uicomp-frozen');
  assert.throws(() => { facet.list = () => 'leak'; }, 'hardened facet refuses new properties');
});
