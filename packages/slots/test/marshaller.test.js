// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { Direction, Kind } from '../src/descriptor.js';
import { makeCList } from '../src/clist.js';
import { makeSlotMarshaller } from '../src/marshaller.js';

const makeMarshaller = label => {
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
  const m = makeSlotMarshaller({
    clist,
    makePresence,
    marshalName: label,
  });
  return { clist, m, makePresence };
};

test('packDeliver encodes method and args with no caps', t => {
  const { m, clist } = makeMarshaller('a');
  const target = Far('target', { ping: () => 1 });
  const bytes = m.packDeliver({ target, method: 'ping', args: [42, 'hi'] });
  t.true(bytes instanceof Uint8Array);

  // Unpack on a fresh remote c-list.  The remote sees the sender's
  // Local as Remote after `flipDirection`, but for this first test we
  // only check method + args shape, not frame-flipping semantics.
  const { m: remote } = makeMarshaller('b');
  // Simulate the supervisor's descriptor translation: flip direction
  // on the target (sender's Local → recipient's Remote).
  // For this unit test we skip the flip and rely on the simple case
  // of decoding the same bytes locally.
  const decoded = remote.unpackDeliver(bytes);
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

test('packDeliver threads a Remotable arg through targets', t => {
  const { m } = makeMarshaller('a');
  const target = Far('target', { call: () => undefined });
  const cap = Far('cap', {});
  const bytes = m.packDeliver({ target, method: 'call', args: [cap] });

  const { m: remote } = makeMarshaller('b');
  const decoded = remote.unpackDeliver(bytes);
  t.is(decoded.method, 'call');
  t.is(decoded.args.length, 1);
  // The arg is a presence stand-in on the remote side.
  t.truthy(decoded.args[0]);
});

test('packDeliver threads a Promise arg through targets', t => {
  const { m } = makeMarshaller('a');
  const target = Far('target', { callPromise: () => undefined });
  const { promise } = makePromiseKit();
  const bytes = m.packDeliver({
    target,
    method: 'callPromise',
    args: [promise],
  });

  const { m: remote } = makeMarshaller('b');
  const decoded = remote.unpackDeliver(bytes);
  t.is(decoded.method, 'callPromise');
  t.is(decoded.args.length, 1);
});

test('packDeliver reply threads through to unpack', t => {
  const { m } = makeMarshaller('a');
  const target = Far('target', { ping: () => 1 });
  const { promise: reply } = makePromiseKit();
  const bytes = m.packDeliver({ target, method: 'ping', args: [], reply });
  const { m: remote } = makeMarshaller('b');
  const decoded = remote.unpackDeliver(bytes);
  t.not(decoded.reply, null);
});

test('packResolve roundtrips a simple value', t => {
  const { m } = makeMarshaller('a');
  const { promise } = makePromiseKit();
  const bytes = m.packResolve({
    target: promise,
    isReject: false,
    value: { ok: true, count: 7 },
  });
  const { m: remote } = makeMarshaller('b');
  const decoded = remote.unpackResolve(bytes);
  t.is(decoded.isReject, false);
  t.deepEqual(decoded.value, { ok: true, count: 7 });
});

test('packResolve carries is_reject flag', t => {
  const { m } = makeMarshaller('a');
  const { promise } = makePromiseKit();
  const bytes = m.packResolve({
    target: promise,
    isReject: true,
    value: 'error reason',
  });
  const { m: remote } = makeMarshaller('b');
  const decoded = remote.unpackResolve(bytes);
  t.is(decoded.isReject, true);
  t.is(decoded.value, 'error reason');
});

test('same value used twice in args shares a single slot', t => {
  const { m } = makeMarshaller('a');
  const target = Far('target', {});
  const shared = Far('shared', {});
  const bytes = m.packDeliver({
    target,
    method: 'twice',
    args: [shared, shared],
  });
  // Decode the wire to count descriptors in targets.
  // deliver is a 5-element CBOR array; targets is the 3rd element.
  // Quick sanity: rely on remote unpack to produce the same presence twice.
  const { m: remote } = makeMarshaller('b');
  const decoded = remote.unpackDeliver(bytes);
  t.is(decoded.args.length, 2);
  t.is(decoded.args[0], decoded.args[1]);
});
