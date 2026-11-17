// @ts-check

/**
 * Go-like Minimum Version Selection (MVS) resolve hook for the
 * `EndoRegistry` reference backend.
 *
 * The hook walks a transitive dependency graph rooted at a
 * `package.json`, fetches each transitively-required `package.json`
 * from a caller-supplied fetcher, and partitions the ranges requested of
 * each package into groups that each share one version. Visiting ranges
 * by their least satisfying version, a range joins the first group with
 * which some published version satisfies it, else starts a group of its
 * own (`~1.2.0` and `~1.3.0`, or `^1.0.0` and `^2.0.0`), as npm would
 * install both. Each group selects the least published version that
 * satisfies all of its ranges. The output is a `RegistryResolution`
 * shape the reference backend's `resolve()` method returns.
 *
 * The walk proceeds in rounds, recording every edge of a round before
 * regrouping, so the resolution depends on the dependency graph and not
 * on the order in which `package.json` tables list their entries.
 * Raising a selection does not retract the ranges the superseded
 * version requested of its own dependencies; as in Go's MVS, those
 * ranges stay and continue to constrain later selections. Packages and
 * diagnostics reachable only through a superseded version are
 * nonetheless pruned from the final resolution, and tarballs are
 * fetched, written, and pinned only for that final closure.
 *
 * The fetcher is caller-supplied so the resolver does not bind to a
 * particular HTTP client. The shape matches the npm registry's own
 * JSON API and tarball-stream endpoints (`getPackument(name)` returns
 * the registry's full metadata document for a package;
 * `getTarball(name, version)` returns the published tarball bytes).
 * A test fixture can supply an in-memory `getPackument` /
 * `getTarball` pair; a daemon-side consumer wires the same shape to
 * `node:https`.
 *
 * `dependencies`, `peerDependencies`, and `optionalDependencies` are
 * walked together. Peer requirements are recorded during the walk and
 * checked at the end; an unmet peer raises
 * `RegistryMissingPackageError`. Optional misses are silent at the
 * graph level (no entry in `packagesByKey`) and recorded on the
 * resolution's diagnostic side-channel.
 *
 * Workspace specifiers (`workspace:^`, `workspace:*`, `workspace:1.0.0`)
 * are resolved against a caller-supplied workspace-member lookup,
 * which mirrors the parent-directory walk the design names but keeps
 * the resolver platform-agnostic (no filesystem reads in this module).
 *
 * The semver subset (version parsing, precedence, and range matching) is
 * implemented here rather than imported, so the module depends on
 * nothing beyond `@endo/errors` and uses no host API beyond
 * `TextEncoder`/`TextDecoder`. It is written for SES and XS, but the
 * package's tests run only on Node (`test:xs` is a stub).
 *
 * @import { RegistryResolution, RegistryResolutionEntry, ResolveHook, ResolveHookContext, ResolveOptions, EndoReadableTree, MvsEdge, MvsEdgeOrigin } from '../types.js';
 */

import { makeError, X, q } from '@endo/errors';
import {
  RegistryMissingPackageError,
  RegistryNetworkError,
  RegistryOfflineError,
} from './errors.js';

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/**
 * Compare two strings by code unit, as a sort comparator.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const compareStrings = (a, b) => (a < b ? -1 : Number(a > b));
harden(compareStrings);

/**
 * Compare two decimal digit strings by numeric value without narrowing
 * them to `number`, so identifiers beyond `Number.MAX_SAFE_INTEGER` keep
 * their order (semver places no bound on a numeric identifier).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const compareDigits = (a, b) => {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  return x.length - y.length || compareStrings(x, y);
};
harden(compareDigits);

/**
 * @param {string} digits
 */
const isZero = digits => /^0+$/.test(digits);
harden(isZero);

/**
 * Parse a semver version string. Numeric components stay decimal digit
 * strings so that no width is lost. Pre-release identifiers are kept for
 * precedence; build metadata is dropped. The whole string must match, so
 * `1.2.3garbage` is not a version; a non-conforming string is marked
 * invalid and sorts after every valid version.
 *
 * @param {string} version
 * @returns {{ valid: boolean, major: string, minor: string, patch: string, prerelease: string[], raw: string }}
 */
const parseVersion = version => {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version.trim(),
    );
  if (!match) {
    return {
      valid: false,
      major: '',
      minor: '',
      patch: '',
      prerelease: [],
      raw: version,
    };
  }
  return {
    valid: true,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
    raw: version,
  };
};
harden(parseVersion);

/**
 * Compare pre-release identifier lists by semver precedence: a release
 * (no identifiers) outranks any pre-release, numeric identifiers compare
 * numerically and rank below alphanumeric ones, and a longer list wins
 * when one is a prefix of the other (`beta.2` < `beta.10` < `rc`).
 *
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {number}
 */
const comparePrerelease = (a, b) => {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x !== y) {
      const xNumeric = /^\d+$/.test(x);
      const yNumeric = /^\d+$/.test(y);
      if (xNumeric && yNumeric) return compareDigits(x, y);
      if (xNumeric) return -1;
      if (yNumeric) return 1;
      return compareStrings(x, y);
    }
  }
  return a.length - b.length;
};
harden(comparePrerelease);

