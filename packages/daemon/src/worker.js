// @ts-check
/* global globalThis, process */

import { format as formatUtil } from 'util';

import harden from '@endo/harden';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { ZipWriter } from '@endo/zip/writer.js';
import { bytesFromText } from '@endo/bytes/from-string.js';
import { makeNetstringCapTP } from './connection.js';
import { makeRefReader } from './ref-reader.js';

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
  return makeExo(
    'EndoWorkerFacetForDaemon',
    WorkerFacetForDaemonInterface,
    /** @type {any} */ ({
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
        return namespace.make(powersP, contextP, Object.freeze({ env }));
      },

      /**
       * @param {ERef<unknown>} treeP - Readable tree (or Mount) whose
       *   contents are laid out as a compartment-mapper archive:
       *   `compartment-map.json` at the root, with module source files
       *   at their referenced paths (`<compartmentName>/<moduleLocation>`).
       * @param {Promise<unknown>} powersP
       * @param {Promise<unknown>} contextP
       * @param {Record<string, string>} env
       */
      makeFromTree: async (treeP, powersP, contextP, env) => {
        // Read the compartment map from the tree root.  Tree 'lookup'
        // returns a blob Exo (ReadableTree) or MountFile Exo (Mount);
        // both expose `.text()`.
        const mapBlob = await E(/** @type {any} */ (treeP)).lookup(
          'compartment-map.json',
        );
        const mapText = await E(/** @type {any} */ (mapBlob)).text();
        /** @type {{ compartments: Record<string, any> }} */
        const compartmentMap = JSON.parse(mapText);

        // Pack the tree into an in-memory ZIP using the same layout
        // compartment-mapper.makeArchive produces, then hand it to the
        // existing parseArchive pipeline.  Keeps tree loading on the
        // worker side without duplicating the archive loader.
        const [{ parseArchive }, { defaultParserForLanguage }] =
          await Promise.all([
            import('@endo/compartment-mapper'),
            import('@endo/compartment-mapper/import-archive-all-parsers.js'),
          ]);
        const zip = new ZipWriter();
        zip.write('compartment-map.json', bytesFromText(mapText));

        for (const [compartmentName, descriptor] of Object.entries(
          compartmentMap.compartments,
        )) {
          const modules = descriptor.modules || {};
          for (const moduleInfo of Object.values(modules)) {
            if (
              typeof moduleInfo === 'object' &&
              moduleInfo !== null &&
              'location' in moduleInfo &&
              typeof moduleInfo.location === 'string'
            ) {
              const archivePath = `${compartmentName}/${moduleInfo.location}`;
              const pathSegments = archivePath.split('/').filter(Boolean);
              // eslint-disable-next-line no-await-in-loop
              const blob = await E(/** @type {any} */ (treeP)).lookup(
                pathSegments,
              );
              // eslint-disable-next-line no-await-in-loop
              const src = await E(/** @type {any} */ (blob)).text();
              zip.write(archivePath, bytesFromText(src));
            }
          }
        }

        const archiveBytes = zip.snapshot();
        const application = await parseArchive(archiveBytes, '<tree>', {
          parserForLanguage: defaultParserForLanguage,
        });
        const { namespace } = await application.import({
          globals: endowments,
        });
        return /** @type {{make: Function}} */ (namespace).make(
          powersP,
          contextP,
          Object.freeze({ env }),
        );
      },

      /**
       * @param {ERef<EndoReadable>} readableP - Readable blob of a ZIP
       *   archive containing a `compartment-map.json` and module sources
       *   (no precompiled module formats).
       * @param {Promise<unknown>} powersP
       * @param {Promise<unknown>} contextP
       * @param {Record<string, string>} env
       */
      makeArchive: async (readableP, powersP, contextP, env) => {
        // Stream the archive via the existing base64-encoded reader so
        // we never hand a mutable Uint8Array across CapTP (which would
        // be rejected by @endo/marshal).  Concatenate the chunks into
        // a single Uint8Array for compartment-mapper.parseArchive.
        /** @type {Uint8Array[]} */
        const chunks = [];
        let total = 0;
        for await (const chunk of makeRefReader(
          /** @type {any} */ (await E(readableP).streamBase64()),
        )) {
          chunks.push(chunk);
          total += chunk.byteLength;
        }
        const archiveBytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          archiveBytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        // Defer the compartment-mapper imports so workers that never
        // call makeArchive don't pay the babel/parser load cost.
        // Use the "all parsers" set so we accept source-form modules
        // (mjs/cjs) but degrade gracefully if a precompiled module
        // format slips through.
        const [{ parseArchive }, { defaultParserForLanguage }] =
          await Promise.all([
            import('@endo/compartment-mapper'),
            import('@endo/compartment-mapper/import-archive-all-parsers.js'),
          ]);
        const application = await parseArchive(archiveBytes, '<archive>', {
          parserForLanguage: defaultParserForLanguage,
        });
        const { namespace } = await application.import({
          globals: endowments,
        });
        return /** @type {{make: Function}} */ (namespace).make(
          powersP,
          contextP,
          Object.freeze({ env }),
        );
      },
    }),
  );
};

