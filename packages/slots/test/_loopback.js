// @ts-nocheck

// Shared loopback helper for slot-machine client tests.  Two clients
// exchange envelopes via a synthetic supervisor that flips descriptor
// direction bits — the minimal transformation the Rust supervisor
// performs after a kref round-trip is established.  For bootstrap
// cases (both sides initialising with matching position-1 roots),
// flipping is sufficient without a full kref table.

import { Far } from '@endo/far';

import { Direction } from '../src/descriptor.js';
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
} from '../src/payload.js';

const flipDesc = d => ({
  ...d,
  dir: d.dir === Direction.Local ? 1 : 0,
});
const flipArr = arr => arr.map(flipDesc);

/**
 * Flip the direction bit of every descriptor in an envelope.  The
 * real Rust supervisor looks up each descriptor through the kref
 * registry; in this loopback the flip is equivalent whenever the
 * peers have symmetric bootstrap state.
 */
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

/**
 * Build a pair of clients connected through a flipping loopback.
 * Returns `{ a, b }` where each side has `{ clist, codec, client }`.
 */
export const makeLoopback = () => {
  let recvA = null;
  let recvB = null;

  const buildSide = label => {
    const clist = makeCList({ label });
    let clientRef = null;
    const makePresence = desc => {
      // Forward to the client so that descriptors threaded through
      // deliver/resolve args become properly E()-callable presences.
      // The clientRef is patched in after makeSlotClient is built
      // below; until then we never get here (no inbound envelopes
      // yet) so an unconditional delegation is safe.
      if (clientRef) return clientRef.makePresence(desc);
      return Far(`bootstrap-${label}`, {});
    };
    const codec = makeSlotCodec({ clist, makePresence, marshalName: label });
    const sendEnvelope = (verb, payload) => {
      const flipped = flipEnvelope(verb, payload);
      const target = label === 'a' ? recvB : recvA;
      if (target) target(verb, flipped);
    };
    const client = makeSlotClient({ clist, codec, sendEnvelope });
    clientRef = client;
    return { clist, codec, client };
  };

  const a = buildSide('a');
  const b = buildSide('b');
  recvA = a.client.onEnvelope;
  recvB = b.client.onEnvelope;
  return { a, b };
};
