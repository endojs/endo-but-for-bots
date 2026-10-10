/* eslint no-shadow: 0 */

/**
 * @import {
 *   BundleOptions,
 *   MaybeReadPowers,
 *   ReadFn,
 *   ReadPowers,
 *   WriteFn,
 * } from './types.js'
 */

import { mapNodeModules } from './node-modules.js';
import { makeScriptFromMap, makeFunctorFromMap } from './bundle-lite.js';

const textEncoder = new TextEncoder();

/**
 * @param {ReadFn | ReadPowers | MaybeReadPowers} readPowers
 * @param {string} moduleLocation
 * @param {BundleOptions} [options]
 * @returns {Promise<string>}
 */
export const makeFunctor = async (readPowers, moduleLocation, options) => {
  const compartmentMap = await mapNodeModules(
    readPowers,
    moduleLocation,
    options,
  );
  return makeFunctorFromMap(readPowers, compartmentMap, options);
};

/**
 * @param {ReadFn | ReadPowers | MaybeReadPowers} readPowers
 * @param {string} moduleLocation
 * @param {BundleOptions} [options]
 * @returns {Promise<string>}
 */
export const makeScript = async (readPowers, moduleLocation, options) => {
  const compartmentMap = await mapNodeModules(
    readPowers,
    moduleLocation,
    options,
  );
  return makeScriptFromMap(readPowers, compartmentMap, options);
};

/**
 * @param {WriteFn} write
 * @param {ReadFn} read
 * @param {string} bundleLocation
 * @param {string} moduleLocation
 * @param {BundleOptions} [options]
 */
export const writeScript = async (
  write,
  read,
  bundleLocation,
  moduleLocation,
  options,
) => {
  const bundleString = await makeScript(read, moduleLocation, options);
  const bundleBytes = textEncoder.encode(bundleString);
  await write(bundleLocation, bundleBytes);
};
