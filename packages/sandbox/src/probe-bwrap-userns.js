// @ts-check

import { spawn } from 'node:child_process';

/**
 * Confirm that bwrap can create the user namespace a real slice uses.
 *
 * @returns {Promise<{ available: boolean; reason?: string }>}
 */
export const probeBwrapUserns = async () => {
  await null;
  try {
    const proc = spawn(
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
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    /** @type {string[]} */
    const stderrChunks = [];
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', chunk => stderrChunks.push(chunk));
    return await new Promise(resolve => {
      proc.once('error', error =>
        resolve({
          available: false,
          reason: `failed to spawn bwrap: ${error.message}`,
        }),
      );
      proc.once('close', code => {
        if (code === 0) {
          resolve({ available: true });
          return;
        }
        const stderr = stderrChunks.join('').trim();
        resolve({
          available: false,
          reason:
            stderr === ''
              ? `bwrap user-namespace smoke test exit ${code}`
              : `bwrap user-namespace smoke test exit ${code}: ${stderr}`,
        });
      });
    });
  } catch (error) {
    return {
      available: false,
      reason: /** @type {Error} */ (error).message,
    };
  }
};
harden(probeBwrapUserns);
