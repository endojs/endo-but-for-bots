// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Direction, Kind } from '../src/descriptor.js';
import {
  encodeDeliver,
  decodeDeliver,
  encodeResolve,
  decodeResolve,
  encodeDrop,
  decodeDrop,
  encodeAbort,
  decodeAbort,
  VERB_DELIVER,
  VERB_RESOLVE,
  VERB_DROP,
  VERB_ABORT,
  isSlotVerb,
} from '../src/payload.js';

const D = (dir, kind, position) => ({ dir, kind, position });

test('deliver — roundtrip with reply', t => {
  const p = {
    target: D(Direction.Remote, Kind.Object, 7),
    body: new TextEncoder().encode('hello'),
    targets: [D(Direction.Local, Kind.Object, 1)],
    promises: [],
    reply: D(Direction.Local, Kind.Promise, 2),
  };
  const bytes = encodeDeliver(p);
  const p2 = decodeDeliver(bytes);
  t.deepEqual(p2.target, p.target);
  t.deepEqual([...p2.body], [...p.body]);
  t.deepEqual(p2.targets, p.targets);
  t.deepEqual(p2.promises, p.promises);
  t.deepEqual(p2.reply, p.reply);
});

test('deliver — fire-and-forget (null reply)', t => {
  const p = {
    target: D(Direction.Remote, Kind.Object, 7),
    body: new Uint8Array(0),
    targets: [],
    promises: [],
    reply: null,
  };
  const bytes = encodeDeliver(p);
  const p2 = decodeDeliver(bytes);
  t.is(p2.reply, null);
});

test('deliver — 5-element array header in wire bytes', t => {
  const p = {
    target: D(Direction.Local, Kind.Object, 0),
    body: new Uint8Array(0),
    targets: [],
    promises: [],
    reply: null,
  };
  const bytes = encodeDeliver(p);
  // First byte is array(5) = 0x85.
  t.is(bytes[0], 0x85);
});

test('resolve — roundtrip reject', t => {
  const p = {
    target: D(Direction.Local, Kind.Promise, 42),
    isReject: true,
    body: new TextEncoder().encode('error-data'),
    targets: [],
    promises: [D(Direction.Remote, Kind.Promise, 5)],
  };
  const bytes = encodeResolve(p);
  const p2 = decodeResolve(bytes);
  t.deepEqual(p2.target, p.target);
  t.is(p2.isReject, true);
  t.deepEqual([...p2.body], [...p.body]);
  t.deepEqual(p2.promises, p.promises);
});

test('resolve — decode rejects is_reject > 1', t => {
  // Manually craft a resolve where is_reject=2.
  // Start with a valid resolve, then patch the is_reject byte.
  const p = {
    target: D(Direction.Local, Kind.Promise, 0),
    isReject: false,
    body: new Uint8Array(0),
    targets: [],
    promises: [],
  };
  const bytes = encodeResolve(p);
  // Layout: [0x85, descriptor(3), is_reject(1), body_hdr(1), targets_hdr(1), promises_hdr(1)]
  // descriptor(Local, Promise, 0) = [0x82, 0x02, 0x00] (3 bytes)
  // byte 4 is is_reject.
  const mutated = new Uint8Array(bytes);
  mutated[4] = 0x02;
  t.throws(() => decodeResolve(mutated), { message: /0 or 1/ });
});

test('drop — empty and multi-entry roundtrips', t => {
  t.deepEqual(decodeDrop(encodeDrop([])), []);

  const deltas = [
    { target: D(Direction.Local, Kind.Object, 1), ram: 1, clist: 0, export: 0 },
    {
      target: D(Direction.Remote, Kind.Promise, 9),
      ram: 0,
      clist: 1,
      export: 1,
    },
  ];
  const bytes = encodeDrop(deltas);
  const decoded = decodeDrop(bytes);
  t.deepEqual(decoded, deltas);
});

test('abort — utf-8 reason roundtrip', t => {
  const msg = 'worker exited';
  const bytes = encodeAbort(msg);
  t.is(decodeAbort(bytes), msg);
});

test('abort — non-ASCII utf-8 passes through', t => {
  const msg = 'σ-algebra 💥';
  t.is(decodeAbort(encodeAbort(msg)), msg);
});

test('verb constants and isSlotVerb', t => {
  t.is(VERB_DELIVER, 'deliver');
  t.is(VERB_RESOLVE, 'resolve');
  t.is(VERB_DROP, 'drop');
  t.is(VERB_ABORT, 'abort');
  t.true(isSlotVerb('deliver'));
  t.true(isSlotVerb('resolve'));
  t.true(isSlotVerb('drop'));
  t.true(isSlotVerb('abort'));
  t.false(isSlotVerb('spawn'));
  t.false(isSlotVerb(''));
});

test('deliver — trailing bytes rejected', t => {
  const p = {
    target: D(Direction.Local, Kind.Object, 0),
    body: new Uint8Array(0),
    targets: [],
    promises: [],
    reply: null,
  };
  const bytes = encodeDeliver(p);
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes);
  t.throws(() => decodeDeliver(padded), { message: /trailing byte/ });
});
