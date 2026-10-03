// @ts-check

/** @import { CaptureResult, FileUrlString, PackageCompartmentMapDescriptor, ReadPowers } from '@endo/compartment-mapper' */
/** @import { ERef } from '@endo/eventual-send' */
/** @import { ReadableTree } from '@endo/platform/fs/lite/types' */
/** @import { TreeLayout } from './types.js' */

import { makeArchiveFromMap } from '@endo/compartment-mapper/archive-lite.js';
import { captureFromMap } from '@endo/compartment-mapper/capture-lite.js';
import { defaultParserForLanguage } from '@endo/compartment-mapper/import-parsers.js';
import { mapNodeModules } from '@endo/compartment-mapper/node-modules.js';
import { makeError, q, X } from '@endo/errors';
import harden from '@endo/harden';
import { makeTreeReadPowers } from '@endo/platform/fs/lite';
import { decodeUtf8 } from '@endo/utf8/decode.js';

import { makeMountCanonical } from './mount.js';

const defaultRoot = 'file:///app/';

/**
 * @typedef {Extract<TreeLayout, 'node-modules-with-map' | 'node-modules-scan'>} NodeModulesLayout
 */

/**
 * @typedef {object} CaptureNodeModulesOptions
 * @property {NodeModulesLayout} layout
 * @property {string} [entry]
 * @property {string} [root] A directory URL; a missing trailing slash is
 *   supplied, so a sibling such as `file:///app-other/` is never under
 *   `file:///app`.
 */

/**
 * Assert that every package location named by a pre-generated map remains
 * inside the synthetic tree root.
 *
 * @param {unknown} allegedCompartmentMap
 * @param {string} root
 * @param {string} mapLocation
 * @returns {asserts allegedCompartmentMap is PackageCompartmentMapDescriptor}
 */
const assertMapLocationsUnderRoot = (
  allegedCompartmentMap,
  root,
  mapLocation,
) => {
  if (
    allegedCompartmentMap === null ||
    typeof allegedCompartmentMap !== 'object' ||
    !('compartments' in allegedCompartmentMap) ||
    allegedCompartmentMap.compartments === null ||
    typeof allegedCompartmentMap.compartments !== 'object'
  ) {
    throw makeError(
      X`Compartment map ${q(mapLocation)} is missing its compartments map`,
    );
  }

  for (const [compartmentName, allegedDescriptor] of Object.entries(
    allegedCompartmentMap.compartments,
  )) {
    if (
      allegedDescriptor === null ||
      typeof allegedDescriptor !== 'object' ||
      !('location' in allegedDescriptor) ||
      typeof allegedDescriptor.location !== 'string'
    ) {
      throw makeError(
        X`Compartment ${q(compartmentName)} in ${q(mapLocation)} is missing its location`,
      );
    }

    let location;
    try {
      location = new URL(allegedDescriptor.location).href;
    } catch {
      throw makeError(
        X`Compartment ${q(compartmentName)} in ${q(mapLocation)} has invalid location ${q(allegedDescriptor.location)}`,
      );
    }
    if (!location.startsWith(root)) {
      throw makeError(
        X`Compartment ${q(compartmentName)} location ${q(location)} is not under tree root ${q(root)}`,
      );
    }
  }
};

/**
 * Map a Node-style package graph in a `ReadableTree` or `Mount`.
 *
 * `node-modules-with-map` reads a package compartment map from the tree root;
 * its compartment locations continue to name the original package directories
 * under the synthetic root. `node-modules-scan` maps the root package (or an
 * explicit module path within it) through the ordinary Node `node_modules`
 * algorithm before capturing. Both layouts retain original source bytes.
 * When `tree` is a daemon-minted mount, package directories are
 * canonicalized through the mount's physical paths (`makeMountCanonical`).
 *
 * @param {ERef<ReadableTree>} tree
 * @param {CaptureNodeModulesOptions} options
 * @returns {Promise<{ readPowers: ReadPowers, compartmentMap: PackageCompartmentMapDescriptor }>}
 */
