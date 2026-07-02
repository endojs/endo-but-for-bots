// inbox-cells.test.mjs — unit coverage for the 🔔 bell/inbox propagator cells (inbox-cells.mjs).
// Pure logic, no server, no fs.watch (watch:false): a family's revision advances monotonically on bump(),
// the cell pushes on every bump, a late subscriber is caught up immediately, feed vs asks are independent,
// owners are isolated, and unknown families / non-root keys behave.
import '@endo/init'; // lockdown + harden, FIRST
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeInboxCells } from './inbox-cells.mjs';

test('bump advances a family revision and the cell reflects it', () => {
  const ic = makeInboxCells({ watch: false });
  assert.deepEqual(ic.snapshot('feed'), { rev: 0, at: 0 });
  ic.bump('feed');
  assert.equal(ic.snapshot('feed').rev, 1);
  ic.bump('feed');
  assert.equal(ic.snapshot('feed').rev, 2);
  assert.equal(ic.snapshot('asks').rev, 0, 'asks untouched by a feed bump');
});

test('the cell PUSHES on every bump and catches a late subscriber up', () => {
  const ic = makeInboxCells({ watch: false });
  ic.bump('feed'); // one change before anyone subscribes
  const seen = [];
  const unsub = ic.cellFor('feed', 'root').subscribe(v => seen.push(v));
  assert.equal(seen.length, 1, 'late subscriber gets the CURRENT value immediately');
  assert.equal(seen[0].rev, 1);
  ic.bump('feed');
  ic.bump('feed');
  assert.equal(seen.length, 3);
  assert.equal(seen[2].rev, 3);
  unsub();
  ic.bump('feed');
  assert.equal(seen.length, 3, 'unsubscribed → no more pushes');
});

test('feed and asks families are independent streams', () => {
  const ic = makeInboxCells({ watch: false });
  const feedSeen = []; const asksSeen = [];
  ic.cellFor('feed', 'root').subscribe(v => feedSeen.push(v.rev));
  ic.cellFor('asks', 'root').subscribe(v => asksSeen.push(v.rev));
  ic.bump('asks');
  assert.deepEqual(feedSeen, [0], 'a feed subscriber does not hear an asks bump');
  assert.deepEqual(asksSeen, [0, 1]);
});

test('owners are isolated: a bump on root does not push another owner', () => {
  const ic = makeInboxCells({ watch: false });
  const rootSeen = []; const uSeen = [];
  ic.cellFor('feed', 'root').subscribe(v => rootSeen.push(v.rev));
  ic.cellFor('feed', 'u:beef').subscribe(v => uSeen.push(v.rev));
  ic.bump('feed'); // defaults to 'root'
  assert.deepEqual(rootSeen, [0, 1]);
  assert.deepEqual(uSeen, [0], 'the non-root owner stays idle (empty inbox)');
});

test('a bad family is a no-op; snapshot coerces to feed', () => {
  const ic = makeInboxCells({ watch: false });
  ic.bump('nonsense');
  assert.equal(ic.snapshot('feed').rev, 0);
  assert.equal(ic.snapshot('asks').rev, 0);
});

test('cellFor returns a stable cell per (family, owner)', () => {
  const ic = makeInboxCells({ watch: false });
  assert.equal(ic.cellFor('feed', 'root'), ic.cellFor('feed', 'root'));
  assert.notEqual(ic.cellFor('feed', 'root'), ic.cellFor('asks', 'root'));
});
