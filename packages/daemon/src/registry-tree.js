// @ts-check

/**
 * Node-daemon adapter from the existing registry mechanics to the shared
 * package-registry directory tree.
 *
 * @import { RegistryBackend, RegistryTable } from './registry.js'
 * @import { EndoReadableTree } from '@endo/exo-npm'
 */

import {
  RegistryNotFoundError,
  RegistryOfflineError,
  RegistryTamperedError,
  makeEndorNpmRegistryTree,
  makeNpmRegistryTree,
  makePackageRegistryTree,
} from '@endo/exo-npm';
import { q, X } from '@endo/errors';

import {
  RegistryNetworkErrorName,
  RegistryTamperedErrorName,
  makeRegistryNetworkError,
} from './registry.js';

/**
 * @param {RegistryBackend} backend
 * @param {{
 *   table?: RegistryTable,
 *   registryUrl?: string,
 *   offline?: boolean,
 * }} options
 * @param {typeof makeNpmRegistryTree} makeNpmTree
 */
const makePackageRegistryTreeAdapter = (backend, options, makeNpmTree) => {
  const {
    table,
    registryUrl = 'https://registry.npmjs.org',
    offline = false,
  } = options;
  if (table === undefined) {
    throw new TypeError(
      'makeNodePackageRegistryTree requires a registry table',
    );
  }

  const operations = harden({
    /** @param {string} name */
    async listVersions(name) {
      const cached = table.getManifest(name);
      if (cached !== undefined) return cached;
      if (offline) {
        throw RegistryOfflineError(`no cached packument for ${name}`);
      }
      let versions;
      try {
        versions = await backend.fetchVersions(name);
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.name === RegistryNetworkErrorName ||
            cause.name === RegistryTamperedErrorName)
        ) {
          throw cause;
        }
        throw makeRegistryNetworkError(
          X`registry: failed to fetch versions for ${q(name)} from ${q(
            registryUrl,
          )}`,
          { cause },
        );
      }
      if (versions !== undefined) table.putManifest(name, versions);
      return versions;
    },

    /**
     * @param {string} name
     * @param {string} version
     */
    async providePackageTree(name, version) {
      const cached = table.getTree(name, version);
      if (cached !== undefined) {
        return harden({
          treeRef: /** @type {any} */ (cached.treeRef),
          integrity: cached.integrity,
        });
      }
      if (offline) throw RegistryOfflineError(name, version);
      let provided;
      try {
        provided = await backend.provideTree(name, version);
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.name === RegistryNetworkErrorName ||
            cause.name === RegistryTamperedErrorName)
        ) {
          throw cause;
        }
        throw makeRegistryNetworkError(
          X`registry: failed to fetch ${q(`${name}@${version}`)} from ${q(
            registryUrl,
          )}`,
          { cause },
        );
      }
      table.putTree(
        harden({
          name,
          version,
          treeRef: provided.treeRef,
          integrity: provided.integrity,
        }),
      );
      return harden({
        treeRef: /** @type {any} */ (provided.treeRef),
        integrity: provided.integrity,
      });
    },
  });

  return makePackageRegistryTree({ npm: makeNpmTree(operations) });
};
harden(makePackageRegistryTreeAdapter);

/**
 * @param {RegistryBackend} backend
 * @param {{ table?: RegistryTable, registryUrl?: string, offline?: boolean }} [options]
 */
export const makeNodePackageRegistryTree = (backend, options = {}) =>
  makePackageRegistryTreeAdapter(backend, options, makeNpmRegistryTree);
harden(makeNodePackageRegistryTree);

/**
 * XS-hosted adapter used by the Endor manager. The injected methods are the
 * narrow Rust host powers; the resulting public cap is the same shared tree
 * used by Node.
 *
 * @param {{
 *   hasPackage: (name: string) => string,
 *   listVersions: (name: string) => string,
 *   providePackageTree: (name: string, version: string) => string,
 *   makeTreeRef: (treeHash: string) => EndoReadableTree,
 * }} hostPowers
 */
export const makeEndorPackageRegistryTree = hostPowers => {
  /**
   * @template T
   * @param {string} encoded
   * @param {string} path
   * @returns {T}
   */
  const unwrap = (encoded, path) => {
    /** @type {{ ok: boolean, value?: T, error?: { kind: string, message: string } }} */
    let envelope;
    try {
      envelope = JSON.parse(encoded);
    } catch (cause) {
      throw makeRegistryNetworkError(
        X`registry: Endor returned a malformed host response for ${q(path)}`,
        { cause },
      );
    }
    if (envelope.ok) return /** @type {T} */ (envelope.value);
    const { kind = 'backend', message = 'unknown registry host failure' } =
      envelope.error ?? {};
    if (kind === 'offline') throw RegistryOfflineError(message);
    if (kind === 'not-found') throw RegistryNotFoundError(path);
    if (kind === 'tampered') throw RegistryTamperedError(message);
    throw makeRegistryNetworkError(
      X`registry: Endor host failed for ${q(path)}: ${q(message)}`,
    );
  };

  const operations = harden({
    /** @param {string} name */
    hasPackage: async name => unwrap(hostPowers.hasPackage(name), name),
    /** @param {string} name */
    listVersions: async name => unwrap(hostPowers.listVersions(name), name),
    /**
     * @param {string} name
     * @param {string} version
     */
    async providePackageTree(name, version) {
      const path = `${name}@${version}`;
      const { treeHash, integrity } =
        /** @type {{ treeHash: string, integrity?: string }} */ (
          unwrap(hostPowers.providePackageTree(name, version), path)
        );
      return harden({
        treeRef: hostPowers.makeTreeRef(treeHash),
        integrity: integrity ?? '',
      });
    },
  });

  // Use the Endor-labelled constructor so a deployed Endor hub's `help()` and
  // `Alleged:` diagnostics identify the backend that actually answered — the
  // one the conformance suite's `'Endor'` row exercises.
  return makePackageRegistryTree({ npm: makeEndorNpmRegistryTree(operations) });
};
harden(makeEndorPackageRegistryTree);
