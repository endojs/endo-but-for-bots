// @ts-check

import { Direction } from './descriptor.js';
import {
  VERB_DELIVER,
  VERB_RESOLVE,
  VERB_DROP,
  encodeDeliverPayload,
  decodeDeliverPayload,
  encodeResolvePayload,
  decodeResolvePayload,
  encodeDropPayload,
  decodeDropPayload,
} from './payload.js';

/** @import { Descriptor } from './descriptor.js' */

/** @param {Descriptor} d */
const flipDesc = d => ({
  ...d,
  direction:
    d.direction === Direction.Local ? Direction.Remote : Direction.Local,
});

/** @param {Descriptor[]} arr */
const flipArr = arr => arr.map(flipDesc);

/**
 * Flip the direction bit of every descriptor in a slot-machine
 * envelope payload.  Used by peer-to-peer transports that don't
 * have a translating supervisor in between (the kref translation
 * the supervisor does collapses to a direction flip when both
 * sides start from the matching position-1 bootstrap).
 *
 * Apply once per hop — either on send or on receive, but not both.
 *
 * Verbs other than `deliver`/`resolve`/`drop` pass through
 * unchanged (`abort` carries no descriptors).
 *
 * @param {string} verb
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export const flipEnvelopePayload = (verb, payload) => {
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
  if (verb === VERB_DROP) {
    const deltas = decodeDropPayload(payload);
    return encodeDropPayload(
      deltas.map(d => ({
        target: flipDesc(d.target),
        ram: d.ram,
        clist: d.clist,
        export: d.export,
      })),
    );
  }
  return payload;
};
