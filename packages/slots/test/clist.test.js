// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Direction, Kind } from '../src/descriptor.js';
import { makeCList } from '../src/clist.js';

test('exportLocal allocates monotonic positions per kind', t => {
  const c = makeCList({ label: 'w' });
  const a = c.exportLocal({}, Kind.Object);
  const b = c.exportLocal({}, Kind.Object);
  t.is(a.position, 1);
  t.is(b.position, 2);
  t.is(a.dir, Direction.Local);
  t.is(b.kind, Kind.Object);
});

test('exportLocal answer counter starts at 0', t => {
  const c = makeCList({ label: 'w' });
  t.is(c.exportLocal({}, Kind.Answer).position, 0);
  t.is(c.exportLocal({}, Kind.Answer).position, 1);
});

test('exportLocal is idempotent on the same value', t => {
  const c = makeCList({ label: 'w' });
  const obj = {};
  const a = c.exportLocal(obj, Kind.Object);
  const b = c.exportLocal(obj, Kind.Object);
  t.is(a.position, b.position);
  t.is(c.size(), 1);
});

test('kinds get independent counters', t => {
  const c = makeCList({ label: 'w' });
  t.is(c.exportLocal({}, Kind.Object).position, 1);
  t.is(c.exportLocal({}, Kind.Promise).position, 1);
  t.is(c.exportLocal({}, Kind.Device).position, 1);
});

test('importRemote creates and memoises a placeholder', t => {
  const c = makeCList({ label: 'w' });
  const desc = { dir: Direction.Remote, kind: Kind.Object, position: 42 };
  let makes = 0;
  const make = () => {
    makes += 1;
    return { marker: makes };
  };
  const first = c.importRemote(desc, make);
  const second = c.importRemote(desc, make);
  t.is(first, second);
  t.is(makes, 1);
});

test('lookupByDescriptor and lookupByValue are inverses', t => {
  const c = makeCList({ label: 'w' });
  const val = { label: 'thing' };
  const desc = c.exportLocal(val, Kind.Object);
  t.is(c.lookupByDescriptor(desc), val);
  t.deepEqual(c.lookupByValue(val), desc);
});

test('drop removes both directions of the mapping', t => {
  const c = makeCList({ label: 'w' });
  const val = { label: 'thing' };
  const desc = c.exportLocal(val, Kind.Object);
  t.true(c.drop(desc));
  t.is(c.lookupByDescriptor(desc), undefined);
  t.is(c.lookupByValue(val), undefined);
  t.false(c.drop(desc));
});

test('id is stable for a given label', t => {
  const a = makeCList({ label: 'worker-7' });
  const b = makeCList({ label: 'worker-7' });
  t.deepEqual([...a.id], [...b.id]);
});
