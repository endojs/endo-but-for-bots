// @ts-check
/// <reference path="./bus-xs-host-globals.d.ts" />
/* global globalThis, hostGetDaemonHandle, hostGetEnv */

/**
 * XS worker bootstrap.
 *
 * The Rust supervisor spawns an XS machine, evaluates the bundled
 * version of this module after SES boot and host-power
 * registration, then drives the conversation by calling
 * `globalThis.handleCommand(bytes)` (installed by `makeXsNode`)
 * for each inbound envelope on fd 4.
 *
 * The worker exposes one session keyed on the daemon's handle.
 * `node.sendEnvelope` is the byte transport in both directions.
 *
 * Default mode: CapTP — JSON-encoded messages wrapped in `deliver`
 * envelopes, dispatched via `makeCapTP`.
 *
 * Slot-machine mode (`ENDO_USE_SLOT_MACHINE=1`): replaces CapTP
 * with `makeMessageSlots`.  All four slot verbs
 * (deliver/resolve/drop/abort) flow through; the inbound
 * iterator yields whole envelopes by capturing them via the
 * `onControl` hook of `makeXsNode` (so the slot verbs that the
 * default `handleCommand` routes only for `deliver` reach the
 * slot client).
 *
 * Bundled into `rust/endo/xsnap/src/worker_bootstrap.js` via
 * `packages/daemon/scripts/bundle-bus-worker-xs.mjs`.
 */

import { makeCapTP } from '@endo/captp';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeMessageSlots, isSlotVerb } from '@endo/slots';

import {
  makeXsNode,
  markShouldTerminate,
  silentReject,
  textDecoder,
  textEncoder,
} from './bus-xs-core.js';
import { WorkerFacetForDaemonInterface } from './interfaces.js';

void E;
void Far;

const useSlotMachine =
  typeof globalThis.hostGetEnv === 'function' &&
  hostGetEnv('ENDO_USE_SLOT_MACHINE') === '1';

// ---------------------------------------------------------------------------
// Inbound dispatch — slot mode captures every envelope for the
// daemon's handle (deliver + resolve + drop + abort), CapTP mode
// uses the standard registerSession path which routes only `deliver`.
// ---------------------------------------------------------------------------

/** @type {Array<{verb: string, payload: Uint8Array}>} */
const inboxQueue = [];
/** @type {((value: IteratorResult<{verb: string, payload: Uint8Array}>) => void) | null} */
let inboxWaiter = null;
let inboxClosed = false;

const pushInbound = env => {
  if (inboxWaiter) {
    const w = inboxWaiter;
    inboxWaiter = null;
    // Object.freeze (not harden) — XS marks Uint8Array indexed
    // elements non-configurable, so deep-freezing the wrapper
    // throws "cannot configure property".
    w(Object.freeze({ done: false, value: env }));
  } else {
    inboxQueue.push(env);
  }
};

const node = useSlotMachine
  ? makeXsNode({
      onControl: env => {
        // In slot-machine mode we capture every envelope addressed
        // to the daemon's handle.  Non-slot verbs (e.g. `init`,
        // `meter-config`) are silently discarded — the worker has
        // no use for them once the daemon handle is known.
        if (isSlotVerb(env.verb)) {
          pushInbound({ verb: env.verb, payload: env.payload });
        }
      },
    })
  : makeXsNode();

const daemonHandle = hostGetDaemonHandle();

// ---------------------------------------------------------------------------
// Worker facet — exposed to the daemon over the chosen transport.
// ---------------------------------------------------------------------------

/** Standard endowments provided to evaluated code in Compartments. */
const standardEndowments = harden(
  Object.fromEntries(
    Object.entries({
      assert: globalThis.assert,
      console: globalThis.console,
      E,
      Far,
      makeExo,
      M,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      URL: globalThis.URL,
    }).filter(([_k, v]) => v !== undefined),
  ),
);

