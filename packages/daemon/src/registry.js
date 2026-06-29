// @ts-check
/// <reference types="ses"/>

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { makeHelp, registryHelp } from './help-text.js';
import { RegistryInterface } from './interfaces.js';

/**
 * @typedef {{ name: string, version: string, treeRef: unknown, integrity: string }} RegistryPackageRecord
 * @typedef {{ packagesByKey: Record<string, RegistryPackageRecord>, keys: string[], resolutionHash: string }} RegistryResolution
 */

/**
 * @param {string} name
 * @param {string} version
 */
const packageKey = (name, version) => `${name}@${version}`;
harden(packageKey);

/**
 * Construct the JavaScript reference `EndoRegistry` backend.
 *
 * This first layer owns the durable capability shape and the host slot.
 * The resolver algorithm and tarball materializer are layered behind this
 * backend by the follow-on MVS and snapshot-mapper work.
 *
 * @param {object} args
 * @param {string} args.registryUrl
 */
export const makeRegistry = ({ registryUrl }) => {
  /** @type {Map<string, RegistryPackageRecord>} */
  const packages = new Map();

  return makeExo(
    'EndoRegistry',
    RegistryInterface,
    harden({
      /**
       * @param {unknown} packageJson
       * @param {{ offline?: boolean, workspaceRoot?: string | object }} [_options]
       * @returns {Promise<RegistryResolution>}
       */
      async resolve(packageJson, _options = {}) {
        await null;
        if (!(packageJson instanceof Uint8Array)) {
          throw makeError(X`Registry package.json must be bytes`);
        }
        throw makeError(
          X`EndoRegistry.resolve is waiting for the MVS resolver backend for ${q(registryUrl)}`,
        );
      },

      /**
       * @param {string} name
       * @param {string} version
       */
      async fetch(name, version) {
        await null;
        const record = packages.get(packageKey(name, version));
        if (record !== undefined) {
          return record.treeRef;
        }
        throw makeError(
          X`EndoRegistry.fetch is waiting for the package tarball backend for ${q(name)} ${q(version)} from ${q(registryUrl)}`,
        );
      },

      /**
       * @param {string} name
       * @param {string} version
       */
      async lookup(name, version) {
        await null;
        return packages.get(packageKey(name, version))?.treeRef;
      },

      /** @param {string} [prefix] */
      async list(prefix = '') {
        await null;
        return harden(
          [...packages.values()]
            .filter(({ name }) => name.startsWith(prefix))
            .map(({ name, version }) => harden({ name, version }))
            .sort((a, b) => {
              const aKey = packageKey(a.name, a.version);
              const bKey = packageKey(b.name, b.version);
              return aKey.localeCompare(bKey);
            }),
        );
      },

      help: makeHelp(registryHelp),
    }),
  );
};
harden(makeRegistry);