/**
 * @param {ReturnType<typeof parseVersion>} a
 * @param {ReturnType<typeof parseVersion>} b
 * @returns {number}
 */
const compareVersions = (a, b) => {
  if (!a.valid || !b.valid) return Number(!a.valid) - Number(!b.valid);
  return (
    compareDigits(a.major, b.major) ||
    compareDigits(a.minor, b.minor) ||
    compareDigits(a.patch, b.patch) ||
    comparePrerelease(a.prerelease, b.prerelease)
  );
};
harden(compareVersions);

/**
 * Total order on version strings: semver precedence, then raw string, so
 * versions differing only in build metadata still sort deterministically.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const compareVersionStrings = (a, b) =>
  compareVersions(parseVersion(a), parseVersion(b)) || compareStrings(a, b);
harden(compareVersionStrings);

/**
 * @param {string} major
 * @param {string} minor
 * @param {string} patch
 * @param {string[]} [prerelease]
 * @returns {ReturnType<typeof parseVersion>}
 */
const makeVersion = (major, minor, patch, prerelease = []) => ({
  valid: true,
  major,
  minor,
  patch,
  prerelease,
  raw: `${major}.${minor}.${patch}`,
});
harden(makeVersion);

/**
 * @param {string} digits
 */
const increment = digits => `${BigInt(digits) + 1n}`;
harden(increment);

/**
 * Parse a possibly partial version as it appears in a range (`1`, `1.2`,
 * `1.x`, `*`, `1.2.3-beta`). A wildcard or missing component leaves it
 * and every later component `undefined`. Returns `undefined` when the
 * text is not a partial version at all.
 *
 * @param {string} text
 */
const parsePartial = text => {
  const match =
    /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      text,
    );
  if (!match) return undefined;
  /** @param {string | undefined} part */
  const concrete = part =>
    part === undefined || /^[xX*]$/.test(part) ? undefined : part;
  const major = concrete(match[1]);
  const minor = major === undefined ? undefined : concrete(match[2]);
  const patch = minor === undefined ? undefined : concrete(match[3]);
  const prerelease =
    patch === undefined || match[4] === undefined ? [] : match[4].split('.');
  return { major, minor, patch, prerelease };
};
harden(parsePartial);

/**
 * @typedef {{ operator: '<' | '<=' | '>' | '>=' | '=', version: ReturnType<typeof parseVersion> }} Comparator
 */

/** `<0.0.0-0`, which no version satisfies. */
const unsatisfiable = harden({
  operator: /** @type {const} */ ('<'),
  version: makeVersion('0', '0', '0', ['0']),
});

/**
 * Desugar one operator applied to a partial version into primitive
 * comparators, following npm's `semver`: a partial `>=` or lower bound
 * fills missing components with zero, and an exclusive upper bound is
 * `<X.Y.Z-0`, which excludes the pre-releases of `X.Y.Z` too (`^1.2` is
 * `>=1.2.0 <2.0.0-0`, `<=1.2` is `<1.3.0-0`, `1` is `>=1.0.0 <2.0.0-0`).
 * An empty list matches every version.
 *
 * @param {string} operator
 * @param {NonNullable<ReturnType<typeof parsePartial>>} partial
 * @returns {Comparator[]}
 */
const desugarComparator = (operator, partial) => {
  const { major, minor, patch, prerelease } = partial;
  if (major === undefined) {
    return operator === '<' || operator === '>' ? [unsatisfiable] : [];
  }
  /**
   * @param {string} upperMajor
   * @param {string} upperMinor
   * @param {string} upperPatch
   * @returns {Comparator}
   */
  const below = (upperMajor, upperMinor, upperPatch) => ({
    operator: '<',
    version: makeVersion(upperMajor, upperMinor, upperPatch, ['0']),
  });
  /** @type {Comparator} */
  const atLeast = {
    operator: '>=',
    version: makeVersion(major, minor ?? '0', patch ?? '0', prerelease),
  };
  // The least release beyond every version the partial covers.
  const [nextMajor, nextMinor] =
    minor === undefined ? [increment(major), '0'] : [major, increment(minor)];
  switch (operator) {
    case '^': {
      if (!isZero(major)) return [atLeast, below(increment(major), '0', '0')];
      if (minor === undefined) return [atLeast, below('1', '0', '0')];
      if (!isZero(minor) || patch === undefined) {
        return [atLeast, below('0', increment(minor), '0')];
      }
      return [atLeast, below('0', '0', increment(patch))];
    }
    case '~':
    case '~>':
      return [atLeast, below(nextMajor, nextMinor, '0')];
    case '':
    case '=':
      return patch === undefined
        ? [atLeast, below(nextMajor, nextMinor, '0')]
        : [{ operator: '=', version: atLeast.version }];
    case '>=':
      return [atLeast];
    case '>':
      return patch === undefined
        ? [{ operator: '>=', version: makeVersion(nextMajor, nextMinor, '0') }]
        : [{ operator: '>', version: atLeast.version }];
    case '<':
      return patch === undefined
        ? [below(major, minor ?? '0', '0')]
        : [{ operator: '<', version: atLeast.version }];
    case '<=':
      return patch === undefined
        ? [below(nextMajor, nextMinor, '0')]
        : [{ operator: '<=', version: atLeast.version }];
    default:
      return [unsatisfiable];
  }
};
harden(desugarComparator);

