// @ts-check
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeFunctor } from '@endo/compartment-mapper/functor.js';
import harden from '@endo/harden';

/**
 * Bundle a local module for installation. The host supplies its
 * compartment-mapper read powers and path/hash helpers; callers get only
 * bundle text.
 *
 * `bundle` makes a script for a guest: evaluating it yields the module's
 * namespace, with every import frozen in. `bundleNative` makes a CommonJS
 * module for a native process: `require` of the stored text yields the
 * namespace, with the module's own imports frozen in the same way, except
 * that Node builtins (`node:http`, say) are exits the process resolves with
 * its own `require`. A builtin is imported by name or as a namespace; a
 * default import of one has no binding in the bundle.
 *
 * @typedef {object} BundlerPowers
 * @property {(file: string) => Promise<{ bundle: string, digest: string }>} bundle
 * @property {(file: string) => Promise<string>} bundleNative
 *
 * @param {object} host
 * @param {object} host.readPowers compartment-mapper read powers
 * @param {(path: string) => string} host.pathToFileURL
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
      const bundle = await makeBundle(readPowers, pathToFileURL(resolve(file)));
      return harden({
        bundle,
        digest: sha256Hex(new TextEncoder().encode(bundle)),
      });
    },
    bundleNative: async file => {
      const functor = await makeFunctor(
        readPowers,
        pathToFileURL(resolve(file)),
        { format: 'cjs' },
      );
      // The functor takes its runtime options when applied; the process's
      // `require` is the one it needs, for the exits.
      return `module.exports = (${functor})({ require });\n`;
    },
  });
harden(makeBundlerPowers);
