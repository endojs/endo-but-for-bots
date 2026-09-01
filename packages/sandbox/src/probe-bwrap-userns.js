// @ts-check

import { spawn } from 'node:child_process';

import { spawnAndCollect } from './drivers/child-process.js';

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Confirm that bwrap can create the user namespace a real slice uses.
 *
 * @returns {Promise<{ available: boolean; reason?: string }>}
 */
export const probeBwrapUserns = async () => {
  await null;
  try {
    const result = await spawnAndCollect(
      { spawn },
      'bwrap',
      [
        '--unshare-all',
        '--die-with-parent',
        '--cap-drop',
        'ALL',
        '--ro-bind-try',
        '/usr',
        '/usr',
        '--ro-bind-try',
        '/bin',
        '/bin',
        '--ro-bind-try',
        '/lib',
        '/lib',
        '--ro-bind-try',
        '/lib64',
        '/lib64',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--clearenv',
        '--',
        '/bin/true',
      ],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (result.code === 0) {
      return { available: true };
    }
    const stderr = result.stderr.trim();
    return {
      available: false,
      reason:
        stderr === ''
          ? `bwrap user-namespace smoke test exit ${result.code}`
          : `bwrap user-namespace smoke test exit ${result.code}: ${stderr}`,
    };
  } catch (error) {
    return {
      available: false,
      reason: `failed to spawn bwrap: ${/** @type {Error} */ (error).message}`,
    };
  }
};
harden(probeBwrapUserns);
