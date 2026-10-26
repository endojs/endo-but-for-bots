// @ts-check

/**
 * Compartment-mapper `ReadPowers` over a `package.json`-rooted source tree
 * and an eager `RegistryResolution`, for the worker's `makeFromPackage`.
 *
 * The powers present a synthetic file system so that compartment-mapper's
 * own package-graph walk (`importLocation` → `mapNodeModules`) runs
 * unchanged:
 *
 * - `file:///entry/` is the source tree.
 * - `file:///packages/<name>@<version>/` is the resolved package's CAS tree.
 * - `<package root>/node_modules/<name>/` exists only for a name that the
 *   package at that root declares, and `canonical` maps it to the
 *   `file:///packages/...` location of the resolution entry that satisfies
 *   the declared range.  Each package therefore links against the major it
 *   asked for, and several majors of one package can coexist.
 *
 * Nothing else is readable: a real `node_modules` directory inside a tree
 * is shadowed, an undeclared dependency is absent, and a location outside
 * both roots is absent.
 *
 * @import { ReadPowers } from '@endo/compartment-mapper'
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { mapNodeModules } from '@endo/compartment-mapper/node-modules.js';
import { importFromMap } from '@endo/compartment-mapper/import-lite.js';
import { defaultParserForLanguage } from '@endo/compartment-mapper/import-parsers.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { compareVersions, parseVersion, satisfies } from './registry.js';

const entryRoot = 'file:///entry/';
const packagesRoot = 'file:///packages/';

/**
 * @typedef {object} PackageResolution
 * @property {Record<string, { name: string, version: string, treeRef: unknown }>} packagesByKey
 * @property {string[]} keys
 */

/**
 * Number of path segments a package name occupies: two for a scoped name
 * (`@scope/name`), one otherwise.
 *
 * @param {string} firstSegment
 */
const nameSegmentCount = firstSegment => (firstSegment.startsWith('@') ? 2 : 1);

/**
 * @param {string} segment
 * @returns {string | undefined}
 */
const decodeSegment = segment => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * @param {AsyncIterable<Uint8Array>} chunks
 */
