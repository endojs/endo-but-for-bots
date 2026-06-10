// @ts-check

/**
 * Go-like Minimum Version Selection (MVS) resolve hook for the
 * `EndoRegistry` reference backend.
 *
 * The hook walks a transitive dependency graph rooted at a
 * `package.json`, fetches each transitively-required `package.json`
 * from a caller-supplied fetcher, and selects the greatest mentioned
 * minor (and patch) per major. The output is a `RegistryResolution`
 * shape the reference backend's `resolve()` method returns.
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
 * @import { RegistryResolution, RegistryResolutionEntry, ResolveHook, ResolveHookContext, ResolveOptions, EndoReadableTree } from '../types.js';
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
 * Parse a semver-shaped version string into its numeric components.
 *
 * Permissive on prerelease and build-metadata tags; both are dropped
 * for comparison purposes. A non-conforming string sorts to the end
 * (Infinity components).
 *
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, raw: string }}
 */
const parseVersion = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return { major: Infinity, minor: Infinity, patch: Infinity, raw: version };
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: version,
  };
};
harden(parseVersion);

/**
 * Compare two parsed versions in dewey-decimal order.
 *
 * @param {ReturnType<typeof parseVersion>} a
 * @param {ReturnType<typeof parseVersion>} b
 * @returns {number}
 */
const compareVersions = (a, b) => {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
};
harden(compareVersions);

/**
 * Determine whether a candidate version satisfies an npm-style range
 * specifier. Supports the common shapes that appear in published
 * `package.json` dependencies:
 *
 * - `^1.2.3` greatest compatible by major
 * - `~1.2.3` greatest compatible by minor
 * - `>=1.2.3`, `>1.2.3`, `<1.2.3`, `<=1.2.3`
 * - `1.2.3` exact
 * - `1.2.x`, `1.x`, `*` shape
 * - `1.2.3 - 2.0.0` range (inclusive)
 * - `||` alternation
 *
 * Pre-release tags are stripped from the candidate for the comparison;
 * this matches MVS's "greatest mentioned minor per major" rule which
 * is concerned with the dewey-decimal ordering rather than with
 * pre-release precedence.
 *
 * @param {string} candidateRaw
 * @param {string} range
 * @returns {boolean}
 */
export const satisfiesRange = (candidateRaw, range) => {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') {
    return true;
  }
  // Alternation: any alternative may match.
  if (trimmed.includes('||')) {
    return trimmed
      .split('||')
      .some(part => satisfiesRange(candidateRaw, part.trim()));
  }
  // Hyphen range: '1.2.3 - 2.0.0'.
  const hyphen = /^([^\s]+)\s+-\s+([^\s]+)$/.exec(trimmed);
  if (hyphen) {
    return (
      satisfiesRange(candidateRaw, `>=${hyphen[1]}`) &&
      satisfiesRange(candidateRaw, `<=${hyphen[2]}`)
    );
  }
  // Composite: '>=1.2.3 <2.0.0' (space-separated AND).
  if (/\s/.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .every(part => satisfiesRange(candidateRaw, part));
  }
  const candidate = parseVersion(candidateRaw);
  // Caret: '^1.2.3'.
  if (trimmed.startsWith('^')) {
    const base = parseVersion(trimmed.slice(1));
    if (candidate.major !== base.major) return false;
    if (base.major > 0) {
      return compareVersions(candidate, base) >= 0;
    }
    if (base.minor > 0) {
      return (
        candidate.minor === base.minor && compareVersions(candidate, base) >= 0
      );
    }
    return compareVersions(candidate, base) === 0;
  }
  // Tilde: '~1.2.3'.
  if (trimmed.startsWith('~')) {
    const base = parseVersion(trimmed.slice(1));
    if (candidate.major !== base.major) return false;
    if (candidate.minor !== base.minor) return false;
    return compareVersions(candidate, base) >= 0;
  }
  // Comparators.
  if (trimmed.startsWith('>=')) {
    return compareVersions(candidate, parseVersion(trimmed.slice(2))) >= 0;
  }
  if (trimmed.startsWith('<=')) {
    return compareVersions(candidate, parseVersion(trimmed.slice(2))) <= 0;
  }
  if (trimmed.startsWith('>')) {
    return compareVersions(candidate, parseVersion(trimmed.slice(1))) > 0;
  }
  if (trimmed.startsWith('<')) {
    return compareVersions(candidate, parseVersion(trimmed.slice(1))) < 0;
  }
  if (trimmed.startsWith('=')) {
    return compareVersions(candidate, parseVersion(trimmed.slice(1))) === 0;
  }
  // X-range: '1.2.x' or '1.x'.
  if (/[xX*]/.test(trimmed)) {
    const parts = trimmed.split('.');
    const majorOk =
      parts[0] === '*' ||
      parts[0] === 'x' ||
      parts[0] === 'X' ||
      candidate.major === Number(parts[0]);
    if (!majorOk) return false;
    if (parts.length < 2 || /[xX*]/.test(parts[1])) return true;
    if (candidate.minor !== Number(parts[1])) return false;
    if (parts.length < 3 || /[xX*]/.test(parts[2])) return true;
    return candidate.patch === Number(parts[2]);
  }
  // Exact.
  return compareVersions(candidate, parseVersion(trimmed)) === 0;
};
harden(satisfiesRange);