/**
 * Parse one comparator set of an npm-style range (no `||`) into
 * primitive comparators, or `undefined` when the set is malformed (a
 * dist-tag, a URL, a typo), which then matches no version. Supports:
 *
 * - `^1.2.3`, `^1.2`, `^1` compatible by the leftmost nonzero component
 * - `~1.2.3`, `~1.2`, `~1` compatible by minor (or by major)
 * - `>=1.2.3`, `>1.2`, `<2`, `<=1.2.3`, with or without a space after
 *   the operator
 * - `1.2.3` or `=1.2.3` exact
 * - `1.2.x`, `1.x`, `1.2`, `1`, `*`, and the empty set
 * - `1.2.3 - 2.0.0` inclusive hyphen range, either end possibly partial
 * - space-separated conjunctions of the above
 *
 * @param {string} comparatorSet
 * @returns {Comparator[] | undefined}
 */
const parseComparatorSet = comparatorSet => {
  const text = comparatorSet
    .trim()
    .replace(/(^|\s)(<=|>=|~>|[<>=~^])\s+/g, '$1$2');
  if (text === '') return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen) {
    const from = parsePartial(hyphen[1]);
    const to = parsePartial(hyphen[2]);
    if (from === undefined || to === undefined) return undefined;
    return [...desugarComparator('>=', from), ...desugarComparator('<=', to)];
  }
  /** @type {Comparator[]} */
  const comparators = [];
  for (const token of text.split(/\s+/)) {
    const [, operator = '', rest] = /** @type {RegExpExecArray} */ (
      /^(<=|>=|~>|[<>=~^])?(.*)$/.exec(token)
    );
    const partial = parsePartial(rest);
    if (partial === undefined) return undefined;
    comparators.push(...desugarComparator(operator, partial));
  }
  return comparators;
};
harden(parseComparatorSet);

/**
 * @param {ReturnType<typeof parseVersion>} candidate
 * @param {Comparator} comparator
 */
const matchesComparator = (candidate, { operator, version }) => {
  const order = compareVersions(candidate, version);
  switch (operator) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    default:
      return order === 0;
  }
};
harden(matchesComparator);

/**
 * Determine whether a candidate version satisfies an npm-style range
 * specifier. A range is a `||` union of comparator sets, and the
 * candidate must match one of them by full semver precedence. As in npm,
 * a pre-release matches a comparator set only when that same set names a
 * pre-release of the same `major.minor.patch`, so `1.0.0-rc.1` satisfies
 * `^1.0.0-rc.0` but not `^1.0.0`, nor `^1.0.0 || ^2.0.0-rc.0`.
 *
 * @param {string} candidateRaw
 * @param {string} range
 * @returns {boolean}
 */
export const satisfiesRange = (candidateRaw, range) => {
  const candidate = parseVersion(candidateRaw);
  if (!candidate.valid) return false;
  return range.split('||').some(comparatorSet => {
    const comparators = parseComparatorSet(comparatorSet);
    if (comparators === undefined) return false;
    if (
      !comparators.every(comparator => matchesComparator(candidate, comparator))
    ) {
      return false;
    }
    return (
      candidate.prerelease.length === 0 ||
      comparators.some(
        ({ version }) =>
          version.prerelease.length > 0 &&
          compareDigits(version.major, candidate.major) === 0 &&
          compareDigits(version.minor, candidate.minor) === 0 &&
          compareDigits(version.patch, candidate.patch) === 0,
      )
    );
  });
};
harden(satisfiesRange);

/**
 * Recognize the `workspace:` specifier shape.
 *
 * @param {string} range
 */
const isWorkspaceSpecifier = range => range.trim().startsWith('workspace:');
harden(isWorkspaceSpecifier);

/**
 * Read and parse a `package.json` payload from UTF-8 bytes.
 *
 * @param {Uint8Array | string} payload
 */
const decodePackageJson = payload => {
  const text =
    typeof payload === 'string' ? payload : utf8Decoder.decode(payload);
  return JSON.parse(text);
};
harden(decodePackageJson);

/**
 * Canonical key composition: scoped packages keep the `@scope/` prefix
 * and the version goes after the bare name, matching npm's own
 * convention (`@endo/patterns@1.2.1`, `ses@1.0.0`).
 *
 * @param {string} name
 * @param {string} version
 */
const composeKey = (name, version) => `${name}@${version}`;
harden(composeKey);

/**
 * Compute a stable content hash of the resolution by hashing the
 * canonical key list and the per-entry integrity strings together.
 *
 * The hashing power is the caller-supplied `sha256` function, kept
 * separate from the CAS's `write` so the resolution-hash bytes are
 * not deposited into the CAS as a side effect.
 *
 * @param {readonly string[]} keys
 * @param {Record<string, RegistryResolutionEntry>} packagesByKey
 * @param {(bytes: Uint8Array) => Promise<string>} sha256
 */
