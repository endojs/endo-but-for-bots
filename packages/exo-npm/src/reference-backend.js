// @ts-check

/**
 * Npm-scoped reference backend for the EndoRegistry capability.
 *
 * The scope is npm-style package resolution against the npm registry's
 * metadata schema. A different backend (a Rust-backed wrapper, a
 * workspace-only resolver) carries its own scope-naming.
 *
 * This module is the layer-1 scaffold: it stands up an exo with the
 * `EndoRegistryInterface` shape, accepts a caller-supplied package
 * cache table (sortable by dewey-decimal version), and a `resolveHook`
 * indirection that layer 2 (`designs/mvs-resolver.md`) fills in with
 * the MVS algorithm. The default hook surfaces a structured
 * `RegistryNetworkError` so a caller that wires layer 1 without
 * layer 2 gets a clear failure rather than a silent stub.
 *
 * The cache table is caller-supplied (rather than allocated
 * internally) so a SQLite-backed implementation can be wired in
 * without changing the backend's surface; see the `PackageCacheTable`
 * shape in `../types.d.ts`. The reference backend ships an in-memory
 * implementation (`makeMemoryPackageCacheTable`) suitable for tests
 * and small in-process consumers; a SQLite-backed implementation
 * projects the same shape over a relational `(name, major, minor,
 * patch, integrity, treeRef)` layout sorted by the three integer
 * columns.
 *
 * Caching behaviour matches the design's transparent-refetch model:
 * `lookup` returns undefined for unfetched packages, `fetch`
 * delegates to the table (re-resolving through the hook on miss),
 * and `resolve` returns the structure the snapshot mapper consumes.
 *
 * @import { EndoRegistry, RegistryResolution, ResolveOptions, ResolveHook, PackageCacheRow, PackageCacheTable, EndoReadableTree } from '../types.js';
 * @import { CasStore, RetentionLinks } from '@endo/mem-cas';
 */

import { makeExo } from '@endo/exo';
import { makeError, X } from '@endo/errors';
import { EndoRegistryInterface } from './type-guards.js';
import { RegistryNetworkError } from './errors.js';

/**
 * Parse a semver-shaped string into its dewey-decimal components.
 *
 * Permissive on input shape: a non-conforming version sorts to the
 * end. A SQLite-backed table can use the same parser at insert time
 * and store the three integer columns directly; the in-memory table
 * uses the parsed values for its sort comparator.
 *
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }}
 */
const parseVersion = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return { major: Infinity, minor: Infinity, patch: Infinity };
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};
harden(parseVersion);

/**
 * Compare two cache rows in dewey-decimal order: ascending by major,
 * then minor, then patch.
 *
 * @param {PackageCacheRow} a
 * @param {PackageCacheRow} b
 */
const byDeweyDecimal = (a, b) => {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
};

/**
 * In-memory reference implementation of `PackageCacheTable`.
 *
 * Backed by a `Map<name, Map<version, row>>`. `list(name)` returns the
 * rows sorted by dewey-decimal version on each call; a SQLite-backed
 * implementation uses `ORDER BY major, minor, patch` on the same
 * shape. `names()` projects the set of cached package names; a SQLite
 * backing uses `SELECT DISTINCT name` for the same shape.
 *
 * @returns {PackageCacheTable & { names: () => Promise<readonly string[]> }}
 */
export const makeMemoryPackageCacheTable = () => {
  /** @type {Map<string, Map<string, PackageCacheRow>>} */
  const byName = new Map();
  return harden({
    /** @param {string} name */
    async list(name) {
      const versions = byName.get(name);
      if (versions === undefined) return harden([]);
      return harden([...versions.values()].sort(byDeweyDecimal));
    },
    /**
     * @param {string} name
     * @param {string} version
     */
    async get(name, version) {
      return byName.get(name)?.get(version);
    },
    /** @param {PackageCacheRow} row */
    async put(row) {
      let versions = byName.get(row.name);
      if (versions === undefined) {
        versions = new Map();
        byName.set(row.name, versions);
      }
      versions.set(row.version, harden({ ...row }));
    },
    async names() {
      return harden([...byName.keys()]);
    },
  });
};
harden(makeMemoryPackageCacheTable);

/**
 * Construct an npm-scoped reference EndoRegistry backed by a
 * caller-supplied package cache table and an injected resolve hook.
 *
 * @param {{
 *   cas: CasStore,
 *   packages?: PackageCacheTable & { names?: () => Promise<readonly string[]> },
 *   resolveHook?: ResolveHook,
 *   retentionLinks?: RetentionLinks,
 *   label?: string,
 * }} options
 * @returns {EndoRegistry & { packages: PackageCacheTable }}
 */