/**
 * Privileged hook that the SES shim exposes on the start-compartment
 * `globalThis` for `@endo/ses-ava`. Given a Logger function, it
 * returns a Console-shaped object whose methods unredact the Error
 * details that SES error-taming hides — stack and annotation trail
 * included.
 *
 * The worker is the start compartment of its Node.js process, so the
 * hook is reachable here. This is the same mechanism `ses-ava` uses
 * to surface real stacks in test failures and is the load-bearing
 * piece that lets the trace facility return useful information
 * without requiring `LOCKDOWN_ERROR_TAMING=unsafe`.
 */
const MAKE_CAUSAL_CONSOLE_KEY = Symbol.for(
  'MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA',
);

const optMakeCausalConsoleFromLogger =
  /** @type {((logger: (...args: unknown[]) => void) => Console) | undefined} */ (
    /** @type {any} */ (globalThis)[MAKE_CAUSAL_CONSOLE_KEY]
  );

/**
 * Side-table of unfiltered V8 callsites for every Error V8 has lazily
 * formatted in this worker. SES's tame `prepareStackTrace` returns
 * `''` and stashes callsites in a closed-over WeakMap reachable only
 * via `globalThis.getStackString`, which then reapplies the "concise"
 * filter. By layering our own preparer on top, we capture the
 * `safeV8SST` attenuation (still SES-safe — only the permitted
 * callsite accessors are exposed) before the filter runs and keep
 * the records keyed by the original error.
 *
 * Capturing here, at worker startup, is the only point where we run
 * before V8 lazily fills `error.stack` as a data property. After that
 * the slot is locked in by SES's harden of the decoded error, and our
 * preparer never gets another chance for that error.
 *
 * @type {WeakMap<Error, unknown[]>}
 */
const callSitesByError = new WeakMap();
{
  /** @type {any} */
  const ErrorRef = Error;
  // SES's setter wraps any function we install: the wrapper stashes
  // the unattenuated SST in its own private WeakMap and then calls us
  // with `safeV8SST(sst)`. So `sst` here is already attenuated to the
  // accessors SES considers safe to expose to user code.
  const previousPrepare = ErrorRef.prepareStackTrace;
  ErrorRef.prepareStackTrace = (err, sst) => {
    if (
      err !== null &&
      typeof err === 'object' &&
      Array.isArray(sst) &&
      !callSitesByError.has(err)
    ) {
      callSitesByError.set(err, sst);
    }
    if (typeof previousPrepare === 'function') {
      return previousPrepare(err, sst);
    }
    return '';
  };
}

/**
 * Format the call sites we captured for `err` into a stack-string,
 * bypassing SES's "concise" `filterFileName`. This shows compartment
 * frames that the default replay drops (e.g., `<anonymous>` frames
 * produced by `compartment.evaluate`).
 *
 * Returns `undefined` when no call sites were captured for this
 * error, e.g., the error was constructed before our preparer hook
 * was installed or never had its stack lazily formatted.
 *
 * @param {Error} err
 * @returns {string | undefined}
 */
const formatCapturedThrowSiteStack = err => {
  // Force V8 to invoke `prepareStackTrace` if it hasn't already, so
  // freshly-thrown errors get into our side-table.
  void (/** @type {Error & { stack?: string }} */ (err).stack);
  const sst = callSitesByError.get(err);
  if (sst === undefined || sst.length === 0) return undefined;
  return sst.map(cs => `  at ${cs}`).join('\n');
};

/**
 * Format an error to a multi-line string that includes the unredacted
 * stack, error tag, and any accumulated assert annotations, by
 * replaying it through a SES causal console wired to a string-buffer
 * logger.
 *
 * Returns `undefined` when the SES privileged hook is unavailable
 * (e.g. running without lockdown) so the caller can fall back to
 * `err.stack`.
 *
 * @param {Error} err
 * @returns {string | undefined}
 */
const formatErrorWithCausalConsole = err => {
  if (optMakeCausalConsoleFromLogger === undefined) return undefined;
  /** @type {string[]} */
  const lines = [];
  let causalConsole;
  try {
    causalConsole = optMakeCausalConsoleFromLogger((...args) => {
      lines.push(formatUtil(...args));
    });
    causalConsole.error(err);
  } catch (formatError) {
    return undefined;
  }
  return lines.join('\n');
};

