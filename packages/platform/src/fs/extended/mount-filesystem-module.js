// @ts-check
/**
 * Daemon caplet entry point that projects a named Mount capability into the
 * `@endo/platform/fs/extended` Filesystem surface used by code mode.
 *
 * The Mount remains the authority boundary.
 * This adapter never receives or
 * exposes its host path, and the optional read-only wrapper removes the
 * Filesystem mutation surface at runtime.
 */

import { E } from '@endo/eventual-send';

import { mountAsFilesystem } from './from-mount.js';
import { readOnly } from './readonly.js';

const isTruthy = value =>
  value === '1' || value === 'true' || value === 'yes' || value === 'on';

/**
 * @param {{ lookup: (name: string | string[]) => Promise<object> }} powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {Promise<object>}
 */
export const make = async (powers, _context, options = {}) => {
  const { SOURCE_NAME: sourceName, READ_ONLY: readOnlySetting } =
    options.env || {};
  if (typeof sourceName !== 'string' || sourceName.length === 0) {
    throw new Error(
      'mount-filesystem-module: env.SOURCE_NAME (pet name of the backing Mount) is required',
    );
  }
  const mount = await E(powers).lookup(sourceName);
  const filesystem = mountAsFilesystem(mount);
  return isTruthy(readOnlySetting) ? readOnly(filesystem) : filesystem;
};
harden(make);
