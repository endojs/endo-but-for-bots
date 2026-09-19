// @ts-check
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import harden from '@endo/harden';

/**
 * Bundle a local module for installation into a guest. The host supplies
 * its compartment-mapper read powers and path/hash helpers; callers get
 * only the bundle text and its digest.
 *
 * @typedef {object} BundlerPowers
 * @property {(file: string) => Promise<{ bundle: string, digest: string }>} bundle
 *
 * @param {object} host
 * @param {object} host.readPowers compartment-mapper read powers
 * @param {(path: string) => URL} host.pathToFileURL
 * @param {(...parts: string[]) => string} host.resolve
 * @param {(bytes: Uint8Array) => string} host.sha256Hex
 * @returns {BundlerPowers}
 */
export const makeBundlerPowers = ({
  readPowers,
  pathToFileURL,
  resolve,
  sha256Hex,
}) =>
  harden({
    bundle: async file => {
      const bundle = await makeBundle(
        readPowers,
        pathToFileURL(resolve(file)).href,
      );
      return harden({
        bundle,
        digest: sha256Hex(new TextEncoder().encode(bundle)),
      });
    },
  });
harden(makeBundlerPowers);