export const makeNpmReferenceRegistry = options => {
  const {
    cas,
    packages = makeMemoryPackageCacheTable(),
    resolveHook,
    retentionLinks,
    label = 'npm-reference',
  } = options;

  if (!cas) {
    throw makeError(X`makeNpmReferenceRegistry requires a CAS store`);
  }

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

  const noopRetentionLinks = harden({
    pin: () => {},
    unpin: () => {},
    isPinned: () => false,
  });

  /**
   * @returns {{ cas: CasStore, retentionLinks: RetentionLinks, packages: PackageCacheTable }}
   */
  const makeHookContext = () =>
    harden({
      cas,
      retentionLinks: effectiveRetentionLinks ?? noopRetentionLinks,
      packages,
    });

  /**
   * Persist a resolution entry into the cache table, parsing the
   * version columns once at insert time so the table's `list` ordering
   * is dewey-decimal without re-parsing on read.
   *
   * Threads the optional `packageJson` snapshot through so the MVS
   * resolver's offline-mode walk against a cached entry sees the
   * declared dependency tables rather than an empty `{}`.
   *
   * @param {{ name: string, version: string, treeRef: EndoReadableTree, integrity: string, packageJson?: string }} entry
   */
  const cacheEntry = async entry => {
    const { major, minor, patch } = parseVersion(entry.version);
    await packages.put(
      harden({
        name: entry.name,
        version: entry.version,
        major,
        minor,
        patch,
        treeRef: entry.treeRef,
        integrity: entry.integrity,
        ...(entry.packageJson !== undefined
          ? { packageJson: entry.packageJson }
          : {}),
      }),
    );
  };

  /**
   * Enumerate the cached package names. The in-memory table exposes a
   * `names()` method; a caller-supplied SQLite-backed table that wants
   * to support the registry's `list()` enumeration implements the same
   * method (`SELECT DISTINCT name`). Tables without `names()` cause
   * `list()` to throw a structured error rather than silently return
   * an empty list.
   *
   * @returns {Promise<readonly string[]>}
   */
  const enumerateNames = async () => {
    const named =
      /** @type {PackageCacheTable & { names?: () => Promise<readonly string[]> }} */ (
        packages
      ).names;
    if (typeof named !== 'function') {
      throw makeError(
        X`EndoRegistry.list requires the supplied PackageCacheTable to implement names(); the in-memory table does so by default.`,
      );
    }
    return named.call(packages);
  };

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
        makeHookContext(),
      );

      // Populate the cache table from the resolution so subsequent
      // `lookup`/`fetch` calls see the resolved entries without
      // re-running the hook.
      for (const key of resolution.keys) {
        const entry = resolution.packagesByKey[key];
        if (entry) {
          // eslint-disable-next-line no-await-in-loop
          await cacheEntry(entry);
        }
      }
      return resolution;
    },
    /**
     * @param {string} name
     * @param {string} version
     */
    async fetch(name, version) {
      const cached = await packages.get(name, version);
      if (cached === undefined) {
        // Per the design's "transparent refetch" semantics, a fetch
        // on an unknown package re-runs resolution. Layer 2 will
        // fill the hook in; until then this raises a structured
        // `RegistryNetworkError` from the default hook.
        await effectiveResolveHook('', { offline: false }, makeHookContext());
        // Unreachable when the hook is the default; if a custom hook
        // populates the table as a side effect, surface the entry.
        const populated = await packages.get(name, version);
        if (populated !== undefined) {
          return populated.treeRef;
        }
        throw makeError(
          X`EndoRegistry has no entry for ${name}@${version} after resolve hook ran`,
        );
      }
      return cached.treeRef;
    },
    /**
     * @param {string} name
     * @param {string} version
     */
    async lookup(name, version) {
      const cached = await packages.get(name, version);
      if (cached === undefined) {
        return undefined;
      }
      return cached.treeRef;
    },
    /**
     * @param {string} [prefix]
     */
    async list(prefix) {
      const names = await enumerateNames();
      const entries = [];
      for (const name of names) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await packages.list(name);
        for (const row of rows) {
          if (prefix === undefined || row.name.startsWith(prefix)) {
            entries.push(harden({ name: row.name, version: row.version }));
          }
        }
      }
      return harden(entries);
    },
    help() {
      return (
        `EndoRegistry (${label}): npm-style resolver against a CAS-backed store. ` +
        `Layer 1 scaffolding per designs/registry-capability.md; layer 2 ` +
        `(mvs-resolver) fills in resolve().`
      );
    },
    // Expose the cache table for diagnostics and tests. Not part of
    // the EndoRegistry capability shape; consumers that cross the
    // worker boundary see only the interface methods.
    get packages() {
      return packages;
    },
  });
};
harden(makeNpmReferenceRegistry);