const mapTree = async (tree, options) => {
  await null;
  const { layout, entry, root: allegedRoot = defaultRoot } = options;
  // Every containment check below is a prefix match, so the root must end
  // in a separator.
  const root = allegedRoot.endsWith('/') ? allegedRoot : `${allegedRoot}/`;
  // A mount the daemon backs canonicalizes package directories through its
  // physical paths, so a package reached through more than one
  // `node_modules` path loads as one compartment.  Any other tree (a
  // snapshot stores no links) keeps the identity.
  const canonical = makeMountCanonical(await tree);
  /** @type {ReadPowers} */
  const readPowers = /** @type {any} */ (
    makeTreeReadPowers(tree, { root, canonical })
  );

  /** @type {PackageCompartmentMapDescriptor} */
  let compartmentMap;
  if (layout === 'node-modules-with-map') {
    const mapLocation = new URL('compartment-map.json', root).href;
    const mapBytes = await readPowers.read(mapLocation);
    let allegedCompartmentMap;
    try {
      allegedCompartmentMap = JSON.parse(decodeUtf8(mapBytes));
    } catch (error) {
      throw makeError(
        X`Cannot parse compartment map ${q(mapLocation)}: ${q(error)}`,
      );
    }
    assertMapLocationsUnderRoot(allegedCompartmentMap, root, mapLocation);
    compartmentMap = allegedCompartmentMap;
  } else if (layout === 'node-modules-scan') {
    const moduleLocation =
      entry === undefined ? root : new URL(entry, root).href;
    if (!moduleLocation.startsWith(root)) {
      throw makeError(
        X`Entry location ${q(moduleLocation)} is not under tree root ${q(root)}`,
      );
    }
    compartmentMap = await mapNodeModules(readPowers, moduleLocation);
    if (entry === undefined) {
      const rootDescriptor =
        compartmentMap.compartments[
          /** @type {FileUrlString} */ (compartmentMap.entry.compartment)
        ];
      const rootExport = rootDescriptor.modules[rootDescriptor.name];
      if (
        rootExport === undefined ||
        !('compartment' in rootExport) ||
        typeof rootExport.compartment !== 'string' ||
        typeof rootExport.module !== 'string'
      ) {
        throw makeError(
          X`Root package at ${q(root)} does not resolve its "." export`,
        );
      }
      compartmentMap = {
        ...compartmentMap,
        entry: {
          compartment: /** @type {FileUrlString} */ (rootExport.compartment),
          module: rootExport.module,
        },
      };
    }
  } else {
    throw makeError(X`Unsupported node_modules layout ${q(layout)}`);
  }

  return { readPowers, compartmentMap };
};

/**
 * Capture a Node-style package graph from a `ReadableTree` or `Mount`
 * (see `mapTree` for the layouts).
 *
 * @param {ERef<ReadableTree>} tree
 * @param {CaptureNodeModulesOptions} options
 * @returns {Promise<CaptureResult>}
 */
export const captureNodeModules = async (tree, options) => {
  const { readPowers, compartmentMap } = await mapTree(tree, options);
  return captureFromMap(readPowers, compartmentMap, {
    parserForLanguage: defaultParserForLanguage,
  });
};
harden(captureNodeModules);

/**
 * Capture a Node-style package graph from a `ReadableTree` or `Mount` into
 * source-only compartment-mapper archive bytes, which a worker's
 * `makeArchive` method runs.  A module the map names but the tree cannot
 * read fails the capture.
 *
 * @param {ERef<ReadableTree>} tree
 * @param {CaptureNodeModulesOptions} options
 * @returns {Promise<Uint8Array>}
 */
export const captureNodeModulesArchive = async (tree, options) => {
  const { readPowers, compartmentMap } = await mapTree(tree, options);
  // The import-side parsers keep original source; the archive-side parsers
  // precompile to `pre-*-json` formats, which the XS archive loader skips.
  return makeArchiveFromMap(readPowers, compartmentMap, {
    parserForLanguage: defaultParserForLanguage,
  });
};
harden(captureNodeModulesArchive);
