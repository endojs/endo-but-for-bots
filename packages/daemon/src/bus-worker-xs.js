// @ts-check
/// <reference path="./bus-xs-host-globals.d.ts" />
/* global globalThis, hostGetDaemonHandle */

/**
 * XS worker bootstrap.
 *
 * The Rust supervisor spawns an XS machine, evaluates the bundled
 * version of this module after SES boot and host-power
 * registration, then drives the conversation by calling
 * `globalThis.handleCommand(bytes)` (installed by `makeXsNode`)
 * for each inbound envelope on fd 4.
 *
 * The worker exposes one CapTP session keyed on the daemon's handle:
 * JSON-encoded messages wrapped in `deliver` envelopes, dispatched
 * via `makeCapTP`.  `node.sendEnvelope` is the byte transport in
 * both directions.
 *
 * Bundled into `rust/endo/xsnap/src/worker_bootstrap.js` via
 * `packages/daemon/scripts/bundle-bus-worker-xs.mjs`.
 */

import { makeCapTP } from '@endo/captp';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import {
  makeXsNode,
  markShouldTerminate,
  silentReject,
  textDecoder,
  textEncoder,
} from './bus-xs-core.js';

void E;
void Far;

// Formula identifiers are strings; env is a string-to-string record.
// Inlined from `./interfaces.js` so the XS worker bundle does not drag
// in `@endo/platform/fs/lite` (a Node-only path) via that module.
const IdShape = M.string();
const EnvShape = M.recordOf(M.string(), M.string());

// The worker-facet interface guard, mirrored from
// `WorkerFacetForDaemonInterface` in `./interfaces.js`.  Inlined here
// (rather than imported) to keep the worker bundle free of the
// `@endo/platform` transitive dependencies that `interfaces.js` pulls in.
const WorkerFacetForDaemonInterface = M.interface('EndoWorkerFacetForDaemon', {
  terminate: M.call().returns(M.promise()),
  evaluate: M.call(
    M.string(),
    M.arrayOf(M.string()),
    M.arrayOf(M.any()),
    IdShape,
    M.promise(),
  ).returns(M.promise()),
  makeArchive: M.call(M.any(), M.any(), M.any(), EnvShape).returns(M.promise()),
  makeFromTree: M.call(M.any(), M.any(), M.any(), EnvShape).returns(
    M.promise(),
  ),
  makeUnconfined: M.call(M.string(), M.any(), M.any(), EnvShape).returns(
    M.promise(),
  ),
});

const node = makeXsNode();

const daemonHandle = hostGetDaemonHandle();

// ---------------------------------------------------------------------------
// Worker facet — exposed to the daemon over CapTP.
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
     * @param {import('@endo/pass-style').Passable[]} endowmentValues
     * @param {string} id
     * @param {PromiseLike<any>} cancelled
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
    makeArchive: async (_readableP, _powersP, _contextP, _env) => {
      throw new Error('makeArchive not yet implemented in XS worker');
    },

    /**
     * @param {unknown} _treeP
     * @param {unknown} _powersP
     * @param {unknown} _contextP
     * @param {Record<string, string>} _env
     */
    makeFromTree: async (_treeP, _powersP, _contextP, _env) => {
      throw new Error('makeFromTree not yet implemented in XS worker');
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

// CapTP transport: JSON messages wrapped in `deliver` envelopes.
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
    // Swallow synchronous dispatch errors here; CapTP's own
    // unhandled-promise-rejection path is wired to silentReject
    // via the onReject option above.
  }
});