/**
 * Capture the unfiltered V8 callsites of a freshly-constructed Error
 * at the `anchorFn` boundary, by transiently installing our own
 * `Error.prepareStackTrace` and forcing it to run.
 *
 * SES's default `prepareStackTrace` drops every callsite whose
 * `fileName` is null — exactly the frames `compartment.evaluate`
 * produces. The privileged `globalThis.getStackString` uses the same
 * filter, so neither path can surface the throw site of a confined
 * eval directly. By installing our own preparer for the brief window
 * we read `.stack`, we receive the `safeV8SST` attenuation (still
 * security-safe) but bypass the filename filter.
 *
 * SES wraps assignments to `Error.prepareStackTrace` so the SST we
 * receive is already attenuated; we never see unattenuated callsites.
 * The override is short-lived — `finally` restores the previous
 * preparer so concurrent stack reads landing on another turn do not
 * observe our hook.
 *
 * The returned stack reflects the worker frames at the point this
 * helper was called, not the original throw site. For the throw site
 * of a confined eval, V8 populated `err.stack=''` lazily during
 * marshal encoding and hardening locked in that data property; the
 * unfiltered callsites for the original error are not addressable
 * after that point. The worker emission frames are still useful: they
 * pinpoint the path the error took out of the worker (compartment →
 * marshal → CapTP → daemon).
 *
 * Returns `undefined` when the runtime is not V8 or when the override
 * is unavailable.
 *
 * @param {Function} anchorFn V8 omits frames at and above `anchorFn`;
 *   pass the function holding the call site so the trace starts where
 *   the worker observed the error.
 * @returns {string | undefined}
 */
const captureWorkerEmissionStack = anchorFn => {
  /** @type {any} */
  const ErrorRef = Error;
  if (typeof ErrorRef.captureStackTrace !== 'function') return undefined;
  const captureSite = {};
  try {
    ErrorRef.captureStackTrace(captureSite, anchorFn);
  } catch (captureError) {
    return undefined;
  }
  const previous = ErrorRef.prepareStackTrace;
  /** @type {string | undefined} */
  let formatted;
  try {
    ErrorRef.prepareStackTrace = (_subject, sst) => {
      // Stringifying each callsite is permitted by SES's safeV8SST
      // attenuation. We deliberately do NOT apply the SES "concise"
      // filename filter here; the worker is privileged code and the
      // record never crosses into a confined guest.
      formatted = sst.map(cs => `  at ${cs}`).join('\n');
      return formatted;
    };
    void (/** @type {{ stack?: string }} */ (captureSite).stack);
  } catch (captureError) {
    formatted = undefined;
  } finally {
    ErrorRef.prepareStackTrace = previous;
  }
  return formatted;
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
   * Named function expression so `pushTrace` is bindable inside its
   * own body without polluting the outer scope. We pass it as the
   * anchor to `captureWorkerEmissionStack` so V8 omits frames at and
   * above this function from the captured stack.
   *
   * @param {Error} err
   * @param {string} [errorId]
   */
  return function pushTrace(err, errorId) {
    if (errorId === undefined) return;
    const daemonFacet = getDaemonFacet();
    if (daemonFacet === undefined) return;
    // Build the trace's stack field from up to three best-effort
    // sources:
    //
    //   1. The unfiltered call sites our `prepareStackTrace` hook
    //      captured at the original throw site. This is the answer
    //      to "where did this error come from in the worker?",
    //      including frames inside `compartment.evaluate` that SES's
    //      default replay drops.
    //   2. The worker frames at this emission site, captured via a
    //      transient `Error.prepareStackTrace` override on a fresh
    //      anchor object. Shows the path the error took out of the
    //      worker (compartment → marshal → CapTP) and is useful even
    //      when (1) is unavailable.
    //   3. The SES causal console replay of the original error, which
    //      contributes the unredacted error tag, message, and the
    //      assert annotation trail (`Sent as ...`, `cause`, etc.) —
    //      the same hook `@endo/ses-ava` uses to surface this info.
    //
    // All are best-effort; we fall through to `err.stack` if none
    // produce anything.
    const throwSiteStack = formatCapturedThrowSiteStack(err);
    const emissionStack = captureWorkerEmissionStack(pushTrace);
    const causalReplay = formatErrorWithCausalConsole(err);
    /** @type {string[]} */
    const stackParts = [];
    if (throwSiteStack !== undefined && throwSiteStack.length > 0) {
      stackParts.push(throwSiteStack);
    }
    if (emissionStack !== undefined && emissionStack.length > 0) {
      stackParts.push(`-- emitted from --\n${emissionStack}`);
    }
    if (causalReplay !== undefined && causalReplay.length > 0) {
      stackParts.push(causalReplay);
    }
    let stack = stackParts.join('\n');
    if (stack.length === 0 && typeof err.stack === 'string') {
      stack = err.stack;
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
