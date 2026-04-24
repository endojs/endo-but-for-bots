// @ts-check

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import { makeMarshal } from '@endo/marshal';
import { isPromise } from '@endo/promise-kit';

import { Kind, descriptorKey } from './descriptor.js';
import {
  encodeDeliver,
  decodeDeliver,
  encodeResolve,
  decodeResolve,
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
 * collapsing them simplifies the marshaller without changing wire
 * semantics.
 */
const SLOT_TAG = 's';

const parseSlot = slot => {
  if (slot[0] !== SLOT_TAG) {
    throw makeError(X`invalid slot string ${q(slot)}`);
  }
  const idx = Number(slot.slice(1));
  if (!Number.isInteger(idx) || idx < 0) {
    throw makeError(X`invalid slot index in ${q(slot)}`);
  }
  return idx;
};

/**
 * Create a slot-machine-aware marshaller bound to a c-list.
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
export const makeSlotMarshaller = ({
  clist,
  makePresence,
  marshalName = 'slots',
}) => {
  /** @type {Descriptor[]} */
  let packingSlots = [];
  /** @type {Descriptor[]} */
  let unpackingSlots = [];

  /**
   * @param {unknown} val
   * @returns {string}
   */
  const convertValToSlot = val => {
    const kind = isPromise(val) ? Kind.Promise : Kind.Object;
    const desc = clist.exportLocal(val, kind);
    const key = descriptorKey(desc);
    for (let i = 0; i < packingSlots.length; i += 1) {
      if (descriptorKey(packingSlots[i]) === key) {
        return `${SLOT_TAG}${i}`;
      }
    }
    const idx = packingSlots.length;
    packingSlots.push(desc);
    return `${SLOT_TAG}${idx}`;
  };

  /**
   * @param {string} slot
   * @returns {unknown}
   */
  const convertSlotToVal = slot => {
    const idx = parseSlot(slot);
    if (idx >= unpackingSlots.length) {
      throw makeError(
        X`slot ${q(slot)} out of range (have ${q(unpackingSlots.length)} entries)`,
      );
    }
    const desc = unpackingSlots[idx];
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
   * Pack a method-call into a wire-level [`DeliverPayload`].
   *
   * @param {object} args
   * @param {unknown} args.target
   * @param {string} args.method
   * @param {unknown[]} args.args
   * @param {unknown} [args.reply] optional promise whose resolution
   *   will receive the call's return value (fire-and-forget if absent)
   * @returns {Uint8Array}
   */
  const packDeliver = ({ target, method, args, reply }) => {
    packingSlots = [];
    const targetDesc = describe(target);
    const replyDesc =
      reply !== undefined
        ? clist.exportLocal(reply, Kind.Promise)
        : /** @type {Descriptor | null} */ (null);
    const { body } = toCapData(
      /** @type {import('@endo/pass-style').Passable} */ (
        harden([method, args])
      ),
    );
    /** @type {DeliverPayload} */
    const payload = {
      target: targetDesc,
      body: textEncoder.encode(body),
      targets: packingSlots,
      promises: [],
      reply: replyDesc,
    };
    return encodeDeliver(payload);
  };
  harden(packDeliver);

  /**
   * Unpack a [`DeliverPayload`] into the JS-level view.
   *
   * @param {Uint8Array} bytes
   * @returns {{
   *   target: unknown,
   *   method: string,
   *   args: unknown[],
   *   reply: unknown | null,
   * }}
   */
  const unpackDeliver = bytes => {
    const p = decodeDeliver(bytes);
    unpackingSlots = p.targets;
    const bodyStr = textDecoder.decode(p.body);
    const slotStrings = unpackingSlots.map((_, i) => `${SLOT_TAG}${i}`);
    const decoded = fromCapData(harden({ body: bodyStr, slots: slotStrings }));
    if (!Array.isArray(decoded) || decoded.length !== 2) {
      throw makeError(
        X`deliver body must decode to [method, args], got ${q(decoded)}`,
      );
    }
    const [method, args] = decoded;
    if (typeof method !== 'string') {
      throw makeError(X`deliver method must be string, got ${q(method)}`);
    }
    if (!Array.isArray(args)) {
      throw makeError(X`deliver args must be array, got ${q(args)}`);
    }
    const target = clist.importRemote(p.target, () => makePresence(p.target));
    const replyDesc = p.reply;
    const reply =
      replyDesc === null
        ? null
        : clist.importRemote(replyDesc, () => makePresence(replyDesc));
    return { target, method, args: [...args], reply };
  };
  harden(unpackDeliver);

  /**
   * Pack a resolve into wire bytes.
   *
   * @param {object} args
   * @param {unknown} args.target — the promise being resolved
   * @param {boolean} args.isReject
   * @param {unknown} args.value
   * @returns {Uint8Array}
   */
  const packResolve = ({ target, isReject, value }) => {
    packingSlots = [];
    const targetDesc = clist.exportLocal(target, Kind.Promise);
    const { body } = toCapData(
      /** @type {import('@endo/pass-style').Passable} */ (harden(value)),
    );
    /** @type {ResolvePayload} */
    const payload = {
      target: targetDesc,
      isReject,
      body: textEncoder.encode(body),
      targets: packingSlots,
      promises: [],
    };
    return encodeResolve(payload);
  };
  harden(packResolve);

  /**
   * @param {Uint8Array} bytes
   */
  const unpackResolve = bytes => {
    const p = decodeResolve(bytes);
    unpackingSlots = p.targets;
    const bodyStr = textDecoder.decode(p.body);
    const slotStrings = unpackingSlots.map((_, i) => `${SLOT_TAG}${i}`);
    const value = fromCapData(harden({ body: bodyStr, slots: slotStrings }));
    const target = clist.importRemote(p.target, () => makePresence(p.target));
    return { target, isReject: p.isReject, value };
  };
  harden(unpackResolve);

  return harden({
    packDeliver,
    unpackDeliver,
    packResolve,
    unpackResolve,
    describe,
  });
};
harden(makeSlotMarshaller);
