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
 * Read a file at the root of a tree as text, or `undefined` when the tree
 * cannot read it.  Only `lookup` and `text` are used, the surface every
 * tree `makeFromTree` accepts shares.
 *
 * @param {ERef<any>} tree
 * @param {string} name
 * @returns {Promise<string | undefined>}
 */
const maybeReadRootText = async (tree, name) => {
  await null;
  try {
    const blob = await E(tree).lookup(name);
    return await E(blob).text();
  } catch {
    return undefined;
  }
};

/**
 * Whether a tree can look up an entry at its root.
 *
 * @param {ERef<any>} tree
 * @param {string} name
 */
const rootEntryExists = async (tree, name) => {
  await null;
  try {
    await E(tree).lookup(name);
    return true;
  } catch {
    return false;
  }
};

/**
 * Detect how a `ReadableTree` or `Mount` is laid out, reading only its root.
 * A Yarn Plug'n'Play install, or a tree matching no layout, is rejected.
 *
 * @param {ERef<any>} tree
 * @returns {Promise<Exclude<TreeLayout, 'package'>>}
 */
export const detectTreeLayout = async tree => {
  const mapText = await maybeReadRootText(tree, 'compartment-map.json');
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
  if ((await maybeReadRootText(tree, 'package.json')) !== undefined) {
    const plugAndPlay =
      (await rootEntryExists(tree, '.pnp.cjs')) ||
      (await rootEntryExists(tree, '.pnp.js'));
    if (plugAndPlay && !(await rootEntryExists(tree, 'node_modules'))) {
      throw makeError(
        `Tree matches no makeFromTree layout: it is a Yarn Plug'n'Play install with no node_modules; ${lookedFor}`,
      );
    }
    return 'node-modules-scan';
  }
  throw makeError(`Tree matches no makeFromTree layout: ${lookedFor}`);
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
