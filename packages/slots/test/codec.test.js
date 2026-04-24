// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { Direction, Kind } from '../src/descriptor.js';
import { makeCList } from '../src/clist.js';
import { makeSlotCodec } from '../src/codec.js';

const makeCodec = label => {
  const clist = makeCList({ label });
  const presences = new Map();
  const makePresence = desc => {
    const key = `${desc.dir}:${desc.kind}:${desc.position}`;
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

test('encodeDeliver emits method and args with no caps', t => {
  const { codec, clist } = makeCodec('a');
  const target = Far('target', { ping: () => 1 });
  const bytes = codec.encodeDeliver({
    target,
    method: 'ping',
    args: [42, 'hi'],
  });
  t.true(bytes instanceof Uint8Array);

  // Decode on a fresh remote c-list.  The remote sees the sender's
  // Local as Remote after `flipDirection`, but for this first test
  // we only check method + args shape, not frame-flipping semantics.
  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.is(decoded.method, 'ping');
  t.deepEqual(decoded.args, [42, 'hi']);
  t.is(decoded.reply, null);
  // Target descriptor for the sender's target is object-local.
  const targetDesc = /** @type {import('../src/descriptor.js').Descriptor} */ (
    clist.lookupByValue(target)
  );
  t.truthy(targetDesc);
  t.is(targetDesc.dir, Direction.Local);
  t.is(targetDesc.kind, Kind.Object);
});

test('encodeDeliver threads a Remotable arg through targets', t => {
  const { codec } = makeCodec('a');
  const target = Far('target', { call: () => undefined });
  const cap = Far('cap', {});
  const bytes = codec.encodeDeliver({ target, method: 'call', args: [cap] });

  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.is(decoded.method, 'call');
  t.is(decoded.args.length, 1);
  t.truthy(decoded.args[0]);
});

test('encodeDeliver threads a Promise arg through targets', t => {
  const { codec } = makeCodec('a');
  const target = Far('target', { callPromise: () => undefined });
  const { promise } = makePromiseKit();
  const bytes = codec.encodeDeliver({
    target,
    method: 'callPromise',
    args: [promise],
  });

  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.is(decoded.method, 'callPromise');
  t.is(decoded.args.length, 1);
});

test('encodeDeliver reply threads through to decode', t => {
  const { codec } = makeCodec('a');
  const target = Far('target', { ping: () => 1 });
  const { promise: reply } = makePromiseKit();
  const bytes = codec.encodeDeliver({
    target,
    method: 'ping',
    args: [],
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
    method: 'twice',
    args: [shared, shared],
  });
  const { codec: remote } = makeCodec('b');
  const decoded = remote.decodeDeliver(bytes);
  t.is(decoded.args.length, 2);
  t.is(decoded.args[0], decoded.args[1]);
});