const hashResolution = async (keys, packagesByKey, sha256) => {
  const lines = keys.map(key => `${key}\t${packagesByKey[key].integrity}`);
  return sha256(utf8Encoder.encode(lines.join('\n')));
};
harden(hashResolution);

/**
 * Construct an MVS resolve hook.
 *
 * The hook is what the npm reference backend's `resolveHook` slot
 * accepts. Calling `registry.resolve(packageJsonBytes, options)` runs
 * the MVS walk and produces a `RegistryResolution` whose entries name
 * `treeRef` capabilities the daemon-side consumer can resolve through
 * the CAS bus.
 *
 * The hook expects a `fetcher` with two methods. `getPackument(name)`
 * returns the registry's metadata document for the package (with
 * `versions[v]` carrying `dependencies`, `peerDependencies`,
 * `optionalDependencies`, and `dist.integrity`).
 * `getTarball(name, version)` returns the published tarball bytes;
 * the hook writes those bytes through the CAS and uses a caller-
 * supplied `makeTreeRef` adapter to turn the resulting hash into the
 * `EndoReadableTree` capability the resolution surfaces.
 *
 * The `makeTreeRef` adapter is supplied separately because the
 * reference backend is daemon-agnostic: a test passes a fake adapter
 * that returns a stand-in `Far` exo, the daemon-integrated consumer
 * passes an adapter that mints a `readable-tree` formula keyed by
 * the CAS hash.
 *
 * @param {{
 *   fetcher: {
 *     getPackument(name: string): Promise<{
 *       versions: Record<string, {
 *         dependencies?: Record<string, string>,
 *         peerDependencies?: Record<string, string>,
 *         optionalDependencies?: Record<string, string>,
 *         dist?: { integrity?: string, tarball?: string },
 *       }>,
 *     }>,
 *     getTarball(name: string, version: string): Promise<Uint8Array>,
 *   },
 *   makeTreeRef: (hash: string, name: string, version: string) => EndoReadableTree | Promise<EndoReadableTree>,
 *   sha256?: (bytes: Uint8Array) => Promise<string>,
 *   workspaceLookup?: (name: string) => Promise<{
 *     packageJson: string | Uint8Array,
 *     treeRef: EndoReadableTree,
 *   } | undefined>,
 * }} options
 * @returns {ResolveHook}
 */
