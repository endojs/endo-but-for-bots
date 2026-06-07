// @ts-check

/**
 * Npm-scoped reference backend for the EndoRegistry capability.
 *
 * The scope is npm-style package resolution against the npm registry's
 * metadata schema. A different backend (a Rust-backed wrapper, a
 * workspace-only resolver) carries its own scope-naming.
 *
 * This module is the layer-1 scaffold: it stands up an exo with the
 * `EndoRegistryInterface` shape, an internal package-table
 * (`<name>@<version>` -> readable-tree), and a `resolveHook` indirection
 * that layer 2 (`designs/mvs-resolver.md`) fills in with the MVS
 * algorithm. The default hook surfaces a structured
 * `RegistryNetworkError` so a caller that wires layer 1 without
 * layer 2 gets a clear failure rather than a silent stub.
 *
 * Caching behaviour matches the design's transparent-refetch model:
 * `lookup` returns undefined for unfetched packages, `fetch`
 * delegates to the table (re-resolving through the hook on miss),
 * and `resolve` returns the structure the snapshot mapper consumes.
 *
 * @import { EndoRegistry, RegistryResolution, ResolveOptions, ResolveHook, EndoReadableTree } from '../types.js';
 * @import { CasStore, RetentionLinks } from '@endo/mem-cas';
 */

import { makeExo } from '@endo/exo';
import { makeError, X } from '@endo/errors';
import { EndoRegistryInterface } from './interfaces.js';
import { RegistryNetworkError } from './errors.js';

/**
 * Construct an npm-scoped reference EndoRegistry backed by an injected
 * resolve hook.
 *
 * @param {{
 *   cas: CasStore,
 *   resolveHook?: ResolveHook,
 *   retentionLinks?: RetentionLinks,
 *   label?: string,
 * }} options
 * @returns {EndoRegistry & {
 *   table: ReadonlyMap<string, { name: string, version: string, treeRef: EndoReadableTree }>
 * }}
 */
export const makeNpmReferenceRegistry = options => {
  const {
    cas,
    resolveHook,
    retentionLinks,
    label = 'npm-reference',
  } = options;

  if (!cas) {
    throw makeError(X`makeNpmReferenceRegistry requires a CAS store`);
  }

  /**
   * Layer-1 internal package table. The key shape matches npm's own
   * canonical `<name>@<version>` form (see `designs/registry-
   * capability.md` § Capability shape, `packagesByKey`).
   *
   * @type {Map<string, { name: string, version: string, treeRef: EndoReadableTree }>}
   */
  const table = new Map();

  const effectiveRetentionLinks = retentionLinks;

  /**
   * @type {ResolveHook}
   */
  const defaultResolveHook = async () => {
    // The default hook produces a structured failure so the layer-1
    // scaffold is honest about being incomplete. Layer 2 replaces
    // this with the MVS algorithm.
    throw RegistryNetworkError(
      'no resolveHook installed; layer 2 (mvs-resolver) wires the algorithm',
    );
  };

  const effectiveResolveHook = resolveHook ?? defaultResolveHook;

  /**
   * @param {string} name
   * @param {string} version
   * @returns {string}
   */
  const packageKey = (name, version) => `${name}@${version}`;

  return makeExo('NpmReferenceEndoRegistry', EndoRegistryInterface, {
    /**
     * @param {string} packageJson the package.json source as a UTF-8
     *   string.  The design's capability shape names a `Uint8Array`,
     *   but the exo boundary's pass-style check rejects mutable typed
     *   arrays; layer 1 accepts the JSON as a string and callers that
     *   hold bytes decode once before crossing the boundary.  A future
     *   refinement may add a parallel readable-blob entry for the
     *   binary path.
     * @param {ResolveOptions} [resolveOptions]
     */
    async resolve(packageJson, resolveOptions = {}) {
      const resolution = await effectiveResolveHook(
        packageJson,
        resolveOptions,
        harden({
          cas,
          retentionLinks:
            effectiveRetentionLinks ??
            harden({
              pin: () => {},
              unpin: () => {},
              isPinned: () => false,
            }),
        }),
      );

      // Populate the layer-1 table from the resolution so subsequent
      // `lookup`/`fetch` calls see the resolved entries without
      // re-running the hook.
      for (const key of resolution.keys) {
        const entry = resolution.packagesByKey[key];
        if (entry) {
          table.set(
            key,
            harden({
              name: entry.name,
              version: entry.version,
              treeRef: entry.treeRef,
            }),
          );
        }
      }
      return resolution;
    },
    /**
     * @param {string} name
     * @param {string} version
     */
    async fetch(name, version) {
      await null;
      const key = packageKey(name, version);
      const entry = table.get(key);
      if (entry === undefined) {
        // Per the design's "transparent refetch" semantics, a fetch
        // on an unknown package re-runs resolution. Layer 2 will
        // fill the hook in; until then this raises a structured
        // `RegistryNetworkError` from the default hook.
        await effectiveResolveHook(
          '',
          { offline: false },
          harden({
            cas,
            retentionLinks:
              effectiveRetentionLinks ??
              harden({
                pin: () => {},
                unpin: () => {},
                isPinned: () => false,
              }),
          }),
        );
        // Unreachable when the hook is the default; if a custom hook
        // populates the table as a side effect, surface the entry.
        const populated = table.get(key);
        if (populated !== undefined) {
          return populated.treeRef;
        }
        throw makeError(
          X`EndoRegistry has no entry for ${key} after resolve hook ran`,
        );
      }
      return entry.treeRef;
    },
    /**
     * @param {string} name
     * @param {string} version
     */
    async lookup(name, version) {
      const entry = table.get(packageKey(name, version));
      if (entry === undefined) {
        return undefined;
      }
      return entry.treeRef;
    },
    /**
     * @param {string} [prefix]
     */
    async list(prefix) {
      const entries = [];
      for (const entry of table.values()) {
        if (prefix === undefined || entry.name.startsWith(prefix)) {
          entries.push(harden({ name: entry.name, version: entry.version }));
        }
      }
      return harden(entries);
    },
    help() {
      return (
        `EndoRegistry (${label}): npm-style resolver against a CAS-backed store. ` +
        `Layer 1 scaffolding per designs/registry-capability.md; layer 2 ` +
        `(mvs-resolver) fills in resolve().  ${table.size} package(s) cached.`
      );
    },
    // Expose the table read-only for diagnostics and tests. Not part
    // of the EndoRegistry capability shape; consumers that cross the
    // worker boundary see only the interface methods.
    get table() {
      return /** @type {ReadonlyMap<string, { name: string, version: string, treeRef: EndoReadableTree }>} */ (
        new Map(table)
      );
    },
  });
};
harden(makeNpmReferenceRegistry);