/**
 * Extract the canonical major key from a range specifier, used to drive
 * MVS's per-major coexistence. For shapes that pin a major (`^1.2.3`,
 * `1.x`, `>=1.2.3 <2.0.0`), the major is the leftmost numeric segment.
 * For shapes without a major (`*`), returns 'any'.
 *
 * The classification is permissive; if two ranges classify under the
 * same major they share a resolution slot, otherwise they get distinct
 * slots and the resolver emits both entries (the multi-major
 * coexistence case).
 *
 * @param {string} range
 * @returns {string}
 */
export const parseRangeMajor = range => {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') {
    return 'any';
  }
  const numeric = /^[^\d]*(\d+)/.exec(trimmed);
  return numeric ? numeric[1] : 'any';
};
harden(parseRangeMajor);

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
    } catch (err) {
      throw RegistryNetworkError(
        `failed to fetch packument for ${name}: ${/** @type {Error} */ (err).message}`,
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
   * Pick the greatest version in the packument that satisfies `range`.
   *
   * @param {Awaited<ReturnType<typeof fetcher.getPackument>>} document
   * @param {string} name
   * @param {string} range
   * @returns {string}
   */
  const selectGreatestSatisfying = (document, name, range) => {
    const candidates = Object.keys(document.versions)
      .filter(v => satisfiesRange(v, range))
      .map(parseVersion)
      .sort(compareVersions);
    if (candidates.length === 0) {
      throw RegistryMissingPackageError(
        `${name}: no version satisfies ${q(range)}`,
      );
    }
    return candidates[candidates.length - 1].raw;
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
      } catch (err) {
        throw makeError(
          X`entry package.json is not valid JSON: ${
            /** @type {Error} */ (err).message
          }`,
        );
      }

      /** @type {Map<string, Awaited<ReturnType<typeof fetcher.getPackument>>>} */
      const packumentCache = new Map();

      /**
       * Resolved selections, keyed by name and per-major slot. The slot
       * is the canonical major derived from the *requested* range, not
       * from the selected version, so two requesters that classify
       * under the same slot share a selection and the resolver picks
       * the greater of the two.
       *
       * @type {Map<string, Map<string, { version: string, integrity: string, treeRef: EndoReadableTree, isWorkspace?: boolean }>>}
       */
      const resolved = new Map();
      /** @type {Array<{ importer: string, name: string, range: string }>} */
      const peerRequirements = [];
      /** @type {Array<{ importer: string, name: string, range: string, reason: string }>} */
      const unmetOptionals = [];

      /**
       * Enqueue all dependency edges from one package descriptor.
       *
       * @param {Array<{ name: string, range: string, source: string, importer: string }>} frontier
       * @param {Record<string, unknown>} pkg
       * @param {string} importer
       */
      const enqueueAll = (frontier, pkg, importer) => {
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
              frontier.push({ name, range, source, importer });
            }
          }
        }
      };

      const frontier = [];
      enqueueAll(frontier, entry, entry.name || '<entry>');

      /**
       * Process a single frontier edge. Returns nothing; mutates the
       * outer `resolved`, `peerRequirements`, `unmetOptionals`,
       * `frontier` accumulators. May throw; the caller's loop wraps the
       * dispatch.
       *
       * @param {{ name: string, range: string, source: string, importer: string }} edge
       */
      const processEdge = async edge => {
        await null;
        const { name, range, source, importer } = edge;

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
          const memberPkg = decodePackageJson(member.packageJson);
          const wsSlot = resolved.get(name) ?? new Map();
          wsSlot.set('workspace', {
            version: memberPkg.version || '0.0.0',
            integrity: 'workspace:',
            treeRef: member.treeRef,
            isWorkspace: true,
          });
          resolved.set(name, wsSlot);
          enqueueAll(frontier, memberPkg, name);
          return;
        }

        // Workspace member preferred even when range is not workspace:.
        // (workspace-wins regardless of predicate, per the
        // Workspace resolution section of mvs-resolver.md).
        if (typeof workspaceLookup === 'function') {
          const member = await workspaceLookup(name);
          if (member !== undefined) {
            const memberPkg = decodePackageJson(member.packageJson);
            const memberVersion = memberPkg.version || '0.0.0';
            const wsSlot = resolved.get(name) ?? new Map();
            if (!wsSlot.has('workspace')) {
              wsSlot.set('workspace', {
                version: memberVersion,
                integrity: 'workspace:',
                treeRef: member.treeRef,
                isWorkspace: true,
              });
              enqueueAll(frontier, memberPkg, name);
            }
            // Diagnostic when the workspace member's version does not
            // satisfy the importer's range; we still resolve to the
            // workspace member, but the unmet predicate is recorded
            // on the resolution's diagnostic channel.
            if (!satisfiesRange(memberVersion, range)) {
              unmetOptionals.push({
                importer,
                name,
                range,
                reason: `workspace member version ${memberVersion} does not satisfy ${range}`,
              });
            }
            if (source === 'peerDependencies') {
              peerRequirements.push({ importer, name, range });
            }
            resolved.set(name, wsSlot);
            return;
          }
        }

        const majorKey = parseRangeMajor(range);
        const slot = resolved.get(name) ?? new Map();
        const existing = slot.get(majorKey);

        let document;
        try {
          document = await loadPackument(packumentCache, name);
        } catch (err) {
          if (source === 'optionalDependencies') {
            unmetOptionals.push({
              importer,
              name,
              range,
              reason: /** @type {Error} */ (err).message,
            });
            return;
          }
          if (source === 'peerDependencies') {
            // Defer the failure: the peer-requirement check at the end
            // raises `RegistryMissingPackageError` with a fully-formed
            // message describing the unmet peer. Logging the upstream
            // load failure here would lose the "unmet peer" framing.
            peerRequirements.push({ importer, name, range });
            return;
          }
          throw err;
        }

        let candidateVersion;
        try {
          candidateVersion = selectGreatestSatisfying(document, name, range);
        } catch (err) {
          if (source === 'optionalDependencies') {
            unmetOptionals.push({
              importer,
              name,
              range,
              reason: /** @type {Error} */ (err).message,
            });
            return;
          }
          throw err;
        }

        if (
          existing &&
          compareVersions(
            parseVersion(existing.version),
            parseVersion(candidateVersion),
          ) >= 0
        ) {
          if (source === 'peerDependencies') {
            peerRequirements.push({ importer, name, range });
          }
          return;
        }

        // Fetch the tarball, write to CAS, mint a treeRef.
        if (offline) {
          // In offline mode, only accept entries already present in the
          // caller-supplied package cache.
          const cached = await context.packages.get(name, candidateVersion);
          if (cached === undefined) {
            throw RegistryOfflineError(
              `offline: no cached entry for ${name}@${candidateVersion}`,
            );
          }
          slot.set(majorKey, {
            version: candidateVersion,
            integrity: cached.integrity,
            treeRef: cached.treeRef,
          });
          resolved.set(name, slot);
          const childPj = '{}';
          enqueueAll(frontier, decodePackageJson(childPj), name);
          if (source === 'peerDependencies') {
            peerRequirements.push({ importer, name, range });
          }
          return;
        }

        let tarballBytes;
        try {
          tarballBytes = await fetcher.getTarball(name, candidateVersion);
        } catch (err) {
          if (source === 'optionalDependencies') {
            unmetOptionals.push({
              importer,
              name,
              range,
              reason: `tarball fetch failed: ${/** @type {Error} */ (err).message}`,
            });
            return;
          }
          throw RegistryNetworkError(
            `failed to fetch tarball for ${name}@${candidateVersion}: ${/** @type {Error} */ (err).message}`,
          );
        }
        const hash = await context.cas.write(tarballBytes);
        const treeRef = await makeTreeRef(hash, name, candidateVersion);
        context.retentionLinks.pin(hash);

        const integrity =
          document.versions[candidateVersion]?.dist?.integrity || '';
        slot.set(majorKey, {
          version: candidateVersion,
          integrity,
          treeRef,
        });
        resolved.set(name, slot);

        if (source === 'peerDependencies') {
          peerRequirements.push({ importer, name, range });
        }

        // Continue the walk by enqueueing the child's declared deps.
        // The metadata document carries the child's dependency tables
        // alongside its dist info, so we walk without a second fetch.
        const childMeta = document.versions[candidateVersion] || {};
        enqueueAll(
          frontier,
          /** @type {Record<string, unknown>} */ (childMeta),
          name,
        );
      };

      while (frontier.length > 0) {
        const edge =
          /** @type {{ name: string, range: string, source: string, importer: string }} */ (
            frontier.shift()
          );
        // eslint-disable-next-line no-await-in-loop
        await processEdge(edge);
      }

      // Peer-requirement check.
      for (const peer of peerRequirements) {
        const slot = resolved.get(peer.name);
        if (slot === undefined) {
          throw RegistryMissingPackageError(
            `${peer.importer} declares unmet peer dependency ${peer.name}@${peer.range}`,
          );
        }
        const satisfied = [...slot.values()].some(candidate =>
          satisfiesRange(candidate.version, peer.range),
        );
        if (!satisfied) {
          throw RegistryMissingPackageError(
            `${peer.importer} declares peer dependency ${peer.name}@${peer.range} but resolved closure has no satisfying version`,
          );
        }
      }

      // Flatten the (name, major-slot) -> selection map into the
      // canonical packagesByKey shape.
      /** @type {Record<string, RegistryResolutionEntry>} */
      const packagesByKey = {};
      for (const [name, slot] of resolved) {
        for (const selection of slot.values()) {
          // Workspace members keep the bare name as their key, no
          // version segment. Per the Synthesized layout section of
          // snapshot-mapper.md, this is the encoding the mapper
          // relies on to distinguish workspace members from
          // registry-resolved entries.
          const key = selection.isWorkspace
            ? name
            : composeKey(name, selection.version);
          packagesByKey[key] = {
            name,
            version: selection.version,
            treeRef: selection.treeRef,
            integrity: selection.integrity,
          };
        }
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

      /** @type {RegistryResolution & { unmetOptionals?: unknown }} */
      const resolution = harden({
        packagesByKey: harden(packagesByKey),
        keys: harden(keys),
        resolutionHash: resolutionHashBytes,
        unmetOptionals: harden(unmetOptionals),
      });
      return resolution;
    }
  );
};
harden(makeMvsResolveHook);
