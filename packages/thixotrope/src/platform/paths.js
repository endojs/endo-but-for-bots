// @ts-check
import harden from '@endo/harden';

/**
 * String-level path operations. Paths are host designators; staying at the
 * string level keeps this power free of file authority, so a consumer that
 * only needs to name a resource need not receive file powers.
 *
 * @typedef {object} PathPowers
 * @property {(...parts: string[]) => string} join
 * @property {(path: string) => string} dirname
 * @property {(...parts: string[]) => string} resolve
 * @property {(path: string) => boolean} isAbsolute
 * @property {(url: string | URL) => string} fileURLToPath
 * @property {(path: string) => URL} pathToFileURL
 *
 * @param {object} host
 * @param {PathPowers['join']} host.join
 * @param {PathPowers['dirname']} host.dirname
 * @param {PathPowers['resolve']} host.resolve
 * @param {PathPowers['isAbsolute']} host.isAbsolute
 * @param {PathPowers['fileURLToPath']} host.fileURLToPath
 * @param {PathPowers['pathToFileURL']} host.pathToFileURL
 * @returns {PathPowers}
 */
export const makePathPowers = ({
  join,
  dirname,
  resolve,
  isAbsolute,
  fileURLToPath,
  pathToFileURL,
}) =>
  harden({
    join,
    dirname,
    resolve,
    isAbsolute,
    fileURLToPath,
    pathToFileURL,
  });
harden(makePathPowers);
