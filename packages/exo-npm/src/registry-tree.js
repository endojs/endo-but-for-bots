// @ts-check

/**
 * Directory-tree presentation for package registries.
 *
 * The adapters in this module deliberately know nothing about HTTP, SQLite,
 * tarballs, or a particular CAS. Those mechanics are injected as three narrow
 * operations, which lets the Node daemon and the XS-hosted Endor adapter expose
 * one capability shape and lets tests use the same shape over in-memory data.
 *
 * @import { EndoRegistry, EndoReadableTree, RegistryDirectory, RegistryHub, RegistryTreeOperations } from '../types.js'
 */

import { makeExo } from '@endo/exo';
import { makeError, X } from '@endo/errors';

import {
  RegistryNotFoundError,
  RegistryPathSyntaxError,
  registryErrorName,
} from './errors.js';
import {
  EndoRegistryInterface,
  RegistryDirectoryInterface,
  RegistryHubInterface,
  RegistrySnapshotTreeInterface,
} from './type-guards.js';

/** @param {string | readonly string[]} path */
const segmentsFromPath = path =>
  typeof path === 'string' ? [path] : [...path];
harden(segmentsFromPath);

/**
 * @param {unknown} node
 * @param {readonly string[]} segments
 */
const lookupThrough = async (node, segments) => {
  let current = node;
  for (const segment of segments) {
    // Direct same-vat dispatch is intentional. The resolver and the registry
    // tree are colocated on both backends, so there is no E() in this module.
    // eslint-disable-next-line no-await-in-loop
    current = await /** @type {any} */ (current).lookup(segment);
  }
  return current;
};
harden(lookupThrough);

/** @param {string} segment */
const scopedPackageSegments = segment => {
  if (!segment.includes('/')) return [segment];
  const match = /^(@[^/]+)\/([^/]+)$/.exec(segment);
  if (match === null) throw RegistryPathSyntaxError(segment);
  return [match[1], match[2]];
};
harden(scopedPackageSegments);

/**
 * A deterministic ascending comparison for exact semver spellings.
 * @param {string} left
 * @param {string} right
 */
export const comparePublishedVersions = (left, right) => {
  const versionPattern =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const leftMatch = versionPattern.exec(left);
  const rightMatch = versionPattern.exec(right);
  // Total order across the mixed set: every parseable spelling sorts before
  // every unparseable one, and unparseable spellings sort lexicographically
  // among themselves. A per-pair lexicographic fallback would be intransitive
  // (registry-supplied version keys could then determine `list()` order and
  // the MVS selection), so unparseable versions are segregated instead.
  if (leftMatch === null || rightMatch === null) {
    if (leftMatch === null && rightMatch === null) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    // A parseable version is strictly less than an unparseable one.
    return leftMatch === null ? 1 : -1;
  }
  for (let position = 1; position <= 3; position += 1) {
    const difference =
      Number(leftMatch[position]) - Number(rightMatch[position]);
    if (difference !== 0) return difference;
  }
  const leftPrerelease = leftMatch[4]?.split('.');
  const rightPrerelease = rightMatch[4]?.split('.');
  if (leftPrerelease === undefined && rightPrerelease !== undefined) return 1;
  if (leftPrerelease !== undefined && rightPrerelease === undefined) return -1;
  if (leftPrerelease === undefined || rightPrerelease === undefined) return 0;
  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let position = 0; position < length; position += 1) {
    const leftIdentifier = leftPrerelease[position];
    const rightIdentifier = rightPrerelease[position];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier !== rightIdentifier) {
      const leftIsNumber = /^\d+$/.test(leftIdentifier);
      const rightIsNumber = /^\d+$/.test(rightIdentifier);
      if (leftIsNumber && rightIsNumber) {
        return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
      }
      if (leftIsNumber) return -1;
      if (rightIsNumber) return 1;
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
  }
  return 0;
};
harden(comparePublishedVersions);

/**
 * Attenuate an enumerable tree to lookup-only authority.
 *
 * The attenuation must survive every result the view hands back: a bare
 * forwarding `lookup` would leak the underlying enumerable tree, because every
 * registry node returns *itself* for an empty path (so `view.lookup([])` would
 * be the un-attenuated root, with `list` intact). The empty path is therefore
 * rejected, and any tree-shaped result is re-wrapped so `list` stays withheld
 * one level down as well.
 *
 * @param {RegistryDirectory} tree
 * @param {'live' | 'stable'} [temporal]
 * @returns {RegistryHub}
 */
