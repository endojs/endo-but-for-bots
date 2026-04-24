// @ts-nocheck

import test from '@endo/ses-ava/prepare-endo.js';
import { Far, E } from '@endo/far';

import { Direction, Kind } from '../src/descriptor.js';
import { makeCList } from '../src/clist.js';
import { makeSlotCodec } from '../src/codec.js';
import { makeSlotClient } from '../src/client.js';
import {
  VERB_DELIVER,
  VERB_RESOLVE,
  encodeDeliverPayload,
  decodeDeliverPayload,
  encodeResolvePayload,
  decodeResolvePayload,
  encodeDropPayload,
  decodeDropPayload,
} from '../src/payload.js';

/**
 * Build a pair of clients whose sends are relayed as if a
 * supervisor were translating descriptors between their frames.
 * The minimum the test stub does: flip direction on every
 * descriptor as the envelope crosses the boundary.  That mirrors
 * what `rust/endo/slots/src/wire/translate.rs::translate_deliver`
 * does once a kref round-trip has been established.
 */
const makeLoopback = () => {
  /** @type {((verb: string, payload: Uint8Array) => void) | null} */
  let recvA = null;
  /** @type {((verb: string, payload: Uint8Array) => void) | null} */
  let recvB = null;

  const buildSide = label => {
    const clist = makeCList({ label });
    const presences = new Map();
    const makePresence = desc => {
      // The client wires presences via its own makePresence; the
      // codec's factory is only invoked when the c-list doesn't
      // already have an entry for the descriptor — e.g. for
      // secondary args that arrive inside a deliver body.  For those
      // we fall back to a Far stub.
      const key = `${desc.dir}:${desc.kind}:${desc.position}`;
      if (!presences.has(key)) {
        presences.set(
          key,
          Far(`stub-${label}-${key}`, {
            describe() {
              return key;
            },
          }),
        );
      }
      return presences.get(key);
    };
    const codec = makeSlotCodec({ clist, makePresence, marshalName: label });
    const sendEnvelope = (verb, payload) => {
      // Flip direction on every descriptor: sender's Local becomes
      // the receiver's Remote.  This is what the supervisor's
      // translate_one does after looking up the kref.
      const flipped = flipEnvelope(verb, payload);
      const target = label === 'a' ? recvB : recvA;
      if (target) target(verb, flipped);
    };
    const client = makeSlotClient({ clist, codec, sendEnvelope });
    return { clist, codec, client, sendEnvelope };
  };

  const sideA = buildSide('a');
  const sideB = buildSide('b');

  recvA = sideA.client.onEnvelope;
  recvB = sideB.client.onEnvelope;

  return { a: sideA, b: sideB };
};

/**
 * Flip the direction bit of every descriptor in an envelope — the
 * minimal transformation a supervisor performs so that a sender's
 * "Local" references become the receiver's "Remote" references.
 * This reaches into the CBOR to patch `kindByte` bytes in place.
 *
 * For a loopback test where no c-list on either side has any
 * cross-references yet, flipping is sufficient.
 */
const flipDesc = d => ({ ...d, dir: d.dir === Direction.Local ? 1 : 0 });
const flipArr = arr => arr.map(flipDesc);

const flipEnvelope = (verb, payload) => {
  if (verb === VERB_DELIVER) {
    const p = decodeDeliverPayload(payload);
    return encodeDeliverPayload({
      target: flipDesc(p.target),
      body: p.body,
      targets: flipArr(p.targets),
      promises: flipArr(p.promises),
      reply: p.reply ? flipDesc(p.reply) : null,
    });
  }
  if (verb === VERB_RESOLVE) {
    const p = decodeResolvePayload(payload);
    return encodeResolvePayload({
      target: flipDesc(p.target),
      isReject: p.isReject,
      body: p.body,
      targets: flipArr(p.targets),
      promises: flipArr(p.promises),
    });
  }
  return payload;
};

test('makePresence returns a HandledPromise whose E() call encodes a deliver', async t => {
  const envelopes = [];
  const clist = makeCList({ label: 'caller' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'caller' });
  const sendEnvelope = (verb, payload) => envelopes.push({ verb, payload });
  const client = makeSlotClient({ clist, codec, sendEnvelope });

  const desc = { dir: Direction.Remote, kind: Kind.Object, position: 1 };
  const presence = client.makePresence(desc);

  const replyP = E(presence).ping();
  t.true(typeof replyP.then === 'function');
  // HandledPromise dispatches on the next microtask; yield once so the
  // handler's applyMethod has run.
  await null;
  t.is(envelopes.length, 1);
  t.is(envelopes[0].verb, VERB_DELIVER);
  t.is(client.pendingCount(), 1);
});

test('pendingCount decrements when a matching resolve arrives', async t => {
  const { a, b } = makeLoopback();

  // B exports a Remotable under a known local descriptor.
  const target = Far('target', {
    ping: () => 'pong',
  });
  const targetDesc = b.clist.exportLocal(target, Kind.Object);
  t.is(targetDesc.dir, Direction.Local);

  // A creates a presence for B's export.  Direction in A's frame is
  // Remote (B allocated it).
  const aPresenceDesc = { ...targetDesc, dir: Direction.Remote };
  const presence = a.client.makePresence(aPresenceDesc);

  const reply = E(presence).ping();
  await null;
  t.is(a.client.pendingCount(), 1);

  const result = await reply;
  t.is(result, 'pong');
  t.is(a.client.pendingCount(), 0);
});

