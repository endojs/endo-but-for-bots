// @ts-check
/* global globalThis */

import harden from '@endo/harden';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeNetstringCapTP } from './connection.js';
import { makeRefReader } from './ref-reader.js';

import { WorkerFacetForDaemonInterface } from './interfaces.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoReadable, MignonicPowers } from './types.js' */

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
        await E(readableP).streamBase64(),
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
          import(
            '@endo/compartment-mapper/import-archive-all-parsers.js'
          ),
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
        { env },
      );
    },
  });
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

  const { closed } = makeNetstringCapTP(
    'Endo',
    writer,
    reader,
    cancelled,
    workerFacet,
  );

  return Promise.race([cancelled, closed]);
};
