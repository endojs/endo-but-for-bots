// @ts-check
/* global globalThis */

import harden from '@endo/harden';
import { makeError, X } from '@endo/errors';
import { HandledPromise } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

import { descriptorKey } from './descriptor.js';
import {
  VERB_DELIVER,
  VERB_RESOLVE,
  VERB_DROP,
  VERB_ABORT,
  encodeDropPayload,
  decodeDropPayload,
} from './payload.js';

/** @import { Descriptor } from './descriptor.js' */

/**
 * @typedef {(verb: string, payload: Uint8Array) => void} SendEnvelope
 */

/**
 * Create a slot-machine client: the user-facing interface that
 * turns [`makeSlotCodec`] plus a transport callback into an
 * eventual-send surface.
 *
 * Responsibilities:
 *
 * * `makePresence(desc)` — produce a [`HandledPromise`] whose `E()`
 *   calls encode `deliver` envelopes and queue them on the transport.
 * * Reply tracking — every outbound `deliver` with a reply allocates
 *   a local promise descriptor; when the peer's `resolve` arrives for
 *   that descriptor, the matching pending promise settles.
 * * `onDeliver` — dispatch an inbound `deliver` to its target via
 *   [`HandledPromise.applyMethod`], and (if the call carries a reply
 *   descriptor) send a matching `resolve` once the result settles.
 * * `onResolve` — route an inbound `resolve` to its pending promise.
 *
 * Drop / abort routing is left to the transport layer above.
 *
 * @param {object} opts
 * @param {{
 *   exportLocal: (val: unknown, kind?: 0 | 1 | 2 | 3) => Descriptor,
 *   importRemote: (desc: Descriptor, make: () => unknown) => unknown,
 *   lookupByValue: (val: unknown) => Descriptor | undefined,
 * }} opts.clist
 * @param {{
 *   encodeDeliver: (call: {
 *     target: unknown,
 *     method: string,
 *     args: unknown[],
 *     reply?: unknown,
 *   }) => Uint8Array,
 *   decodeDeliver: (bytes: Uint8Array) => {
 *     target: unknown,
 *     method: string,
 *     args: unknown[],
 *     reply: unknown | null,
 *   },
 *   encodeResolve: (resolution: {
 *     target: unknown,
 *     isReject: boolean,
 *     value: unknown,
 *   }) => Uint8Array,
 *   decodeResolve: (bytes: Uint8Array) => {
 *     target: unknown,
 *     isReject: boolean,
 *     value: unknown,
 *   },
 * }} opts.codec
 * @param {SendEnvelope} opts.sendEnvelope
 * @param {typeof globalThis.FinalizationRegistry} [opts.FinalizationRegistry]
 *   Optional finalisation registry constructor.  When supplied,
 *   `makePresence` registers each presence so that its
 *   garbage-collection queues an outbound `drop` envelope with
 *   `ram: 1`.  Defaults to `globalThis.FinalizationRegistry` if
 *   available; if the host has no such class, auto-drop is a
 *   no-op and callers must invoke `drop([...])` explicitly.
 */
