// @ts-check
/** @import { NodePowers } from './platform/node-powers.js' */
import harden from '@endo/harden';

/**
 * Read-only recovery information, even when the executable is incompatible or
 * a guest is quarantined. Atomic metadata files are read independently; this
 * is an inspection report, not a transactional backup of a running daemon.
 * @param {NodePowers} powers
 * @param {string} statePath
 */
export const inspectIronhorseStore = async (powers, statePath) => {
  const { readFile, readdir } = powers.fsPromises;
  const { join } = powers.path;
  /** @param {string} path */
  const read = async path => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return null;
      throw error;
    }
  };
  const runtime = await read(join(statePath, 'runtime.json'));
  const ids = await readdir(join(statePath, 'workers'));
  const workers = await Promise.all(
    ids
      .filter(id => /^[a-f0-9]{32}$/.test(id))
      .sort()
      .map(async workerId => {
        const metadata = await read(
          join(statePath, 'workers', workerId, 'meta.json'),
        );
        return harden({ workerId, metadata });
      }),
  );
  return harden({ runtime, workers });
};
harden(inspectIronhorseStore);