export const makeLookupTreeView = (tree, temporal = 'live') => {
  /** @type {RegistryHub} */
  const view = makeExo('LookupTreeView', RegistryHubInterface, {
    help: method =>
      method === undefined
        ? 'Lookup-only view of an enumerable tree'
        : `Lookup-only tree method ${method}`,
    has: (...path) => tree.has(...path),
    async lookup(path) {
      const segments = segmentsFromPath(path);
      // An empty path resolves to the tree itself; returning it would hand
      // back the enumerable authority this view exists to withhold.
      if (segments.length === 0) {
        throw RegistryPathSyntaxError('(empty path)');
      }
      const result = await tree.lookup(segments);
      // Re-attenuate every traversable node the view returns, not just directly
      // enumerable ones: a non-enumerable hub carries no `list` itself yet still
      // hands back enumerable children, so wrapping only `list`-bearing results
      // would leave enumeration recoverable two hops down. Any node with a
      // `lookup` is wrapped so `list` stays withheld at every depth.
      if (
        result !== null &&
        typeof result === 'object' &&
        typeof (/** @type {any} */ (result).lookup) === 'function'
      ) {
        return makeLookupTreeView(
          /** @type {RegistryDirectory} */ (result),
          temporal,
        );
      }
      return result;
    },
    getInfo: () => harden({ temporal }),
  });
  return view;
};
harden(makeLookupTreeView);

/**
 * Make the non-enumerable npm package-name hub.
 *
 * @param {RegistryTreeOperations} operations
 * @param {{ label?: string }} [options]
 * @returns {RegistryHub}
 */
