// @ts-check
/** @import { NodePowers } from '../platform/node-powers.js' */
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import harden from '@endo/harden';

/**
 * Read and bundle locally; application code executes only in the guest.
 * @param {NodePowers} powers
 * @param {string} file
 */
export const bundleApplication = async (powers, file) => {
  const { readPowers, crypto, path, url } = powers;
  const bundle = await makeBundle(
    readPowers,
    url.pathToFileURL(path.resolve(file)).href,
  );
  return harden({
    bundle,
    digest: crypto.createHash('sha256').update(bundle).digest('hex'),
  });
};
harden(bundleApplication);