export const makeMvsResolveHook = options => {
  const {
    fetcher,
    makeTreeRef,
    workspaceLookup,
    sha256: sha256Power,
  } = options;
  if (!fetcher || typeof fetcher.getPackument !== 'function') {
    throw makeError(
      X`makeMvsResolveHook requires a fetcher with getPackument and getTarball`,
    );
  }
  if (typeof makeTreeRef !== 'function') {
    throw makeError(X`makeMvsResolveHook requires a makeTreeRef adapter`);
  }

  /**
   * Cache packuments per resolve call so a transitively shared
   * dependency is fetched once per (entry, name) walk.
   *
   * @param {Map<string, Awaited<ReturnType<typeof fetcher.getPackument>>>} packumentCache
   * @param {string} name
   */
  const loadPackument = async (packumentCache, name) => {
    await null;
    const cached = packumentCache.get(name);
    if (cached !== undefined) return cached;
    let document;
    try {
      document = await fetcher.getPackument(name);
    } catch (error) {
      throw RegistryNetworkError(
        `failed to fetch packument for ${name}: ${/** @type {Error} */ (error).message}`,
      );
    }
    if (
      !document ||
      typeof document !== 'object' ||
      typeof document.versions !== 'object'
    ) {
      throw RegistryMissingPackageError(
        `packument for ${name} has no versions table`,
      );
    }
    packumentCache.set(name, document);
    return document;
  };

  /**
   * Published versions of a package in ascending order, cached per
   * packument document.
   *
   * @type {WeakMap<object, string[]>}
   */
  const ascendingVersionsCache = new WeakMap();

  /**
   * @param {Awaited<ReturnType<typeof fetcher.getPackument>>} document
   * @returns {string[]}
   */
  const ascendingVersions = document => {
    let versions = ascendingVersionsCache.get(document);
    if (versions === undefined) {
      versions = Object.keys(document.versions).sort(compareVersionStrings);
      ascendingVersionsCache.set(document, versions);
    }
    return versions;
  };

  /**
   * Pick the least published version that satisfies every requirement.
   *
   * MVS widens a selection only when another requirement in the same group
   * demands it, where picking the newest satisfying version would
   * reproduce npm's eager upgrades. Candidates sort by semver precedence
   * and then by their raw string, so the choice does not depend on
   * packument key order.
   *
   * @param {Awaited<ReturnType<typeof fetcher.getPackument>>} document
   * @param {readonly string[]} ranges
   * @returns {string | undefined} undefined when no version satisfies
   *   every range.
   */
  const selectLeastSatisfying = (document, ranges) =>
    ascendingVersions(document).find(version =>
      ranges.every(range => satisfiesRange(version, range)),
    );

  /**
   * Partition the ranges requested of one package into groups that each
   * share one selected version. Ranges are visited by their least
   * satisfying version and then by their text, and each joins the first
   * group it can share a version with, else starts a group of its own.
   * The partition is therefore a function of the set of ranges alone,
   * not of the order in which the walk met them.
   *
   * Every range must be satisfiable on its own. Groups select distinct
   * versions: a range that started a later group could not share a
   * version with an earlier group's ranges at that point, and groups
   * only narrow.
   *
   * @param {Awaited<ReturnType<typeof fetcher.getPackument>>} document
   * @param {Iterable<string>} ranges
   * @returns {Array<{ ranges: string[], version: string }>}
   */
  const groupRanges = (document, ranges) => {
    const ordered = [...ranges]
      .map(range => ({
        range,
        least: /** @type {string} */ (selectLeastSatisfying(document, [range])),
      }))
      .sort(
        (a, b) =>
          compareVersionStrings(a.least, b.least) ||
          compareStrings(a.range, b.range),
      );
    /** @type {Array<{ ranges: string[], version: string }>} */
    const groups = [];
    for (const { range, least } of ordered) {
      const group = groups.find(candidate => {
        const version = selectLeastSatisfying(document, [
          ...candidate.ranges,
          range,
        ]);
        if (version === undefined) return false;
        candidate.ranges.push(range);
        candidate.version = version;
        return true;
      });
      if (group === undefined) {
        groups.push({ ranges: [range], version: least });
      }
    }
    return groups;
  };

  return /** @type {ResolveHook} */ (
    async (
      packageJson,
      /** @type {ResolveOptions} */ resolveOptions,
      /** @type {ResolveHookContext} */ context,
    ) => {
      await null;
      const { offline = false } = resolveOptions || {};

      let entry;
      try {
        entry = decodePackageJson(packageJson);
      } catch (error) {
        throw makeError(
          X`entry package.json is not valid JSON: ${
            /** @type {Error} */ (error).message
          }`,
        );
      }

      /** @type {Map<string, Awaited<ReturnType<typeof fetcher.getPackument>>>} */
      const packumentCache = new Map();

      /**
       * Every version the walk has selected at any point, keyed by
       * `name@version`, with the dependency tables it declares. A
       * workspace member is keyed by its bare name.
       *
       * @type {Map<string, { name: string, version: string, integrity: string, treeRef?: EndoReadableTree, isWorkspace?: boolean, packageJson?: string, dependencyTables: Record<string, unknown> }>}
       */
      const selections = new Map();
      /**
       * The ranges requested of each registry package, so far.
       *
       * @type {Map<string, Set<string>>}
       */
      const rangesByName = new Map();
      /**
       * The current partition of each package's ranges.
       *
       * @type {Map<string, Array<{ ranges: string[], version: string }>>}
       */
      const groupsByName = new Map();
      /** @type {Array<{ importer: string, name: string, range: string, from: MvsEdgeOrigin, optional?: boolean }>} */
      const peerRequirements = [];
      /** @type {Array<{ importer: string, name: string, range: string, reason: string, from: MvsEdgeOrigin }>} */
      const unmetOptionals = [];
      /** @type {Array<{ importer: string, name: string, range: string, version: string, from: MvsEdgeOrigin }>} */
      const workspaceMismatches = [];

      /**
       * Enqueue all dependency edges from one package descriptor.
       *
       * @param {MvsEdge[]} frontier
       * @param {Record<string, unknown>} pkg
       * @param {string} importer
       * @param {MvsEdgeOrigin} from
       */
      const enqueueAll = (frontier, pkg, importer, from) => {
        const optionals =
          /** @type {Record<string, string> | undefined} */
          (pkg.optionalDependencies) ?? {};
        const peerMeta =
          /** @type {Record<string, { optional?: boolean }> | undefined} */
          (pkg.peerDependenciesMeta) ?? {};
        const sources = /** @type {const} */ ([
          'dependencies',
          'peerDependencies',
          'optionalDependencies',
        ]);
        for (const source of sources) {
          const table =
            /** @type {Record<string, string> | undefined} */
            (pkg[source]);
          if (table) {
            for (const [name, range] of Object.entries(table)) {
              // npm copies `optionalDependencies` into `dependencies` on
              // publish, and an optional entry overrides a required one,
              // so the optional edge alone stands for the name.
              if (
                source !== 'dependencies' ||
                !Object.hasOwn(optionals, name)
              ) {
                /** @type {MvsEdge} */
                const edge = { name, range, source, importer, from };
                if (
                  source === 'peerDependencies' &&
                  peerMeta[name]?.optional === true
                ) {
                  edge.optionalPeer = true;
                }
                frontier.push(edge);
              }
            }
          }
        }
      };

      /**
       * Record a workspace member as the selection for its name.
       *
       * @param {string} name
       * @param {{ packageJson: string | Uint8Array, treeRef: EndoReadableTree }} member
       * @param {MvsEdge[]} next
       */
      const selectWorkspaceMember = (name, member, next) => {
        const memberPkg = decodePackageJson(member.packageJson);
        const memberPjString =
          typeof member.packageJson === 'string'
            ? member.packageJson
            : utf8Decoder.decode(member.packageJson);
        const version = memberPkg.version || '0.0.0';
        if (!selections.has(name)) {
          selections.set(name, {
            name,
            version,
            integrity: 'workspace:',
            treeRef: member.treeRef,
            isWorkspace: true,
            packageJson: memberPjString,
            dependencyTables: memberPkg,
          });
          enqueueAll(next, memberPkg, name, name);
        }
        return version;
      };

      /**
       * Process a single frontier edge: record its range, or its
       * workspace member, and its diagnostics. Edges a new selection
       * declares go on `next`.
       *
       * @param {MvsEdge} edge
       * @param {Set<string>} touched names whose ranges grew
       * @param {MvsEdge[]} next
       */
      const processEdge = async (edge, touched, next) => {
        await null;
        const { name, range, source, importer, from } = edge;

        // An optional peer is never installed on its own account; it
        // constrains only a version the closure already holds.
        if (edge.optionalPeer) {
          peerRequirements.push({
            importer,
            name,
            range,
            from,
            optional: true,
          });
          return;
        }

        // Workspace specifier? Prefer workspace lookup over registry.
        if (isWorkspaceSpecifier(range)) {
          if (typeof workspaceLookup !== 'function') {
            throw RegistryMissingPackageError(
              `${importer} requested workspace:${name} but no workspaceLookup was provided`,
            );
          }
          const member = await workspaceLookup(name);
          if (member === undefined) {
            throw RegistryMissingPackageError(
              `workspace dependency ${q(name)} requested by ${q(importer)} not found in workspace`,
            );
          }
          selectWorkspaceMember(name, member, next);
          return;
        }

        // Workspace member preferred even when range is not workspace:.
        // (workspace-wins regardless of predicate, per the
        // Workspace resolution section of mvs-resolver.md).
        if (typeof workspaceLookup === 'function') {
          const member = await workspaceLookup(name);
          if (member !== undefined) {
            const memberVersion = selectWorkspaceMember(name, member, next);
            // Diagnostic when the workspace member's version does not
            // satisfy the importer's range; we still resolve to the
            // workspace member, but the unmet predicate is recorded
            // on the resolution's `workspaceMismatches` diagnostic
            // channel. Kept separate from `unmetOptionals` because
            // the semantics differ: an unmet optional is a missing
            // package the resolution simply does not carry, whereas a
            // workspace mismatch is a present package whose version
            // disagrees with the importer's range.
            if (!satisfiesRange(memberVersion, range)) {
              workspaceMismatches.push({
                importer,
                name,
                range,
                version: memberVersion,
                from,
              });
            }
            if (source === 'peerDependencies') {
              peerRequirements.push({ importer, name, range, from });
            }
            return;
          }
        }

        let document;
        try {
          document = await loadPackument(packumentCache, name);
        } catch (error) {
          if (source === 'optionalDependencies') {
            unmetOptionals.push({
              importer,
              name,
              range,
              reason: /** @type {Error} */ (error).message,
              from,
            });
            return;
          }
          if (source === 'peerDependencies') {
            // Defer the failure: the peer-requirement check at the end
            // raises `RegistryMissingPackageError` with a fully-formed
            // message describing the unmet peer. Logging the upstream
            // load failure here would lose the "unmet peer" framing.
            peerRequirements.push({ importer, name, range, from });
            return;
          }
          throw error;
        }

        if (selectLeastSatisfying(document, [range]) === undefined) {
          const reason = `${name}: no version satisfies ${q(range)}`;
          if (source === 'optionalDependencies') {
            unmetOptionals.push({ importer, name, range, reason, from });
            return;
          }
          throw RegistryMissingPackageError(reason);
        }

        const ranges = rangesByName.get(name) ?? new Set();
        if (!ranges.has(range)) {
          ranges.add(range);
          rangesByName.set(name, ranges);
          touched.add(name);
        }
        if (source === 'peerDependencies') {
          peerRequirements.push({ importer, name, range, from });
        }
      };

      /**
       * Record a newly selected registry version and enqueue the edges
       * it declares. Reads metadata only: tarballs are fetched once the
       * final closure is known.
       *
       * @param {string} name
       * @param {string} version
       * @param {MvsEdge[]} next
       */
      const selectRegistryVersion = async (name, version, next) => {
        await null;
        const key = composeKey(name, version);
        if (offline) {
          // In offline mode, only accept entries already present in the
          // caller-supplied package cache.
          const cached = await context.packages.get(name, version);
          if (cached === undefined) {
            throw RegistryOfflineError(
              `offline: no cached entry for ${name}@${version}`,
            );
          }
          // Walk the cached entry's transitive deps. The cache row's
          // `packageJson` snapshot carries the declared dependency
          // tables; without it the closure would be silently incomplete
          // (any cached entry with declared dependencies would resolve
          // to an empty edge set). When a caller-supplied row omits the
          // snapshot, surface the gap on the diagnostic side channel
          // rather than walking against an empty `{}`.
          /** @type {Record<string, unknown>} */
          let dependencyTables = {};
          if (typeof cached.packageJson === 'string') {
            dependencyTables = decodePackageJson(cached.packageJson);
          } else {
            unmetOptionals.push({
              importer: name,
              name,
              range: version,
              reason: `offline: cached entry for ${name}@${version} has no packageJson snapshot; transitive deps not walked`,
              from: key,
            });
          }
          selections.set(key, {
            name,
            version,
            integrity: cached.integrity,
            treeRef: cached.treeRef,
            packageJson: cached.packageJson,
            dependencyTables,
          });
          enqueueAll(next, dependencyTables, name, key);
          return;
        }
        const document =
          /** @type {Awaited<ReturnType<typeof fetcher.getPackument>>} */ (
            packumentCache.get(name)
          );
        // The metadata document carries the version's dependency tables
        // alongside its dist info, so we walk without a second fetch.
        const childMeta = document.versions[version] || {};
        // Snapshot the dependency tables into a `packageJson`-shaped
        // payload the cache row carries forward. A subsequent
        // offline-mode resolution against the cached entry walks this
        // snapshot rather than an empty `{}`. Carries only the
        // dependency tables (the dist/integrity is recorded separately
        // on the row); a future refinement may carry the full
        // package.json payload when the resolver fetches the tarball.
        const packageJsonSnapshot = JSON.stringify({
          name,
          version,
          dependencies: childMeta.dependencies || {},
          peerDependencies: childMeta.peerDependencies || {},
          optionalDependencies: childMeta.optionalDependencies || {},
        });
        selections.set(key, {
          name,
          version,
          integrity: childMeta.dist?.integrity || '',
          packageJson: packageJsonSnapshot,
          dependencyTables: /** @type {Record<string, unknown>} */ (childMeta),
        });
        enqueueAll(
          next,
          /** @type {Record<string, unknown>} */ (childMeta),
          name,
          key,
        );
      };

      // Walk in rounds. Each round records every edge of the frontier,
      // then regroups each package whose ranges grew and walks the
      // versions selected for the first time. Because a round's ranges
      // are fixed before any package is regrouped, the walk does not
      // depend on the order in which dependency tables list their
      // entries.
      /** @type {MvsEdge[]} */
      const entryEdges = [];
      enqueueAll(entryEdges, entry, entry.name || '<entry>', undefined);
      for (let frontier = entryEdges; frontier.length > 0;) {
        /** @type {Set<string>} */
        const touched = new Set();
        /** @type {MvsEdge[]} */
        const next = [];
        for (const edge of frontier) {
          // eslint-disable-next-line no-await-in-loop
          await processEdge(edge, touched, next);
        }
        for (const name of [...touched].sort(compareStrings)) {
          const groups = groupRanges(
            /** @type {Awaited<ReturnType<typeof fetcher.getPackument>>} */ (
              packumentCache.get(name)
            ),
            /** @type {Set<string>} */ (rangesByName.get(name)),
          );
          groupsByName.set(name, groups);
          for (const { version } of groups) {
            if (!selections.has(composeKey(name, version))) {
              // eslint-disable-next-line no-await-in-loop
              await selectRegistryVersion(name, version, next);
            }
          }
        }
        frontier = next;
      }

      /**
       * The selection key an edge resolves to under the final grouping.
       *
       * @param {MvsEdge} edge
       * @returns {string | undefined}
       */
      const targetOf = ({ name, range }) => {
        if (selections.get(name)?.isWorkspace) return name;
        const group = groupsByName
          .get(name)
          ?.find(candidate => candidate.ranges.includes(range));
        return group === undefined
          ? undefined
          : composeKey(name, group.version);
      };

      /**
       * Raising a selection leaves behind versions, and packages, that
       * only a superseded version required. Collect the selections
       * reachable from the entry, each with the edges that reach it, in
       * discovery order (an importer before what it imports).
       *
       * @param {Set<string>} excluded selections to treat as absent
       */
      const reachableFrom = excluded => {
        /** @type {Map<string, MvsEdge[]>} */
        const reached = new Map();
        const pending = [...entryEdges].reverse();
        for (
          let edge = pending.pop();
          edge !== undefined;
          edge = pending.pop()
        ) {
          const target = edge.optionalPeer ? undefined : targetOf(edge);
          if (target !== undefined && !excluded.has(target)) {
            const incoming = reached.get(target);
            if (incoming === undefined) {
              reached.set(target, [edge]);
              /** @type {MvsEdge[]} */
              const declared = [];
              const selection =
                /** @type {{ name: string, dependencyTables: Record<string, unknown> }} */ (
                  selections.get(target)
                );
              enqueueAll(
                declared,
                selection.dependencyTables,
                selection.name,
                target,
              );
              pending.push(...declared.reverse());
            } else {
              incoming.push(edge);
            }
          }
        }
        return reached;
      };

      /** @type {Set<string>} */
      const excluded = new Set();
      /** @type {Map<string, { hash: string, treeRef: EndoReadableTree }>} */
      const fetched = new Map();
      let reachable = reachableFrom(excluded);

      /**
       * Whether the selection that declared an edge is in the final
       * closure.
       *
       * @param {MvsEdgeOrigin} from
       */
      const isLive = from => from === undefined || reachable.has(from);
      /**
       * Drop diagnostics from pruned or superseded selections and strip
       * their provenance.
       *
       * @template {{ from: MvsEdgeOrigin }} T
       * @param {T[]} diagnostics
       * @returns {Omit<T, 'from'>[]}
       */
      const liveDiagnostics = diagnostics =>
        diagnostics
          .filter(diagnostic => isLive(diagnostic.from))
          .map(({ from: _from, ...diagnostic }) => diagnostic);

      /**
       * Check every live peer requirement against the closure.
       */
      const checkPeers = () => {
        for (const peer of liveDiagnostics(peerRequirements)) {
          const versions = [...reachable.keys()]
            .map(
              key =>
                /** @type {{ name: string, version: string }} */ (
                  selections.get(key)
                ),
            )
            .filter(selection => selection.name === peer.name)
            .map(selection => selection.version);
          if (versions.length === 0) {
            if (!peer.optional) {
              throw RegistryMissingPackageError(
                `${peer.importer} declares unmet peer dependency ${peer.name}@${peer.range}`,
              );
            }
          } else if (
            !versions.some(version => satisfiesRange(version, peer.range))
          ) {
            throw RegistryMissingPackageError(
              `${peer.importer} declares peer dependency ${peer.name}@${peer.range} but resolved closure has no satisfying version`,
            );
          }
        }
      };

      // Check peers before any tarball is fetched, and again if a failed
      // optional fetch shrank the closure.
      checkPeers();

      // Fetch tarballs only for the final closure, so a superseded
      // version is never fetched, written, minted, or pinned. A tarball
      // that fails to fetch is dropped, with what only it required, when
      // every edge reaching it is optional.
      if (!offline) {
        for (let settled = false; !settled;) {
          settled = true;
          for (const [key, incoming] of reachable) {
            const selection =
              /** @type {{ name: string, version: string, isWorkspace?: boolean }} */ (
                selections.get(key)
              );
            if (!selection.isWorkspace && !fetched.has(key)) {
              const { name, version } = selection;
              let tarballBytes;
              try {
                // eslint-disable-next-line no-await-in-loop
                tarballBytes = await fetcher.getTarball(name, version);
              } catch (error) {
                const message = /** @type {Error} */ (error).message;
                if (
                  !incoming.every(
                    edge => edge.source === 'optionalDependencies',
                  )
                ) {
                  throw RegistryNetworkError(
                    `failed to fetch tarball for ${name}@${version}: ${message}`,
                  );
                }
                for (const edge of incoming) {
                  unmetOptionals.push({
                    importer: edge.importer,
                    name,
                    range: edge.range,
                    reason: `tarball fetch failed: ${message}`,
                    from: edge.from,
                  });
                }
                excluded.add(key);
                reachable = reachableFrom(excluded);
                settled = false;
                break;
              }
              // eslint-disable-next-line no-await-in-loop
              const hash = await context.cas.write(tarballBytes);
              // eslint-disable-next-line no-await-in-loop
              const treeRef = await makeTreeRef(hash, name, version);
              fetched.set(key, { hash, treeRef });
            }
          }
        }
      }

      if (excluded.size > 0) {
        checkPeers();
      }

      /** @type {Record<string, RegistryResolutionEntry>} */
      const packagesByKey = {};
      for (const key of reachable.keys()) {
        const selection =
          /** @type {NonNullable<ReturnType<typeof selections.get>>} */ (
            selections.get(key)
          );
        const download = fetched.get(key);
        if (download !== undefined) {
          context.retentionLinks.pin(download.hash);
        }
        // Workspace members keep the bare name as their key, no
        // version segment. Per the Synthesized layout section of
        // snapshot-mapper.md, this is the encoding the mapper
        // relies on to distinguish workspace members from
        // registry-resolved entries.
        packagesByKey[key] = {
          name: selection.name,
          version: selection.version,
          treeRef: /** @type {EndoReadableTree} */ (
            download?.treeRef ?? selection.treeRef
          ),
          integrity: selection.integrity,
          ...(selection.packageJson !== undefined
            ? { packageJson: selection.packageJson }
            : {}),
        };
      }
      const keys = Object.keys(packagesByKey).sort();
      // Resolution-hash computation. Caller supplies a `sha256` power
      // separately so the resolution-hash bytes never enter the CAS as
      // a side effect. When no power was supplied, the resolver falls
      // back to a length-prefixed concatenation that is deterministic
      // but not cryptographic; consumers that care about resolution-
      // hash collision resistance must supply the `sha256` option.
      const resolutionHashBytes = await hashResolution(
        keys,
        packagesByKey,
        sha256Power ??
          (async bytes => {
            const modulus = 2n ** 256n;
            let acc = 0n;
            for (const b of bytes) {
              acc = (acc * 257n + BigInt(b)) % modulus;
            }
            return `nohash-${acc.toString(16).padStart(64, '0')}`;
          }),
      );

      /** @type {RegistryResolution & { unmetOptionals?: unknown, workspaceMismatches?: unknown }} */
      const resolution = harden({
        packagesByKey: harden(packagesByKey),
        keys: harden(keys),
        resolutionHash: resolutionHashBytes,
        unmetOptionals: harden(liveDiagnostics(unmetOptionals)),
        workspaceMismatches: harden(liveDiagnostics(workspaceMismatches)),
      });
      return resolution;
    }
  );
};
harden(makeMvsResolveHook);
