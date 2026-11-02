// @ts-check
/** @import { FilePowers } from '../platform/files.js' */
/** @import { PathPowers } from '../platform/paths.js' */
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

/**
 * @typedef {object} NativeResourceEntries
 * @property {string} directory the directory's real path
 * @property {string} durablePath the `durable.js` entry, bundled for the
 *   manager vat
 * @property {string} ephemeralPath the `ephemeral.js` entry, bundled for
 *   the native process
 */

/**
 * Locate a native resource's two entry modules. Both are bundled at
 * installation, and the digests of the two bundles are the installation's
 * identity, so nothing else about the directory is pinned: what its modules
 * import is frozen in the bundles, and the directory may be edited or
 * removed afterwards; its new version is a new installation.
 *
 * Entries are located without following links, so a link is refused:
 * what is bundled is the file that is there.
 *
 * @param {object} powers
 * @param {FilePowers} powers.files
 * @param {PathPowers} powers.paths
 * @param {string} directory
 * @returns {Promise<NativeResourceEntries>}
 */
export const locateNativeResource = async ({ files, paths }, directory) => {
  const root = await files.realPath(directory);
  /** @param {string} name */
  const locate = async name => {
    const path = paths.join(root, name);
    const entry = await files.stat(path, { followLinks: false });
    entry.kind === 'file' || Fail`Native entry ${q(name)} must be a file`;
    return path;
  };
  const durablePath = await locate('durable.js');
  const ephemeralPath = await locate('ephemeral.js');
  return harden({ directory: root, durablePath, ephemeralPath });
};
harden(locateNativeResource);