const workerFacet = makeExo(
  'EndoWorkerFacetForDaemon',
  WorkerFacetForDaemonInterface,
  {
    terminate: async () => {
      markShouldTerminate();
    },

    /**
     * @param {string} source
     * @param {string[]} codeNames
     * @param {unknown[]} endowmentValues
     * @param {string} id
     * @param {Promise<never>} cancelled
     */
    evaluate: async (source, codeNames, endowmentValues, id, cancelled) => {
      const endowments = harden(
        Object.fromEntries(
          codeNames.map((name, index) => [name, endowmentValues[index]]),
        ),
      );
      const globals = harden({
        ...standardEndowments,
        ...endowments,
        $id: id,
        $cancelled: cancelled,
      });
      // SES Compartment takes endowments via constructor argument;
      // XS native Compartment ignores the argument and looks up
      // globals on `compartment.globalThis`.  Try both shapes so the
      // same code works against either runtime.
      const compartment = new Compartment(globals);
      for (const [name, value] of Object.entries(globals)) {
        if (!(name in compartment.globalThis)) {
          compartment.globalThis[name] = value;
        }
      }
      return compartment.evaluate(source);
    },

    /**
     * @param {unknown} _readableP
     * @param {unknown} _powersP
     * @param {unknown} _contextP
     * @param {Record<string, string>} _env
     */
    makeBundle: async (_readableP, _powersP, _contextP, _env) => {
      throw new Error('makeBundle not yet implemented in XS worker');
    },

    /**
     * @param {string} _specifier
     * @param {unknown} _powersP
     * @param {unknown} _contextP
     * @param {Record<string, string>} _env
     */
    makeUnconfined: async (_specifier, _powersP, _contextP, _env) => {
      throw new Error('makeUnconfined not yet implemented in XS worker');
    },
  },
);

if (useSlotMachine) {
  // Slot-machine path: speak the four slot verbs end-to-end with
  // the daemon.  Inbound envelopes from `onControl` are pushed
  // into `inboxQueue` / consumed via `inboundReader`; outbound
  // envelopes go via `node.sendEnvelope` with the verb intact.
  const inboundReader = harden({
    next() {
      if (inboxQueue.length > 0) {
        const value = /** @type {{verb: string, payload: Uint8Array}} */ (
          inboxQueue.shift()
        );
        return Promise.resolve(Object.freeze({ done: false, value }));
      }
      if (inboxClosed) {
        return Promise.resolve(harden({ done: true, value: undefined }));
      }
      return new Promise(resolve => {
        inboxWaiter = resolve;
      });
    },
    return() {
      inboxClosed = true;
      if (inboxWaiter) {
        const w = inboxWaiter;
        inboxWaiter = null;
        w(harden({ done: true, value: undefined }));
      }
      return Promise.resolve(harden({ done: true, value: undefined }));
    },
    throw() {
      inboxClosed = true;
      return Promise.resolve(harden({ done: true, value: undefined }));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });

  const envelopeWriter = harden({
    /** @param {{verb: string, payload: Uint8Array}} env */
    async next(env) {
      node.sendEnvelope(daemonHandle, env.verb, env.payload);
      return harden({ done: false, value: undefined });
    },
    async return() {
      return harden({ done: true, value: undefined });
    },
    async throw() {
      return harden({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });

  // Cancellation: the worker process exits when the supervisor
  // closes the pipes; there is no separate cancellation signal
  // wired up here.
  /** @type {Promise<never>} */
  const cancelled = new Promise(() => {});

  makeMessageSlots(
    'Endo',
    /** @type {any} */ (envelopeWriter),
    /** @type {any} */ (inboundReader),
    cancelled,
    workerFacet,
  );
} else {
  // CapTP path (default).
  /** @param {Record<string, unknown>} message */
  const send = message => {
    const json = JSON.stringify(message);
    node.sendEnvelope(daemonHandle, 'deliver', textEncoder.encode(json));
  };

  const { dispatch } = makeCapTP('Endo', send, workerFacet, {
    onReject: silentReject,
  });

  node.registerSession(daemonHandle, payload => {
    const json = textDecoder.decode(payload);
    let message;
    try {
      message = JSON.parse(json);
    } catch {
      return;
    }
    try {
      dispatch(message);
    } catch {
      // Swallow — handled by onReject.
    }
  });
}
