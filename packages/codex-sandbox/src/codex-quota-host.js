// @ts-check

/**
 * The privileged host bridge Codex's durable volumes run on, factored out of
 * `host-volume-provider.js` so the native sandbox runtime can build the same
 * kernel-quota observer without also taking the registry, the leases and the
 * project-ID allocator.
 *
 * The quota executable is an operator-installed narrow bridge, not a general
 * privileged shell: `sudo` rules bind the resolved executable, and only the two
 * XFS tools are ever passed to it. No session selects any of these paths.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { env } from 'node:process';
import { promisify } from 'node:util';

import { makeXfsVolumeQuotaObserver } from '@endo/sandbox/xfs-volume-quota.js';

const execute = promisify(execFile);

/** The only executables the quota helper will be asked to run. */
const QUOTA_EXECUTABLES = harden(['/usr/sbin/xfs_io', '/usr/sbin/xfs_quota']);

/**
 * @param {{ quotaCommand: string, sudoPath?: string }} options
 */
export const makeCodexHostCommands = async ({
  quotaCommand,
  sudoPath = '/usr/bin/sudo',
}) => {
  // sudo rules bind the immutable executable, not the configuration symlink.
  const quotaExecutable = await realpath(quotaCommand);
  /**
   * @param {string} file
   * @param {string[]} args
   */
  const command = (file, args) =>
    execute(file, args, {
      env: {
        PATH: env.PATH,
        HOME: env.HOME,
        XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
        LC_ALL: 'C',
      },
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      killSignal: 'SIGKILL',
    });
  /** @param {string[]} argv */
  const run = async argv => {
    try {
      return { code: 0, ...(await command('podman', argv)) };
    } catch (error) {
      const failure =
        /** @type {Error & {code?:number|string,stdout?:string,stderr?:string,killed?:boolean}} */ (
          error
        );
      if (typeof failure.code !== 'number' || failure.killed) throw error;
      return {
        code: failure.code,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  };
  /**
   * @param {string} file
   * @param {string[]} args
   */
  const runQuota = async (file, args) => {
    if (!QUOTA_EXECUTABLES.includes(file))
      throw Error('Unexpected quota executable');
    const { stdout, stderr } = await command(sudoPath, [
      '--non-interactive',
      quotaExecutable,
      file,
      ...args,
    ]);
    if (stderr) throw Error('Quota helper diagnostic');
    return stdout;
  };
  const files = harden({
    realpath,
    readdir,
    /** @param {string} path */
    stat: path => stat(path, { bigint: true }),
  });
  return harden({ run, runQuota, files });
};
harden(makeCodexHostCommands);

/**
 * The kernel-quota observer the Podman driver consults before it admits a
 * volume mount. It reads; it never assigns. Two instances observing the same
 * filesystem are independent and safe — the native runtime and the volume
 * provider each build their own rather than passing one across a formula
 * boundary, where it would become a capability a caplet could retain.
 *
 * @param {{ volumeRoot: string, filesystem: string, quotaCommand: string,
 *   sudoPath?: string }} options
 */
export const makeCodexVolumeQuotaObserver = async options => {
  const { runQuota, files } = await makeCodexHostCommands(options);
  return makeXfsVolumeQuotaObserver({
    volumeRoot: options.volumeRoot,
    filesystem: options.filesystem,
    ...files,
    run: runQuota,
  });
};
harden(makeCodexVolumeQuotaObserver);