export const makeNpmRegistryTree = (operations, options = {}) => {
  const { label = 'npm' } = options;
  /** @type {Map<string, RegistryDirectory>} */
  const packageDirectories = new Map();
  /** @type {Map<string, WeakMap<EndoReadableTree, EndoReadableTree>>} */
  const versionLeavesByPackageVersion = new Map();

  /** @param {string} packageName */
  const versionsFor = async packageName => {
    const versions = await operations.listVersions(packageName);
    if (versions === undefined) {
      throw RegistryNotFoundError(`/npm/${packageName}`);
    }
    return harden([...versions].sort(comparePublishedVersions));
  };

  /**
   * @param {string} packageName
   * @param {string} version
   */
  const makeVersionLeaf = async (packageName, version) => {
    const key = `${packageName}@${version}`;
    const available = await versionsFor(packageName);
    if (!available.includes(version)) {
      throw RegistryNotFoundError(`/npm/${packageName}/${version}`);
    }

    const { treeRef, integrity } = await operations.providePackageTree(
      packageName,
      version,
    );
    let versionLeaves = versionLeavesByPackageVersion.get(key);
    if (versionLeaves === undefined) {
      versionLeaves = new WeakMap();
      versionLeavesByPackageVersion.set(key, versionLeaves);
    }
    const cached = versionLeaves.get(treeRef);
    if (cached !== undefined) return cached;
    const leaf = makeExo(`Package ${key}`, RegistrySnapshotTreeInterface, {
      help: method =>
        method === undefined
          ? `Immutable package tree ${key}`
          : `Package tree method ${method}`,
      has: (...path) => treeRef.has(...path),
      list: (...path) => treeRef.list(...path),
      lookup: path => treeRef.lookup(path),
      sha256: () => treeRef.sha256(),
      async getInfo() {
        const treeInfo =
          typeof treeRef.getInfo === 'function'
            ? await treeRef.getInfo()
            : harden({});
        return harden({
          ...treeInfo,
          temporal: 'immutable',
          integrity,
        });
      },
    });
    versionLeaves.set(treeRef, leaf);
    return leaf;
  };

  /** @param {string} packageName */
  const packageDirectoryFor = async packageName => {
    const cached = packageDirectories.get(packageName);
    if (cached !== undefined) return cached;
    await versionsFor(packageName);

    /** @type {RegistryDirectory} */
    const packageDirectory = makeExo(
      `Package versions for ${packageName}`,
      RegistryDirectoryInterface,
      {
        help: method =>
          method === undefined
            ? `Live published-version directory for ${packageName}`
            : `Package-version directory method ${method}`,
        async has(...path) {
          try {
            if (path.length === 0) return true;
            await lookupThrough(packageDirectory, path);
            return true;
          } catch {
            return false;
          }
        },
        async list(...path) {
          if (path.length === 0) return versionsFor(packageName);
          const node = await lookupThrough(packageDirectory, path);
          if (typeof (/** @type {any} */ (node).list) !== 'function') {
            throw new TypeError(
              `Registry node at ${path.join('/')} is not enumerable`,
            );
          }
          return /** @type {any} */ (node).list();
        },
        async lookup(path) {
          const segments = segmentsFromPath(path);
          if (segments.length === 0) return packageDirectory;
          const [version, ...remaining] = segments;
          if (version.includes('/')) throw RegistryPathSyntaxError(version);
          const leaf = await makeVersionLeaf(packageName, version);
          return lookupThrough(leaf, remaining);
        },
        getInfo: () => harden({ temporal: /** @type {const} */ ('live') }),
      },
    );
    packageDirectories.set(packageName, packageDirectory);
    return packageDirectory;
  };

  // A bare scope names no listable resource of its own — its existence is only
  // knowable once a package under it is fetched — so scope hubs are minted on
  // demand rather than memoized. Memoizing them in an unbounded map would let a
  // guest holding `@registry` exhaust daemon memory with `lookup('@junk-' + i)`
  // over distinct bogus scopes without ever touching the network.
  /** @param {string} scope */
  const scopeHubFor = scope => {
    /** @type {RegistryHub} */
    const scopeHub = makeExo(`npm scope ${scope}`, RegistryHubInterface, {
      help: method =>
        method === undefined
          ? `Non-enumerable npm scope ${scope}`
          : `npm scope method ${method}`,
      async has(...path) {
        try {
          if (path.length === 0) return true;
          await lookupThrough(scopeHub, path);
          return true;
        } catch {
          return false;
        }
      },
      async lookup(path) {
        const segments = segmentsFromPath(path);
        if (segments.length === 0) return scopeHub;
        const [packagePart, ...remaining] = segments;
        if (packagePart.includes('/'))
          throw RegistryPathSyntaxError(packagePart);
        const directory = await packageDirectoryFor(`${scope}/${packagePart}`);
        return lookupThrough(directory, remaining);
      },
      getInfo: () => harden({ temporal: /** @type {const} */ ('live') }),
    });
    return scopeHub;
  };

  /** @type {RegistryHub} */
  const npmHub = makeExo('npm package registry', RegistryHubInterface, {
    help: method =>
      method === undefined
        ? `Non-enumerable ${label} package-name hub`
        : `npm registry method ${method}`,
    async has(...path) {
      try {
        if (path.length === 0) return true;
        const normalized = path.flatMap(scopedPackageSegments);
        if (
          operations.hasPackage !== undefined &&
          (normalized.length === 1 ||
            (normalized.length === 2 && normalized[0].startsWith('@')))
        ) {
          const packageName =
            normalized.length === 1
              ? normalized[0]
              : `${normalized[0]}/${normalized[1]}`;
          return Boolean(await operations.hasPackage(packageName));
        }
        await lookupThrough(npmHub, normalized);
        return true;
      } catch {
        // `has` is the platform-wide no-throw predicate. In particular an
        // offline unknown folds "cannot tell" into false.
        return false;
      }
    },
    async lookup(path) {
      const original = segmentsFromPath(path);
      if (original.length === 0) return npmHub;
      // The leading segment is normalized through `scopedPackageSegments`
      // regardless of path length, so `lookup(['@scope/package', '1.2.3'])`
      // resolves the same node `has('@scope/package', '1.2.3')` normalizes —
      // the has⇒lookup contract must not disagree on the one slash-bearing
      // spelling npm tolerates. Trailing segments still reject embedded
      // slashes, which are only meaningful in the leading package name.
      const [head, ...tail] = original;
      const segments = [
        ...scopedPackageSegments(head),
        ...tail.map(segment => {
          if (segment.includes('/')) throw RegistryPathSyntaxError(segment);
          return segment;
        }),
      ];
      const [first, ...remaining] = segments;
      if (first.startsWith('@')) {
        if (remaining.length === 0) return scopeHubFor(first);
        return lookupThrough(scopeHubFor(first), remaining);
      }
      const directory = await packageDirectoryFor(first);
      return lookupThrough(directory, remaining);
    },
    getInfo: () => harden({ temporal: /** @type {const} */ ('live') }),
  });

  return npmHub;
};
harden(makeNpmRegistryTree);

