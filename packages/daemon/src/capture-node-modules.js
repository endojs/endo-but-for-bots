// @ts-check

/** @import { CaptureResult, FileUrlString, PackageCompartmentMapDescriptor, ReadPowers } from '@endo/compartment-mapper' */
/** @import { ERef } from '@endo/eventual-send' */
/** @import { ReadableTree } from '@endo/platform/fs/lite/types' */

import { captureFromMap } from '@endo/compartment-mapper/capture-lite.js';
import { defaultParserForLanguage } from '@endo/compartment-mapper/import-parsers.js';
import { mapNodeModules } from '@endo/compartment-mapper/node-modules.js';
import { makeError, q, X } from '@endo/errors';
import harden from '@endo/harden';
import { makeTreeReadPowers } from '@endo/platform/fs/lite';
import { decodeUtf8 } from '@endo/utf8/decode.js';

const defaultRoot = 'file:///app/';

/**
 * @typedef {'node-modules-with-map' | 'node-modules-scan'} NodeModulesLayout
 */

/**
 * @typedef {object} CaptureNodeModulesOptions
 * @property {NodeModulesLayout} layout
 * @property {string} [entry]
 * @property {string} [root]
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
 * Capture a Node-style package graph from a `ReadableTree` or `Mount`.
 *
 * `node-modules-with-map` reads a package compartment map from the tree root;
 * its compartment locations continue to name the original package directories
 * under the synthetic root. `node-modules-scan` maps the root package (or an
 * explicit module path within it) through the ordinary Node `node_modules`
 * algorithm before capturing. Both layouts retain original source bytes.
 *
 * @param {ERef<ReadableTree>} tree
 * @param {CaptureNodeModulesOptions} options
 * @returns {Promise<CaptureResult>}
 */
export const captureNodeModules = async (tree, options) => {
  await null;
  const { layout, entry, root = defaultRoot } = options;
  /** @type {ReadPowers} */
  const readPowers = /** @type {any} */ (makeTreeReadPowers(tree, { root }));

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

  return captureFromMap(readPowers, compartmentMap, {
    parserForLanguage: defaultParserForLanguage,
  });
};
harden(captureNodeModules);
