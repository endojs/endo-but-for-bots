// @ts-check
/** @import { FilePowers } from '../platform/files.js' */
/** @import { HashPowers } from '../platform/hashes.js' */
/** @import { PathPowers } from '../platform/paths.js' */
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

/**
 * @typedef {object} NativePackageDescription
 * @property {string} directory the package's real path
 * @property {string} digest SHA-256 over every file's relative path, length,
 *   and bytes, in sorted order
 * @property {string} durablePath the `durable.js` entry, to bundle
 * @property {string} moduleUrl the `ephemeral.js` entry, for the native
 *   process to import
 */

const encoder = new TextEncoder();

/**
 * Pin the installed directory's contents; external dependencies use
 * ordinary module resolution and are not included in this digest.
 * Directories contain source, not node_modules. Edited packages require an
 * explicit new installation.
 *
 * Entries are described without following links, so a symbolic link is
 * neither file nor directory and is refused: the digest covers only bytes
 * that live inside the directory.
 *
 * @param {object} powers
 * @param {FilePowers} powers.files
 * @param {PathPowers} powers.paths
 * @param {HashPowers} powers.hashes
 * @param {string} directory
 * @returns {Promise<NativePackageDescription>}
 */
export const describeNativePackage = async (
  { files, paths, hashes },
  directory,
) => {
  const root = await files.realPath(directory);
  for (const name of ['durable.js', 'ephemeral.js']) {
    // eslint-disable-next-line no-await-in-loop
    const entry = await files.stat(paths.join(root, name), {
      followLinks: false,
    });
    entry.kind === 'file' || Fail`Native entry ${q(name)} must be a file`;
  }
  const hash = hashes.makeSha256();
  /** @param {string} relative */
  const visit = async relative => {
    const path = paths.join(root, relative);
    const entry = await files.stat(path, { followLinks: false });
    if (entry.kind === 'directory') {
      const names = (await files.listDirectory(path)).sort();
      for (const name of names) {
        name !== 'node_modules' ||
          Fail`Native package must not contain node_modules`;
        // eslint-disable-next-line no-await-in-loop
        await visit(paths.join(relative, name));
      }
    } else {
      entry.kind === 'file' ||
        Fail`Native package entries must be files or directories`;
      const bytes = await files.readBytes(path);
      hash.update(encoder.encode(JSON.stringify([relative, bytes.length])));
      hash.update(bytes);
    }
  };
  await visit('');
  return harden({
    directory: root,
    digest: hash.digestHex(),
    durablePath: paths.join(root, 'durable.js'),
    moduleUrl: paths.pathToFileURL(paths.join(root, 'ephemeral.js')),
  });
};
harden(describeNativePackage);
