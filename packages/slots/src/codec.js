// @ts-check

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import { makeMarshal } from '@endo/marshal';
import { isPromise } from '@endo/promise-kit';

import { Kind, descriptorKey } from './descriptor.js';
import {
  encodeDeliverPayload,
  decodeDeliverPayload,
  encodeResolvePayload,
  decodeResolvePayload,
} from './payload.js';

/** @import { Descriptor } from './descriptor.js' */
/** @import { DeliverPayload, ResolvePayload } from './payload.js' */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Wire slot strings are `"s<N>"` where N is the index into
 * [`DeliverPayload.targets`] / [`ResolvePayload.targets`].  All
 * capabilities (objects and promises) share a single flat array on
 * the wire; the descriptor's own kind byte distinguishes them.  The
 * [`DeliverPayload.promises`] field stays empty — the Rust supervisor
 * translates both arrays identically via `translate_slice`, so
 * collapsing them simplifies the codec without changing wire
 * semantics.
 */
const SLOT_TAG = 's';

// Canonical slot strings: `s` followed by either `0` or a non-zero
// digit run.  Reject leading zeros, signs, exponents, whitespace —
// the wire form must be deterministic so that both ends agree.
const SLOT_PATTERN = /^s(0|[1-9][0-9]*)$/;

const parseSlot = slot => {
  if (typeof slot !== 'string' || !SLOT_PATTERN.test(slot)) {
    throw makeError(X`invalid slot string ${q(slot)}`);
  }
  const idx = Number(slot.slice(1));
  if (!Number.isSafeInteger(idx)) {
    throw makeError(X`slot index ${q(slot)} exceeds safe-integer range`);
  }
  return idx;
};

/**
 * Create a slot-machine codec bound to a c-list: translates between
 * high-level call / resolution shapes and the wire-level payload
 * bytes, threading capabilities through the c-list's export/import
 * tables.
 *
 * @param {object} opts
 * @param {{
 *   exportLocal: (val: unknown, kind?: 0 | 1 | 2 | 3) => Descriptor,
 *   importRemote: (desc: Descriptor, make: () => unknown) => unknown,
 * }} opts.clist
 * @param {(desc: Descriptor) => unknown} opts.makePresence
 *   Called when decoding a remote descriptor that has no existing
 *   c-list entry.  The returned value represents the remote cap.
 * @param {string} [opts.marshalName]
 */