/**
 * Endor's XS adapter is intentionally the same narrow adapter with a distinct
 * constructor name. Its operations are host powers backed by RegistryTable,
 * fetch_package, and the CAS reader; they are not a second public protocol.
 *
 * @param {RegistryTreeOperations} hostPowers
 */
export const makeEndorNpmRegistryTree = hostPowers =>
  makeNpmRegistryTree(hostPowers, { label: 'Endor npm' });
harden(makeEndorNpmRegistryTree);

/**
 * Make the enumerable registry-family root.
 *
 * @param {Record<string, RegistryHub>} registries
 * @returns {RegistryDirectory}
 */
export const makePackageRegistryTree = registries => {
  const names = harden(Object.keys(registries).sort());
  /** @type {RegistryDirectory} */
  const root = makeExo('Package registry root', RegistryDirectoryInterface, {
    help: method =>
      method === undefined
        ? 'Stable directory of configured package registries'
        : `Package-registry root method ${method}`,
    async has(...path) {
      try {
        if (path.length === 0) return true;
        await lookupThrough(root, path);
        return true;
      } catch {
        return false;
      }
    },
    async list(...path) {
      if (path.length === 0) return names;
      const node = await lookupThrough(root, path);
      if (typeof (/** @type {any} */ (node).list) !== 'function') {
        throw new TypeError(
          `Registry node at ${path.join('/')} is not enumerable`,
        );
      }
      return /** @type {any} */ (node).list();
    },
    async lookup(path) {
      const segments = segmentsFromPath(path);
      if (segments.length === 0) return root;
      const [registryName, ...remaining] = segments;
      if (registryName.includes('/'))
        throw RegistryPathSyntaxError(registryName);
      // `registries` is a caller-supplied plain record; index it with an
      // own-property check so an inherited key (`__proto__`, `constructor`,
      // `toString`) cannot hand a prototype intrinsic back across the
      // `@registry` capability boundary.
      if (!Object.hasOwn(registries, registryName))
        throw RegistryNotFoundError(`/${registryName}`);
      const registry = registries[registryName];
      return lookupThrough(registry, remaining);
    },
    getInfo: () => harden({ temporal: /** @type {const} */ ('stable') }),
  });
  return root;
};
harden(makePackageRegistryTree);

/**
 * @param {RegistryDirectory} registryRoot
 * @param {string} name
 * @param {string} version
 */
export const lookupPackageVersion = async (registryRoot, name, version) => {
  const npm = await registryRoot.lookup('npm');
  const packageDirectory = await /** @type {RegistryHub} */ (npm).lookup(name);
  return /** @type {RegistryDirectory} */ (packageDirectory).lookup(version);
};
harden(lookupPackageVersion);

/**
 * Compatibility surface for callers that still use the old method protocol.
 * It is never installed at `@registry`; callers must explicitly ask for it.
 *
 * @param {RegistryDirectory} registryRoot
 * @param {{ resolve?: EndoRegistry['resolve'] }} [options]
 * @returns {EndoRegistry}
 */
export const makeDeprecatedEndoRegistryAdapter = (
  registryRoot,
  { resolve } = {},
) =>
  makeExo('DeprecatedEndoRegistryAdapter', EndoRegistryInterface, {
    async resolve(packageJson, resolveOptions = {}) {
      if (resolve === undefined) {
        throw makeError(
          X`Deprecated EndoRegistry adapter was constructed without a resolver`,
        );
      }
      return resolve(packageJson, resolveOptions);
    },
    async fetch(name, version) {
      const tree = await lookupPackageVersion(registryRoot, name, version);
      return /** @type {EndoReadableTree} */ (tree);
    },
    async lookup(name, version) {
      try {
        const tree = await lookupPackageVersion(registryRoot, name, version);
        return /** @type {EndoReadableTree} */ (tree);
      } catch (error) {
        if (registryErrorName(error) === 'RegistryNotFoundError')
          return undefined;
        throw error;
      }
    },
    list: async () => harden([]),
    help: () =>
      'Deprecated EndoRegistry method adapter over the package-registry tree',
  });
harden(makeDeprecatedEndoRegistryAdapter);
