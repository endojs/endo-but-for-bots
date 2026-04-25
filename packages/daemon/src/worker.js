// @ts-check
/* global globalThis, process */

import harden from '@endo/harden';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeNetstringCapTP } from './connection.js';

import { WorkerFacetForDaemonInterface } from './interfaces.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoReadable, MignonicPowers } from './types.js' */
/** @import { TraceRecord } from './trace-aggregator.js' */

const endowments = harden({
  // See https://github.com/Agoric/agoric-sdk/issues/9515
  assert: globalThis.assert,
  console,
  E,
  Far,
  makeExo,
  M,
  TextEncoder,
  TextDecoder,
  URL,
});

const normalizeFilePath = path => {
  // Check if the path is already a file URL.
  if (path.startsWith('file://')) {
    return path;
  }
  // Windows path detection and conversion (look for a drive letter at the start).
  const isWindowsPath = /^[a-zA-Z]:/.test(path);
  if (isWindowsPath) {
    // Correctly format the Windows path with three slashes.
    return `file:///${path}`;
  }
  // For non-Windows paths, prepend the file protocol.
  return `file://${path}`;
};

/**
 * @typedef {ReturnType<makeWorkerFacet>} WorkerBootstrap
 */

/**
 * @param {object} args
 * @param {(error: Error) => void} args.cancel
 */
export const makeWorkerFacet = ({ cancel }) => {
  return makeExo('EndoWorkerFacetForDaemon', WorkerFacetForDaemonInterface, {
    terminate: async () => {
      console.error('Endo worker received terminate request');
      cancel(Error('terminate'));
    },

    /**
     * @param {string} source
     * @param {Array<string>} names
     * @param {Array<unknown>} values
     * @param {string} $id
     * @param {Promise<never>} $cancelled
     */
    evaluate: async (source, names, values, $id, $cancelled) => {
      const compartment = new Compartment(
        harden({
          ...endowments,
          $id,
          $cancelled,
          ...Object.fromEntries(
            names.map((name, index) => [name, values[index]]),
          ),
        }),
      );
      return compartment.evaluate(source);
    },

    /**
     * @param {string} specifier
     * @param {Promise<unknown>} powersP
     * @param {Promise<unknown>} contextP
     * @param {Record<string, string>} env
     */
    makeUnconfined: async (specifier, powersP, contextP, env) => {
      // Windows absolute path includes drive letter which is confused for
      // protocol specifier. So, we reformat the specifier to include the
      // file protocol.
      const specifierUrl = normalizeFilePath(specifier);
      const namespace = await import(specifierUrl);
      return namespace.make(powersP, contextP, { env });
    },

    /**
     * @param {ERef<EndoReadable>} readableP
     * @param {Promise<unknown>} powersP
     * @param {Promise<unknown>} contextP
     * @param {Record<string, string>} env
     */
    makeBundle: async (readableP, powersP, contextP, env) => {
      const bundleText = await E(readableP).text();
      const bundle = JSON.parse(bundleText);

      // We defer importing the import-bundle machinery to this in order to
      // avoid an up-front cost for workers that never use importBundle.
      const { importBundle } = await import('@endo/import-bundle');
      const namespace = await importBundle(bundle, {
        endowments,
      });
      return namespace.make(powersP, contextP, { env });
    },
  });
};

/**
 * Build a `marshalSaveError` callback that pushes a worker-side trace
 * record to the daemon for every outbound error this worker's CapTP
 * marshal serializes.
 *
 * The push uses `E.sendOnly` so the worker never blocks an outbound
 * error on the success of a trace push.
 *
 * @param {() => unknown} getDaemonFacet returns the daemon's
 *   `EndoDaemonFacetForWorker` once CapTP has resolved the bootstrap.
 *   May return undefined before the bootstrap arrives, in which case
 *   the push is dropped.
 * @param {string} site label for the capture site, recorded with
 *   each trace.
 */
const makeWorkerPushTrace = (getDaemonFacet, site) => {
  /**
   * @param {Error} err
   * @param {string} [errorId]
   */
  return (err, errorId) => {
    if (errorId === undefined) return;
    const daemonFacet = getDaemonFacet();
    if (daemonFacet === undefined) return;
    let stack = '';
    if (typeof err.stack === 'string' && err.stack.length > 0) {
      stack = err.stack;
    } else {
      // SES redacts the original stack to the causal console; capture
      // a fresh trace at marshal time so the operator at least sees
      // where the error left the worker.
      const captureSite = Error('trace capture');
      stack = typeof captureSite.stack === 'string' ? captureSite.stack : '';
    }
    /** @type {TraceRecord} */
    const record = harden({
      errorId,
      // The daemon overwrites this with the connection's authoritative
      // workerId; we send a placeholder so the record is well-formed
      // for any local-only consumer.
      workerId: '',
      name: typeof err.name === 'string' ? err.name : 'Error',
      message: typeof err.message === 'string' ? err.message : `${err}`,
      stack,
      annotations: [],
      causes: [],
      t: Date.now(),
      site,
    });
    try {
      // The daemon facet is the bootstrap returned by CapTP and is
      // typed as opaque on the worker side; cast to access the trace
      // method we know the daemon exposes.
      /** @type {{ reportTrace: (r: TraceRecord) => void }} */
      const facet = /** @type {any} */ (daemonFacet);
      E.sendOnly(facet).reportTrace(record);
    } catch (pushError) {
      console.error(
        'Endo worker trace push failed:',
        /** @type {Error} */ (pushError).message || pushError,
      );
    }
  };
};

/**
 * @param {MignonicPowers} powers
 * @param {number | undefined} pid
 * @param {(error: Error) => void} cancel
 * @param {Promise<never>} cancelled
 */
export const main = async (powers, pid, cancel, cancelled) => {
  console.error(`Endo worker started on pid ${pid}`);
  cancelled.catch(() => {
    console.error(`Endo worker exiting on pid ${pid}`);
  });

  const { reader, writer } = powers.connection;

  const workerFacet = makeWorkerFacet({
    cancel,
  });

  /** @type {unknown} */
  let daemonFacet;
  const getDaemonFacet = () => daemonFacet;
  const pushTraceFromMarshal = makeWorkerPushTrace(getDaemonFacet, 'marshal');
  const pushTraceFromCapTP = makeWorkerPushTrace(getDaemonFacet, 'captp');

  const { closed, getBootstrap } = makeNetstringCapTP(
    'Endo',
    writer,
    reader,
    cancelled,
    workerFacet,
    { marshalSaveError: pushTraceFromMarshal },
    undefined,
    err => pushTraceFromCapTP(err),
  );

  daemonFacet = getBootstrap();

  // Capture top-level unhandled rejections as trace records so a
  // background failure inside an unconfined caplet still surfaces
  // through `traces.lookup`.
  if (typeof process !== 'undefined' && process.on !== undefined) {
    let unhandledSeq = 0;
    process.on(
      'unhandledRejection',
      /** @param {unknown} reason */ reason => {
        const err = reason instanceof Error ? reason : Error(String(reason));
        unhandledSeq += 1;
        const errorId = `error:Endo#unhandled-${unhandledSeq}`;
        pushTraceFromMarshal(err, errorId);
      },
    );
  }

  return Promise.race([cancelled, closed]);
};