export const makeSlotCodec = ({
  clist,
  makePresence,
  marshalName = 'slots',
}) => {
  /** @type {Descriptor[]} */
  let encodingSlots = [];
  /** @type {Descriptor[]} */
  let decodingSlots = [];

  /**
   * @param {unknown} val
   * @returns {string}
   */
  const convertValToSlot = val => {
    const kind = isPromise(val) ? Kind.Promise : Kind.Object;
    const desc = clist.exportLocal(val, kind);
    const key = descriptorKey(desc);
    for (let i = 0; i < encodingSlots.length; i += 1) {
      if (descriptorKey(encodingSlots[i]) === key) {
        return `${SLOT_TAG}${i}`;
      }
    }
    const idx = encodingSlots.length;
    encodingSlots.push(desc);
    return `${SLOT_TAG}${idx}`;
  };

  /**
   * @param {string} slot
   * @returns {unknown}
   */
  const convertSlotToVal = slot => {
    const idx = parseSlot(slot);
    if (idx >= decodingSlots.length) {
      throw makeError(
        X`slot ${q(slot)} out of range (have ${q(decodingSlots.length)} entries)`,
      );
    }
    const desc = decodingSlots[idx];
    return clist.importRemote(desc, () => makePresence(desc));
  };

  const { toCapData, fromCapData } = makeMarshal(
    convertValToSlot,
    convertSlotToVal,
    {
      marshalName,
      serializeBodyFormat: 'smallcaps',
    },
  );

  /**
   * Export `target` into the c-list as its natural kind.
   *
   * @param {unknown} target
   * @returns {Descriptor}
   */
  const describe = target => {
    const kind = isPromise(target) ? Kind.Promise : Kind.Object;
    return clist.exportLocal(target, kind);
  };

  /**
   * Encode a delivery into wire-level `deliver` payload bytes.  The
   * body is one flat passable argument vector, following the OCapN
   * Body Content Format (`packages/ocapn/docs/cbor-encoding.md`):
   * function application sends its arguments unchanged, while a
   * method invocation prepends the method's passable-symbol selector
   * (the caller — `@endo/slots`'s client handlers — is responsible
   * for that prepend, exactly as `@endo/ocapn` does).
   *
   * @param {object} call
   * @param {unknown} call.target
   * @param {unknown[]} call.args the complete argument vector to place
   *   in the body, selector-prefixed already for a method invocation
   * @param {unknown} [call.reply] optional promise whose resolution
   *   will receive the call's return value (fire-and-forget if absent)
   * @returns {Uint8Array}
   */
  const encodeDeliver = ({ target, args, reply }) => {
    encodingSlots = [];
    const targetDesc = describe(target);
    const replyDesc =
      reply !== undefined
        ? clist.exportLocal(reply, Kind.Promise)
        : /** @type {Descriptor | null} */ (null);
    const { body } = toCapData(
      /** @type {import('@endo/pass-style').Passable} */ (harden([...args])),
    );
    /** @type {DeliverPayload} */
    const payload = {
      target: targetDesc,
      body: textEncoder.encode(body),
      targets: encodingSlots,
      promises: [],
      reply: replyDesc,
    };
    return encodeDeliverPayload(payload);
  };
  harden(encodeDeliver);

  /**
   * Decode `deliver` payload bytes back into the JS-level call shape:
   * the target and the flat argument vector carried in the body.
   * Object-vs-function dispatch (whether the leading argument is a
   * method selector) is decided by the receiver, not here.
   *
   * @param {Uint8Array} bytes
   * @returns {{
   *   target: unknown,
   *   args: unknown[],
   *   reply: unknown | null,
   * }}
   */
  const decodeDeliver = bytes => {
    const p = decodeDeliverPayload(bytes);
    decodingSlots = p.targets;
    const bodyStr = textDecoder.decode(p.body);
    const slotStrings = decodingSlots.map((_, i) => `${SLOT_TAG}${i}`);
    const decoded = fromCapData(harden({ body: bodyStr, slots: slotStrings }));
    if (!Array.isArray(decoded)) {
      throw makeError(
        X`deliver body must decode to an argument array, got ${q(decoded)}`,
      );
    }
    const target = clist.importRemote(p.target, () => makePresence(p.target));
    const replyDesc = p.reply;
    const reply =
      replyDesc === null
        ? null
        : clist.importRemote(replyDesc, () => makePresence(replyDesc));
    return { target, args: [...decoded], reply };
  };
  harden(decodeDeliver);

  /**
   * Encode a resolution into wire-level `resolve` payload bytes.
   *
   * @param {object} args
   * @param {unknown} args.target — the promise being resolved
   * @param {boolean} args.isReject
   * @param {unknown} args.value
   * @returns {Uint8Array}
   */
  const encodeResolve = ({ target, isReject, value }) => {
    encodingSlots = [];
    const targetDesc = clist.exportLocal(target, Kind.Promise);
    const { body } = toCapData(
      /** @type {import('@endo/pass-style').Passable} */ (harden(value)),
    );
    /** @type {ResolvePayload} */
    const payload = {
      target: targetDesc,
      isReject,
      body: textEncoder.encode(body),
      targets: encodingSlots,
      promises: [],
    };
    return encodeResolvePayload(payload);
  };
  harden(encodeResolve);

  /**
   * Decode `resolve` payload bytes.
   *
   * @param {Uint8Array} bytes
   */
  const decodeResolve = bytes => {
    const p = decodeResolvePayload(bytes);
    decodingSlots = p.targets;
    const bodyStr = textDecoder.decode(p.body);
    const slotStrings = decodingSlots.map((_, i) => `${SLOT_TAG}${i}`);
    const value = fromCapData(harden({ body: bodyStr, slots: slotStrings }));
    const target = clist.importRemote(p.target, () => makePresence(p.target));
    return { target, isReject: p.isReject, value };
  };
  harden(decodeResolve);

  return harden({
    encodeDeliver,
    decodeDeliver,
    encodeResolve,
    decodeResolve,
    describe,
  });
};
harden(makeSlotCodec);