export const makeSlotClient = ({
  clist,
  codec,
  sendEnvelope,
  FinalizationRegistry: FRCtor = globalThis.FinalizationRegistry,
}) => {
  /**
   * Pending replies, keyed by the descriptor of the local reply
   * promise.  Entries are cleared by `onResolve`.
   *
   * @type {Map<string, { resolve: (v: unknown) => void, reject: (e: unknown) => void }>}
   */
  const settlers = new Map();

  /**
   * Finalisation callback: when a presence becomes unreachable,
   * send a `drop` envelope with `ram: 1` against its descriptor.
   * Best-effort — the transport may be closed by the time the GC
   * fires, in which case we swallow the error silently.
   *
   * @type {InstanceType<typeof globalThis.FinalizationRegistry<Descriptor>> | null}
   */
  const finalizer = FRCtor
    ? new FRCtor(
        /**
         * @param {Descriptor} desc
         */
        desc => {
          try {
            const bytes = encodeDropPayload([
              { target: desc, ram: 1, clist: 0, export: 0 },
            ]);
            sendEnvelope(VERB_DROP, bytes);
          } catch (_err) {
            // Transport closed; drop is best-effort.
          }
        },
      )
    : null;

  /**
   * Send a method call to a presence or to a local value registered
   * in the c-list.  Returns a promise for the reply.
   *
   * @param {unknown} target
   * @param {string} method
   * @param {unknown[]} args
   * @returns {Promise<unknown>}
   */
  const deliver = (target, method, args) => {
    const { promise: reply, resolve, reject } = makePromiseKit();
    const bytes = codec.encodeDeliver({ target, method, args, reply });
    const replyDesc = clist.lookupByValue(reply);
    if (!replyDesc) {
      // codec.encodeDeliver just ran exportLocal on `reply`, so this
      // should be unreachable.
      throw makeError(X`reply promise did not receive a descriptor`);
    }
    settlers.set(descriptorKey(replyDesc), { resolve, reject });
    sendEnvelope(VERB_DELIVER, bytes);
    return reply;
  };
  harden(deliver);

  /**
   * Send a method call without tracking a reply.
   *
   * @param {unknown} target
   * @param {string} method
   * @param {unknown[]} args
   */
  const deliverSendOnly = (target, method, args) => {
    const bytes = codec.encodeDeliver({ target, method, args });
    sendEnvelope(VERB_DELIVER, bytes);
  };
  harden(deliverSendOnly);

  /**
   * Create a [`HandledPromise`] representing a remote capability.
   * The presence is registered in the c-list keyed by `desc`.
   *
   * @param {Descriptor} desc
   * @returns {unknown}
   */
  const makePresence = desc => {
    const handler = {
      /**
       * @param {unknown} p
       * @param {string | symbol} method
       * @param {unknown[]} args
       */
      applyMethod(p, method, args) {
        if (typeof method !== 'string') {
          throw makeError(X`slot-machine calls require string methods`);
        }
        return deliver(p, method, args);
      },
      /**
       * @param {unknown} p
       * @param {string | symbol} method
       * @param {unknown[]} args
       */
      applyMethodSendOnly(p, method, args) {
        if (typeof method !== 'string') {
          throw makeError(X`slot-machine calls require string methods`);
        }
        deliverSendOnly(p, method, args);
      },
    };
    // Executor is a no-op; the presence is settled only via inbound
    // resolve envelopes, if ever.  A presence representing a live
    // remote object never settles.
    const presence = new HandledPromise(() => {}, harden(handler));
    const registered = clist.importRemote(desc, () => presence);
    if (finalizer && registered === presence) {
      // Only register newly-created presences — if the c-list
      // already held an entry we reuse it and its existing
      // finalisation hook.
      finalizer.register(presence, harden({ ...desc }));
    }
    return presence;
  };
  harden(makePresence);

  /**
   * Handle an inbound `deliver`: dispatch to the target and, if the
   * call carries a reply descriptor, send a matching `resolve`
   * envelope when the result settles.
   *
   * @param {Uint8Array} bytes
   */
  const onDeliver = bytes => {
    const { target, method, args, reply } = codec.decodeDeliver(bytes);
    let resultP;
    try {
      resultP = HandledPromise.applyMethod(target, method, args);
    } catch (err) {
      resultP = Promise.reject(err);
    }
    if (reply !== null) {
      Promise.resolve(resultP).then(
        value => {
          const out = codec.encodeResolve({
            target: reply,
            isReject: false,
            value,
          });
          sendEnvelope(VERB_RESOLVE, out);
        },
        err => {
          const reason =
            /** @type {{ message?: unknown, name?: unknown }} */ (err)
              ?.message ?? String(err);
          const out = codec.encodeResolve({
            target: reply,
            isReject: true,
            value: reason,
          });
          sendEnvelope(VERB_RESOLVE, out);
        },
      );
    }
  };
  harden(onDeliver);

  /**
   * Handle an inbound `resolve`: route to the matching local reply
   * promise and clear the bookkeeping entry.  Unknown resolves are
   * silently dropped — a repeat resolve or one for a dropped reply
   * promise is a correctness issue at the sending peer, not here.
   *
   * @param {Uint8Array} bytes
   */
  const onResolve = bytes => {
    const { target, isReject, value } = codec.decodeResolve(bytes);
    const desc = clist.lookupByValue(target);
    if (!desc) return;
    const key = descriptorKey(desc);
    const entry = settlers.get(key);
    if (!entry) return;
    settlers.delete(key);
    if (isReject) {
      // Rehydrate into an Error so consumers get a throwable value
      // from their awaited promises.  For now the wire body is just
      // a message string; richer error shapes are a later addition.
      const err =
        typeof value === 'string' ? Error(value) : Error(String(value));
      entry.reject(err);
    } else {
      entry.resolve(value);
    }
  };
  harden(onResolve);

  /**
   * Send a `drop` envelope decrementing pillar counts on one or
   * more presences.  Defaults to `ram: 1` (the common case: a
   * presence has become unreachable on this side and we release
   * the RAM pillar).  Pillars omitted default to 0.
   *
   * @param {Array<{
   *   presence: unknown,
   *   ram?: number,
   *   clist?: number,
   *   export?: number,
   * }>} entries
   */
  const drop = entries => {
    const deltas = entries.map(entry => {
      const desc = clist.lookupByValue(entry.presence);
      if (!desc) {
        throw makeError(X`drop: presence not found in c-list`);
      }
      return {
        target: desc,
        ram: entry.ram ?? 1,
        clist: entry.clist ?? 0,
        export: entry.export ?? 0,
      };
    });
    if (deltas.length === 0) return;
    const bytes = encodeDropPayload(deltas);
    sendEnvelope(VERB_DROP, bytes);
  };
  harden(drop);

  /**
   * Handle an inbound `drop`.  The JS client does not track RAM /
   * CList / Export pillars itself — the Rust supervisor is
   * authoritative for cross-session refcount state — so this is a
   * notify-only path.  A `handler` callback (if supplied via
   * `onDropDeltas`) receives the decoded deltas; otherwise the
   * envelope is silently consumed.  Returning the deltas lets a
   * caller drive a local refcount ledger if they want one.
   *
   * @param {Uint8Array} bytes
   * @returns {Array<{
   *   target: Descriptor,
   *   ram: number,
   *   clist: number,
   *   export: number,
   * }>}
   */
  const onDrop = bytes => decodeDropPayload(bytes);
  harden(onDrop);

  /**
   * Dispatch an inbound envelope by verb.  `abort` is ignored at
   * this layer — the transport owns the session-teardown logic.
   *
   * @param {string} verb
   * @param {Uint8Array} payload
   */
  const onEnvelope = (verb, payload) => {
    if (verb === VERB_DELIVER) return onDeliver(payload);
    if (verb === VERB_RESOLVE) return onResolve(payload);
    if (verb === VERB_DROP) {
      onDrop(payload);
      return undefined;
    }
    if (verb === VERB_ABORT) return undefined;
    return undefined;
  };
  harden(onEnvelope);

  /** Number of outstanding outbound deliveries awaiting a reply. */
  const pendingCount = () => settlers.size;
  harden(pendingCount);

  return harden({
    makePresence,
    deliver,
    deliverSendOnly,
    drop,
    onDeliver,
    onResolve,
    onDrop,
    onEnvelope,
    pendingCount,
  });
};
harden(makeSlotClient);
