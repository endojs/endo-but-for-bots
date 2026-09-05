// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { nameForPassableSymbol } from '@endo/pass-style';

import { Direction, Kind } from '../src/descriptor.js';
import { makeCList } from '../src/clist.js';
import { makeSlotCodec } from '../src/codec.js';
import { makeSelector } from '../src/selector.js';

const makeCodec = label => {
  const clist = makeCList({ label });
  const presences = new Map();
  const makePresence = desc => {
    const key = `${desc.direction}:${desc.kind}:${desc.position}`;
    if (!presences.has(key)) {
      if (desc.kind === Kind.Promise) {
        const { promise } = makePromiseKit();
        presences.set(key, promise);
      } else {
        presences.set(
          key,
          Far(`presence-${key}`, {
            describe() {
              return key;
            },
          }),
        );
      }
    }
    return presences.get(key);
  };
  const codec = makeSlotCodec({
    clist,
    makePresence,
    marshalName: label,
  });
  return { clist, codec, makePresence };
};

test('encodeDeliver emits a flat argument vector with no caps', t => {
  const { codec, clist } = makeCodec('a');
  const target = Far('target', { ping: () => 1 });
  const bytes = codec.encodeDeliver({
    target,
    args: [42, 'hi'],
  });
  t.true(bytes instanceof Uint8Array);

  // Decode on a fresh remote c-list.  The remote sees the sender's
  // Local as Remote after `flipDirection`, but for this first test
  // we only check the argument-vector shape, not frame-flipping.
  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.deepEqual(decoded.args, [42, 'hi']);
  t.is(decoded.reply, null);
  // Target descriptor for the sender's target is object-local.
  const targetDesc = /** @type {import('../src/descriptor.js').Descriptor} */ (
    clist.lookupByValue(target)
  );
  t.truthy(targetDesc);
  t.is(targetDesc.direction, Direction.Local);
  t.is(targetDesc.kind, Kind.Object);
});

test('encodeDeliver pins a leading passable-selector for a method call', t => {
  const { codec } = makeCodec('a');
  const target = Far('target', { transfer: () => undefined });
  // Method invocation prepends the method's selector symbol; a plain
  // function application would omit it (see the function-style case
  // below).
  const bytes = codec.encodeDeliver({
    target,
    args: [makeSelector('transfer'), 'recipient', 100],
  });

  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.is(decoded.args.length, 3);
  const [selector, ...rest] = decoded.args;
  t.is(typeof selector, 'symbol');
  t.is(nameForPassableSymbol(/** @type {symbol} */ (selector)), 'transfer');
  t.deepEqual(rest, ['recipient', 100]);
});

test('encodeDeliver carries a function-style vector with no selector', t => {
  const { codec } = makeCodec('a');
  const target = Far('fn', () => undefined);
  const bytes = codec.encodeDeliver({ target, args: ['x', 100] });

  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.deepEqual(decoded.args, ['x', 100]);
  // No leading symbol — the whole vector is the function's arguments.
  t.not(typeof decoded.args[0], 'symbol');
});

test('encodeDeliver threads a Remotable arg through targets', t => {
  const { codec } = makeCodec('a');
  const target = Far('target', { call: () => undefined });
  const cap = Far('cap', {});
  const bytes = codec.encodeDeliver({
    target,
    args: [makeSelector('call'), cap],
  });

  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.is(nameForPassableSymbol(/** @type {symbol} */ (decoded.args[0])), 'call');
  t.is(decoded.args.length, 2);
  t.truthy(decoded.args[1]);
});

test('encodeDeliver threads a Promise arg through targets', t => {
  const { codec } = makeCodec('a');
  const target = Far('target', { callPromise: () => undefined });
  const { promise } = makePromiseKit();
  const bytes = codec.encodeDeliver({
    target,
    args: [makeSelector('callPromise'), promise],
  });

  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.is(
    nameForPassableSymbol(/** @type {symbol} */ (decoded.args[0])),
    'callPromise',
  );
  t.is(decoded.args.length, 2);
});

test('encodeDeliver reply threads through to decode', t => {
  const { codec } = makeCodec('a');
  const target = Far('target', { ping: () => 1 });
  const { promise: reply } = makePromiseKit();
  const bytes = codec.encodeDeliver({
    target,
    args: [makeSelector('ping')],
    reply,
  });
  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.not(decoded.reply, null);
});

test('encodeResolve roundtrips a simple value', t => {
  const { codec } = makeCodec('a');
  const { promise } = makePromiseKit();
  const bytes = codec.encodeResolve({
    target: promise,
    isReject: false,
    value: { ok: true, count: 7 },
  });
  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeResolve(bytes);
  t.is(decoded.isReject, false);
  t.deepEqual(decoded.value, { ok: true, count: 7 });
});

test('encodeResolve carries is_reject flag', t => {
  const { codec } = makeCodec('a');
  const { promise } = makePromiseKit();
  const bytes = codec.encodeResolve({
    target: promise,
    isReject: true,
    value: 'error reason',
  });
  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeResolve(bytes);
  t.is(decoded.isReject, true);
  t.is(decoded.value, 'error reason');
});

test('same value used twice in args shares a single slot', t => {
  const { codec } = makeCodec('a');
  const target = Far('target', {});
  const shared = Far('shared', {});
  const bytes = codec.encodeDeliver({
    target,
    args: [makeSelector('twice'), shared, shared],
  });
  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.is(decoded.args.length, 3);
  t.is(decoded.args[1], decoded.args[2]);
});