const concatenateChunks = async chunks => {
  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

/**
 * @param {object} options
 * @param {unknown} options.entryTree - ReadableTree or Mount whose root holds
 *   the entry `package.json`.
 * @param {PackageResolution} options.resolution
 * @param {string} [options.entry] - Module path relative to the entry
 *   package root.  When omitted, compartment-mapper resolves the package's
 *   own entry (`exports`, then `main`, then `index.js`).
 * @returns {{ readPowers: ReadPowers, entryLocation: string }}
 */
export const makePackageReadPowers = ({ entryTree, resolution, entry }) => {
  const { packagesByKey } = resolution;

  /** @type {Map<string, string[]>} */
  const keysByName = new Map();
  for (const key of resolution.keys) {
    const { name } = packagesByKey[key];
    const keys = keysByName.get(name);
    if (keys === undefined) {
      keysByName.set(name, [key]);
    } else {
      keys.push(key);
    }
  }

  /** @param {string | undefined} packageKey - `undefined` for the entry. */
  const treeFor = packageKey =>
    packageKey === undefined ? entryTree : packagesByKey[packageKey].treeRef;

  /**
   * @param {unknown} tree
   * @param {string[]} segments
   */
  const readTreeBytes = async (tree, segments) => {
    const blob = await E(/** @type {any} */ (tree)).lookup(harden(segments));
    return concatenateChunks(iterateBytesReader(/** @type {any} */ (blob)));
  };

  /** @type {Map<string | undefined, Promise<Record<string, unknown>>>} */
  const declaredRangesMemo = new Map();

  /**
   * The dependency ranges a package declares.  `peerDependencies` are
   * included because a peer must be linkable from the package that names
   * it; `devDependencies` are not.
   *
   * @param {string | undefined} packageKey
   */
  const declaredRanges = packageKey => {
    let ranges = declaredRangesMemo.get(packageKey);
    if (ranges === undefined) {
      ranges = readTreeBytes(treeFor(packageKey), ['package.json']).then(
        bytes => {
          const descriptor = JSON.parse(decodeUtf8(bytes));
          return harden({
            ...descriptor.peerDependencies,
            ...descriptor.optionalDependencies,
            ...descriptor.dependencies,
          });
        },
      );
      declaredRangesMemo.set(packageKey, ranges);
    }
    return ranges;
  };

  /**
   * The resolution key a package links for `name`: the greatest resolved
   * version that satisfies the range the package declares.
   *
   * @param {string | undefined} packageKey
   * @param {string} name
   */
  const selectDependency = async (packageKey, name) => {
    const ranges = await declaredRanges(packageKey);
    const range = ranges[name];
    if (typeof range !== 'string') {
      return undefined;
    }
    let selectedKey;
    let selectedVersion;
    for (const key of keysByName.get(name) ?? []) {
      const version = parseVersion(packagesByKey[key].version);
      if (
        version !== undefined &&
        satisfies(packagesByKey[key].version, range) &&
        (selectedVersion === undefined ||
          compareVersions(version, selectedVersion) > 0)
      ) {
        selectedKey = key;
        selectedVersion = version;
      }
    }
    return selectedKey;
  };

  /**
   * Map a location to the package that holds it and the raw path segments
   * within that package, following `node_modules/<name>` links.
   *
   * @param {string} location
   * @returns {Promise<{ packageKey: string | undefined, segments: string[] } | undefined>}
   */
  const locate = async location => {
    await null;
    /** @type {string | undefined} */
    let packageKey;
    /** @type {string[]} */
    let segments;
    if (location.startsWith(entryRoot)) {
      segments = location.slice(entryRoot.length).split('/');
    } else if (location.startsWith(packagesRoot)) {
      const rest = location.slice(packagesRoot.length).split('/');
      const count = nameSegmentCount(rest[0]);
      const key = decodeSegment(rest.slice(0, count).join('/'));
      if (key === undefined || !Object.hasOwn(packagesByKey, key)) {
        return undefined;
      }
      packageKey = key;
      segments = rest.slice(count);
    } else {
      return undefined;
    }

    while (segments.length >= 2 && segments[0] === 'node_modules') {
      const count = nameSegmentCount(segments[1]);
      const name = decodeSegment(segments.slice(1, 1 + count).join('/'));
      if (segments.length < 1 + count || name === undefined) {
        return undefined;
      }
      // eslint-disable-next-line no-await-in-loop
      const selectedKey = await selectDependency(packageKey, name);
      if (selectedKey === undefined) {
        return undefined;
      }
      packageKey = selectedKey;
      segments = segments.slice(1 + count);
    }
    return { packageKey, segments };
  };

  /**
   * @param {string} location
   * @returns {Promise<{ tree: unknown, segments: string[] } | undefined>}
   */
  const locateFile = async location => {
    const located = await locate(location);
    if (located === undefined) {
      return undefined;
    }
    const segments = located.segments.map(decodeSegment);
    if (segments.some(segment => segment === undefined || segment === '')) {
      return undefined;
    }
    return {
      tree: treeFor(located.packageKey),
      segments: /** @type {string[]} */ (segments),
    };
  };

  /** @param {string} location */
  const read = async location => {
    const file = await locateFile(location);
    if (file === undefined) {
      throw Error(`Cannot read ${location}: no such package file`);
    }
    return readTreeBytes(file.tree, file.segments);
  };

  /** @param {string} location */
  const maybeRead = async location => {
    const file = await locateFile(location);
    if (file === undefined) {
      return undefined;
    }
    const { tree, segments } = file;
    if (!(await E(/** @type {any} */ (tree)).has(...segments))) {
      return undefined;
    }
    try {
      return await readTreeBytes(tree, segments);
    } catch (error) {
      // A directory is present but has no bytes; compartment-mapper probes
      // `lib` before `lib.js` and `lib/index.js`.
      const isDirectory = await E(/** @type {any} */ (tree))
        .list(...segments)
        .then(
          () => true,
          () => false,
        );
      if (isDirectory) {
        return undefined;
      }
      throw error;
    }
  };

  /** @param {string} location */
  const canonical = async location => {
    const located = await locate(location);
    if (located === undefined) {
      return location;
    }
    const root =
      located.packageKey === undefined
        ? entryRoot
        : `${packagesRoot}${located.packageKey}/`;
    return `${root}${located.segments.join('/')}`;
  };

  const entryLocation = new URL(entry ?? '', entryRoot).href;
  if (!entryLocation.startsWith(entryRoot)) {
    throw Error(`Entry ${entry} is outside the package root`);
  }

  return harden({
    readPowers: { read, maybeRead, canonical },
    entryLocation,
  });
};
harden(makePackageReadPowers);

/**
 * Import a `package.json`-rooted source tree against an eager resolution.
 *
 * Without `entry`, the package's own entry module (its `exports` or
 * `main`, as compartment-mapper infers them) is imported.
 *
 * @param {object} options
 * @param {unknown} options.entryTree
 * @param {PackageResolution} options.resolution
 * @param {string} [options.entry]
 * @param {object} options.globals
 */
export const importPackage = async ({
  entryTree,
  resolution,
  entry,
  globals,
}) => {
  const { readPowers, entryLocation } = makePackageReadPowers({
    entryTree,
    resolution,
    entry,
  });
  let compartmentMap = await mapNodeModules(readPowers, entryLocation);
  if (entry === undefined) {
    // compartment-mapper names a package root's own entry `.` but cannot
    // link `.` as a module; the root compartment reaches the same module
    // under its package name.
    const root = compartmentMap.compartments[compartmentMap.entry.compartment];
    const packageEntry = root.modules[root.name];
    if (packageEntry === undefined || !('module' in packageEntry)) {
      throw Error(
        `Package ${root.name} has no entry module; give it "exports" or "main", or pass an entry`,
      );
    }
    compartmentMap = {
      ...compartmentMap,
      entry: {
        compartment: /** @type {any} */ (packageEntry).compartment,
        module: /** @type {any} */ (packageEntry).module,
      },
    };
  }
  const { namespace } = await importFromMap(readPowers, compartmentMap, {
    globals,
    parserForLanguage: defaultParserForLanguage,
  });
  return namespace;
};
harden(importPackage);
