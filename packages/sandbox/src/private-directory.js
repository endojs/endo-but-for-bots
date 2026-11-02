// @ts-check

/* global process */

import { Fail, q } from '@endo/errors';

/**
 * Resolve an existing private directory owned by this host runtime.
 * Its ancestry must remain outside guest write authority for its entire use.
 * @param {string} directory
 * @param {typeof import('node:fs/promises')} fs
 * @returns {Promise<string>}
 */
export const assertPrivateDirectory = async (directory, fs) => {
  const path = await import('node:path');
  (path.isAbsolute(directory) && !directory.includes('\0')) ||
    Fail`Runtime directory must be absolute`;
  const canonical = await fs.realpath(directory);
  const stat = await fs.stat(canonical);
  // eslint-disable-next-line no-bitwise
  const sharedPermissions = stat.mode & 0o077;
  (stat.isDirectory() &&
    sharedPermissions === 0 &&
    stat.uid === process.getuid?.()) ||
    Fail`Runtime directory must be private and owned by this runtime: ${q(canonical)}`;
  return canonical;
};
harden(assertPrivateDirectory);
