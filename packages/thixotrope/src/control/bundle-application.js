// @ts-check
import harden from '@endo/harden';

/** @import { BundlerPowers } from '../platform/bundler.js' */

/**
 * Read and bundle locally; application code executes only in the guest.
 * @param {BundlerPowers} bundler
 * @param {string} file
 */
export const bundleApplication = async (bundler, file) =>
  bundler.bundle(file);
harden(bundleApplication);
