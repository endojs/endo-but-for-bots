// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';

/**
 * Whether a tree entry is a directory rather than a file. An entry with
 * `kind()` is a directory when it answers `'directory'`. An older
 * `ReadableTree` or `ReadableBlob` capability has no `kind()`, so method
 * introspection decides: an entry with `list` is a directory, and any other
 * entry is a file. Introspection avoids a noisy missing-method send.
 *
 * @param {unknown} entry
 * @returns {Promise<boolean>}
 */
export const isDirectoryEntry = async entry => {
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(/** @type {any} */ (entry)).__getMethodNames__();
  return methods.includes('kind')
    ? (await E(/** @type {any} */ (entry)).kind()) === 'directory'
    : methods.includes('list');
};
harden(isDirectoryEntry);
