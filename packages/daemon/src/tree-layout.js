// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { RequestedTreeLayout, TreeLayout } from './types.js' */

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import harden from '@endo/harden';

/**
 * Every value `makeFromTree` accepts for `layout`; the host interface guard
 * derives its pattern from this list.
 *
 * @type {readonly RequestedTreeLayout[]}
 */
export const requestedTreeLayouts = harden([
  'detect',
  'archive',
  'node-modules-with-map',
  'node-modules-scan',
  'package',
]);

/**
 * Name the kind of tree a `make-from-tree` formula holds, from the tree's
 * formula type: a `snapshot` replays the same bytes at every incarnation,
 * and a `mount` re-reads its place.  Any other formula type is reported as
 * itself.
 *
 * @param {string | undefined} treeFormulaType
 * @returns {string | undefined}
 */
export const treeKindForFormulaType = treeFormulaType => {
  if (treeFormulaType === 'readable-tree') {
    return 'snapshot';
  }
  if (treeFormulaType === 'mount' || treeFormulaType === 'scratch-mount') {
    return 'mount';
  }
  return treeFormulaType;
};
harden(treeKindForFormulaType);

/**
 * Whether every compartment location in a parsed compartment map is a
 * `file:` URL, which marks a map over packages in situ
 * (`node-modules-with-map`) rather than over archive paths (`archive`).
 *
 * @param {unknown} compartmentMap
 */
const namesFileLocations = compartmentMap => {
  if (
    compartmentMap === null ||
    typeof compartmentMap !== 'object' ||
    !('compartments' in compartmentMap) ||
    compartmentMap.compartments === null ||
    typeof compartmentMap.compartments !== 'object'
  ) {
    return false;
  }
  const descriptors = Object.values(compartmentMap.compartments);
  return (
    descriptors.length > 0 &&
    descriptors.every(
      descriptor =>
        descriptor !== null &&
        typeof descriptor === 'object' &&
        'location' in descriptor &&
        typeof descriptor.location === 'string' &&
        descriptor.location.startsWith('file:'),
    )
  );
};

/**
 * Look up an entry at the root of a tree, or `undefined` when the lookup
 * fails.  Only `lookup` is called: some trees `makeFromTree` accepts offer no
 * `has`, and trees report a missing name with differing errors, so a failed
 * lookup reads as absent.  The failure is kept in `misses` so a tree that
 * matches no layout reports why.
 *
 * @param {ERef<any>} tree
 * @param {string} name
 * @param {unknown[]} misses
 */
const maybeLookupRoot = async (tree, name, misses) => {
  await null;
  try {
    return await E(tree).lookup(name);
  } catch (error) {
    misses.push(error);
    return undefined;
  }
};

/**
 * Read a file at the root of a tree as text, or `undefined` when its lookup
 * fails.  A failure to read an entry that exists, such as a directory with
 * the file's name, propagates.
 *
 * @param {ERef<any>} tree
 * @param {string} name
 * @param {unknown[]} misses
 * @returns {Promise<string | undefined>}
 */
const maybeReadRootText = async (tree, name, misses) => {
  const blob = await maybeLookupRoot(tree, name, misses);
  if (blob === undefined) {
    return undefined;
  }
  return E(blob).text();
};

/**
 * Detect how a `ReadableTree` or `Mount` is laid out, reading only its root.
 * A Yarn Plug'n'Play install, or a tree matching no layout, is rejected.
 *
 * @param {ERef<any>} tree
 * @returns {Promise<Exclude<TreeLayout, 'package'>>}
 */
export const detectTreeLayout = async tree => {
  /** @type {unknown[]} */
  const misses = [];
  const mapText = await maybeReadRootText(tree, 'compartment-map.json', misses);
  if (mapText !== undefined) {
    let compartmentMap;
    try {
      compartmentMap = JSON.parse(mapText);
    } catch (error) {
      throw makeError(
        X`Tree's compartment-map.json is not valid JSON: ${q(error)}`,
      );
    }
    return namesFileLocations(compartmentMap)
      ? 'node-modules-with-map'
      : 'archive';
  }
  const lookedFor =
    'found neither compartment-map.json (layouts "archive", "node-modules-with-map") nor package.json (layout "node-modules-scan") at its root';
  if ((await maybeReadRootText(tree, 'package.json', misses)) !== undefined) {
    const plugAndPlay =
      (await maybeLookupRoot(tree, '.pnp.cjs', [])) !== undefined ||
      (await maybeLookupRoot(tree, '.pnp.js', [])) !== undefined;
    if (
      plugAndPlay &&
      (await maybeLookupRoot(tree, 'node_modules', [])) === undefined
    ) {
      throw makeError(
        `Tree matches no makeFromTree layout: it is a Yarn Plug'n'Play install with no node_modules; ${lookedFor}`,
      );
    }
    return 'node-modules-scan';
  }
  const failures = misses
    .map(error => String(/** @type {any} */ (error)?.message ?? error))
    .join('; ');
  throw makeError(
    `Tree matches no makeFromTree layout: ${lookedFor}; its lookups failed: ${failures}`,
    undefined,
    { cause: /** @type {Error | undefined} */ (misses[0]) },
  );
};
harden(detectTreeLayout);

/**
 * Resolve the layout one incarnation runs a tree as: the requested layout,
 * or the detected one when the formula requested `'detect'`.
 *
 * @param {ERef<any>} tree
 * @param {RequestedTreeLayout} requested
 * @returns {Promise<Exclude<TreeLayout, 'package'>>}
 */
export const resolveTreeLayout = async (tree, requested) => {
  if (requested === 'detect') {
    return detectTreeLayout(tree);
  }
  if (requested === 'package') {
    throw makeError(
      X`makeFromTree layout "package" requires makeFromPackage, which is not built yet`,
    );
  }
  if (
    requested !== 'archive' &&
    requested !== 'node-modules-with-map' &&
    requested !== 'node-modules-scan'
  ) {
    throw makeError(X`Unknown makeFromTree layout ${q(requested)}`);
  }
  return requested;
};
harden(resolveTreeLayout);

/**
 * Assert that a `makeFromTree` `entry` applies to the layout a tree runs as.
 * Only `node-modules-scan` takes an entry, and an empty entry names no
 * module: omit `entry` to run the root package's `"."` export.
 *
 * @param {string | undefined} entry
 * @param {Exclude<TreeLayout, 'package'>} runningAs
 */
export const assertEntryAppliesToLayout = (entry, runningAs) => {
  if (entry === undefined) {
    return;
  }
  if (runningAs !== 'node-modules-scan') {
    throw makeError(
      X`makeFromTree entry ${q(entry)} applies only to the "node-modules-scan" layout, but the tree runs as ${q(runningAs)}`,
    );
  }
  if (entry === '') {
    throw makeError(
      X`makeFromTree entry must name a module; omit entry to run the root package's "." export`,
    );
  }
};
harden(assertEntryAppliesToLayout);
