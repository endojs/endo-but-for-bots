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
 * Map a wire-encoded rejection value back into an `Error`.  The
 * sender's `onDeliver` packs `{ name, message }`; older senders
 * may have packed a bare string.  Either way we yield a
 * throwable Error so consumers can `await` and `try/catch`.
 *
 * @param {unknown} value
 * @returns {Error}
 */
const rehydrateError = value => {
  if (typeof value === 'string') return Error(value);
  if (
    value &&
    typeof value === 'object' &&
    typeof (/** @type {{ message?: unknown }} */ (value).message) === 'string'
  ) {
    const v = /** @type {{ name?: unknown, message: string }} */ (value);
    const e = Error(v.message);
    if (typeof v.name === 'string') {
      Object.defineProperty(e, 'name', {
        value: v.name,
        configurable: true,
        writable: true,
      });
    }
    return e;
  }
  return Error(String(value));
};

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
    // Register the settler before send so a synchronous transport
    // that pumps an inbound resolve re-entrantly inside sendEnvelope
    // can still find the matching entry.
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
      /**
       * Treat a presence-as-function call as a `__call__` method
       * dispatch.  Slot-machine has no separate function-target
       * convention, so we surface this as a string-keyed method to
       * keep the wire shape uniform.
       *
       * @param {unknown} p
       * @param {unknown[]} args
       */
      applyFunction(p, args) {
        return deliver(p, '__call__', args);
      },
      /**
       * @param {unknown} p
       * @param {unknown[]} args
       */
      applyFunctionSendOnly(p, args) {
        deliverSendOnly(p, '__call__', args);
      },
      /**
       * Property access via `E(p).prop` resolves to a deliver of
       * the conventional `__get__` method with the property name as
       * its only argument.  Mirrors CapTP's get-as-call shape.
       *
       * @param {unknown} p
       * @param {string | symbol} prop
       */
      get(p, prop) {
        if (typeof prop !== 'string') {
          throw makeError(X`slot-machine property names must be strings`);
        }
        return deliver(p, '__get__', [prop]);
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
    // Return whichever presence the c-list canonicalised on, so
    // repeat calls to makePresence with the same descriptor yield
    // the same object.
    return registered;
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
          // Carry both name and message so the receiving side can
          // rehydrate an Error of the right class.  Stack and cause
          // are deliberately omitted — they may contain sensitive
          // information from the rejecting peer's frame.
          const errLike = /** @type {{ name?: unknown, message?: unknown }} */ (
            err
          );
          const name =
            typeof errLike?.name === 'string' ? errLike.name : 'Error';
          const message =
            typeof errLike?.message === 'string'
              ? errLike.message
              : String(err);
          const out = codec.encodeResolve({
            target: reply,
            isReject: true,
            value: harden({ name, message }),
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
      entry.reject(rehydrateError(value));
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
   * Reject every outstanding reply promise with the supplied
   * reason.  Called when the session ends abruptly so callers
   * awaiting on `deliver` results don't hang forever.
   *
   * @param {Error} reason
   */
  const abortPending = reason => {
    for (const entry of settlers.values()) {
      try {
        entry.reject(reason);
      } catch (_e) {
        // The settler's reject may itself reject downstream; we
        // don't want one bad listener to prevent the others from
        // being cleared.
      }
    }
    settlers.clear();
  };
  harden(abortPending);

  /**
   * Dispatch an inbound envelope by verb.  `abort` rejects every
   * pending reply with the abort reason; `drop` decodes and
   * returns the deltas (the result is ignored here but the
   * underlying `onDrop` is callable directly for consumers that
   * want the bookkeeping).
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
    if (verb === VERB_ABORT) {
      // The abort payload is a UTF-8 reason byte string, but we
      // don't import the abort decoder here to keep the dependency
      // surface narrow.  Whoever drives onEnvelope can decode it
      // themselves and pass the reason via abortPending.
      abortPending(Error('session aborted by peer'));
      return undefined;
    }
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
    abortPending,
    pendingCount,
  });
};
harden(makeSlotClient);
