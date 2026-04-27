// @ts-check
/// <reference path="./bus-xs-host-globals.d.ts" />
/* global globalThis, hostGetDaemonHandle, hostImportArchive, hostTrace */

/**
 * XS worker bootstrap.
 *
 * The Rust supervisor spawns an XS machine, evaluates the bundled
 * version of this module after SES boot and host-power
 * registration, then drives the conversation by calling
 * `globalThis.handleCommand(bytes)` (installed by `makeXsNode`)
 * for each inbound envelope on fd 4.
 *
 * The worker exposes one CapTP session keyed on the daemon's
 * handle.  `node.sendEnvelope` is the byte transport in both
 * directions; messages are JSON-encoded into `deliver` envelopes.
 *
 * Bundled into `rust/endo/xsnap/src/worker_bootstrap.js` via
 * `packages/daemon/scripts/bundle-bus-worker-xs.mjs`.
 */

import { makeCapTP } from '@endo/captp';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { decodeBase64 } from '@endo/base64';

import {
  makeXsNode,
  markShouldTerminate,
  silentReject,
  textDecoder,
  textEncoder,
} from './bus-xs-core.js';
import { makeRefIterator } from './ref-reader.js';

void Far;
void hostTrace;

const node = makeXsNode();

const daemonHandle = hostGetDaemonHandle();

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
  'EndoXsWorkerFacet',
  M.interface('EndoXsWorkerFacet', {
    terminate: M.call().returns(M.promise()),
    evaluate: M.call(
      M.string(),
      M.arrayOf(M.string()),
      M.arrayOf(M.any()),
      M.string(),
      M.promise(),
    ).returns(M.promise()),
    makeBundle: M.call(M.any(), M.any(), M.any(), M.any()).returns(
      M.promise(),
    ),
    makeArchive: M.call(M.any(), M.any(), M.any(), M.any()).returns(
      M.promise(),
    ),
    makeUnconfined: M.call(M.string(), M.any(), M.any(), M.any()).returns(
      M.promise(),
    ),
  }),
  {
    /** @returns {Promise<void>} */
    terminate: async () => {
      markShouldTerminate();
    },

    /**
     * @param {string} source
     * @param {string[]} codeNames
     * @param {unknown[]} endowmentValues
     * @param {string} id
     * @param {Promise<never>} cancelled
     * @returns {Promise<unknown>}
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
     * @returns {Promise<unknown>}
     */
    makeBundle: async (_readableP, _powersP, _contextP, _env) => {
      throw new Error('makeBundle not yet implemented in XS worker');
    },

    /**
     * @param {unknown} readableP
     * @param {unknown} powersP
     * @param {unknown} contextP
     * @param {Record<string, string>} env
     * @returns {Promise<unknown>}
     */
    makeArchive: async (readableP, powersP, contextP, env) => {
      const streamRef = await E(readableP).streamBase64();
      const chunks = [];
      for await (const chunk of makeRefIterator(streamRef)) {
        chunks.push(decodeBase64(chunk));
      }
      const totalLen = chunks.reduce((n, c) => n + c.length, 0);
      const archiveBytes = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        archiveBytes.set(c, offset);
        offset += c.length;
      }

      const ok = hostImportArchive(archiveBytes);
      if (!ok) throw new Error('Failed to import archive');

      const namespace = /** @type {any} */ (globalThis).__entryNs;
      delete (/** @type {any} */ (globalThis)).__entryNs;
      return namespace.make(powersP, contextP, { env });
    },

    /**
     * @param {string} _specifier
     * @param {unknown} _powersP
     * @param {unknown} _contextP
     * @param {Record<string, string>} _env
     * @returns {Promise<unknown>}
     */
    makeUnconfined: async (_specifier, _powersP, _contextP, _env) => {
      throw new Error('makeUnconfined not yet implemented in XS worker');
    },
  },
);

/**
 * Outbound CapTP send: JSON-encode the message and wrap it in a
 * `deliver` envelope addressed to the daemon handle.
 *
 * @param {Record<string, unknown>} message
 */
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