test('rejections surface via is_reject', async t => {
  const { a, b } = makeLoopback();

  const target = Far('target', {
    boom: () => {
      throw Error('kaboom');
    },
  });
  const targetDesc = b.clist.exportLocal(target, Kind.Object);
  const presence = a.client.makePresence({
    ...targetDesc,
    dir: Direction.Remote,
  });

  await t.throwsAsync(() => E(presence).boom(), { message: /kaboom/ });
});

test('unknown resolve targets are silently ignored', t => {
  const clist = makeCList({ label: 'x' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'x' });
  const client = makeSlotClient({
    clist,
    codec,
    sendEnvelope: () => {},
  });
  // Craft a resolve for a target we never allocated.
  const bogus = codec.encodeResolve({
    target: Promise.resolve(),
    isReject: false,
    value: 42,
  });
  t.notThrows(() => client.onResolve(bogus));
});

test('send-only calls do not track a reply', async t => {
  const envelopes = [];
  const clist = makeCList({ label: 'caller' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'caller' });
  const sendEnvelope = (verb, payload) => envelopes.push({ verb, payload });
  const client = makeSlotClient({ clist, codec, sendEnvelope });

  const desc = { dir: Direction.Remote, kind: Kind.Object, position: 1 };
  const presence = client.makePresence(desc);

  E.sendOnly(presence).fireAndForget();
  await null;
  t.is(envelopes.length, 1);
  t.is(envelopes[0].verb, VERB_DELIVER);
  t.is(client.pendingCount(), 0);
});

test('drop sends a DropPayload envelope with the named pillars', t => {
  const envelopes = [];
  const clist = makeCList({ label: 'caller' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'caller' });
  const sendEnvelope = (verb, payload) => envelopes.push({ verb, payload });
  const client = makeSlotClient({ clist, codec, sendEnvelope });

  const desc = { dir: Direction.Remote, kind: Kind.Object, position: 5 };
  const presence = client.makePresence(desc);

  client.drop([{ presence, ram: 1 }]);
  t.is(envelopes.length, 1);
  t.is(envelopes[0].verb, 'drop');

  const deltas = decodeDropPayload(envelopes[0].payload);
  t.is(deltas.length, 1);
  t.is(deltas[0].target.position, 5);
  t.is(deltas[0].ram, 1);
  t.is(deltas[0].clist, 0);
  t.is(deltas[0].export, 0);
});

test('drop with an unknown presence throws', t => {
  const clist = makeCList({ label: 'caller' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'caller' });
  const client = makeSlotClient({
    clist,
    codec,
    sendEnvelope: () => {},
  });
  t.throws(() => client.drop([{ presence: { unknown: true } }]), {
    message: /not found in c-list/,
  });
});

test('onDrop decodes deltas for diagnostics', t => {
  const clist = makeCList({ label: 'receiver' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'receiver' });
  const client = makeSlotClient({
    clist,
    codec,
    sendEnvelope: () => {},
  });

  const bytes = encodeDropPayload([
    {
      target: { dir: Direction.Local, kind: Kind.Object, position: 3 },
      ram: 2,
      clist: 0,
      export: 1,
    },
  ]);
  const deltas = client.onDrop(bytes);
  t.is(deltas.length, 1);
  t.is(deltas[0].ram, 2);
  t.is(deltas[0].export, 1);
});

test('FinalizationRegistry hook auto-sends drop on GC', t => {
  // Fake FinalizationRegistry: collects registrations so the test
  // can fire them deterministically.
  const registrations = [];
  class FakeFR {
    constructor(cb) {
      this.cb = cb;
    }

    register(_target, held) {
      registrations.push({ held, cb: this.cb });
    }
  }

  const envelopes = [];
  const clist = makeCList({ label: 'caller' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'caller' });
  const sendEnvelope = (verb, payload) => envelopes.push({ verb, payload });
  const FR = /** @type {any} */ (FakeFR);
  const client = makeSlotClient({
    clist,
    codec,
    sendEnvelope,
    FinalizationRegistry: FR,
  });

  const desc = { dir: Direction.Remote, kind: Kind.Object, position: 9 };
  client.makePresence(desc);

  // Synthesise GC.
  t.is(envelopes.length, 0);
  for (const entry of registrations) entry.cb(entry.held);
  registrations.length = 0;

  t.is(envelopes.length, 1);
  t.is(envelopes[0].verb, 'drop');
  const deltas = decodeDropPayload(envelopes[0].payload);
  t.is(deltas.length, 1);
  t.is(deltas[0].target.position, 9);
  t.is(deltas[0].ram, 1);
});

test('FinalizationRegistry auto-drop absent when constructor omitted', t => {
  const envelopes = [];
  const clist = makeCList({ label: 'caller' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'caller' });
  const sendEnvelope = (verb, payload) => envelopes.push({ verb, payload });
  const client = makeSlotClient({
    clist,
    codec,
    sendEnvelope,
    // Explicitly disable auto-drop.
    FinalizationRegistry: undefined,
  });
  const desc = { dir: Direction.Remote, kind: Kind.Object, position: 9 };
  client.makePresence(desc);
  // No auto-drop fires — callers must drop explicitly.
  t.is(envelopes.length, 0);
});

test('onEnvelope routes drop to onDrop silently (return value dropped)', t => {
  const clist = makeCList({ label: 'receiver' });
  const makePresence = () => ({});
  const codec = makeSlotCodec({ clist, makePresence, marshalName: 'receiver' });
  const client = makeSlotClient({
    clist,
    codec,
    sendEnvelope: () => {},
  });

  const bytes = encodeDropPayload([]);
  t.notThrows(() => client.onEnvelope('drop', bytes));
  t.notThrows(() => client.onEnvelope('abort', new Uint8Array(0)));
});
