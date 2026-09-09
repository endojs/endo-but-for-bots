// @ts-check

import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { env } from 'node:process';
import { promisify } from 'node:util';

import { makeXfsVolumeQuotaObserver } from '@endo/sandbox/xfs-volume-quota.js';

import {
  makeCodexDurableVolumeProvider,
  makeFileVolumeRegistry,
} from './durable-volumes.js';
import {
  makePodmanSessionVolumes,
  makeXfsSessionQuota,
} from './volume-host.js';

const execute = promisify(execFile);

/** Host-only Linux composition. The quota executable is an operator-installed
 * narrow bridge, not a general privileged shell. No session selects these paths.
 * @param {{directory:string, ownerId:string, volumeRoot:string, filesystem:string,
 * projectIds:{first:number,last:number}, volumeLimits?:{workspaceBytes:bigint,stateBytes:bigint},
 * quotaCommand:string, sudoPath?:string, flockPath?:string, ownerReaper?:any}} options
 */
export const makeHostVolumeProvider = async ({
  directory,
  ownerId,
  volumeRoot,
  filesystem,
  projectIds,
  volumeLimits,
  quotaCommand,
  sudoPath = '/usr/bin/sudo',
  flockPath = '/usr/bin/flock',
  ownerReaper,
}) => {
  // sudo rules bind the immutable executable, not the configuration symlink.
  const quotaExecutable = await realpath(quotaCommand);
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
  const runQuota = async (file, args) => {
    if (!['/usr/sbin/xfs_io', '/usr/sbin/xfs_quota'].includes(file))
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
  const files = {
    realpath,
    readdir,
    stat: path => stat(path, { bigint: true }),
  };
  const observer = makeXfsVolumeQuotaObserver({
    volumeRoot,
    filesystem,
    ...files,
    run: runQuota,
  });
  const quota = makeXfsSessionQuota({
    volumeRoot,
    filesystem,
    ...files,
    run: runQuota,
    observer,
  });
  const volumes = makePodmanSessionVolumes({ volumeRoot, ...files, run });
  const registry = await makeFileVolumeRegistry({
    directory,
    flockPath,
    ownerReaper,
  });
  const provider = makeCodexDurableVolumeProvider({
    ownerId,
    projectIds,
    volumeLimits,
    registry,
    volumes,
    quota,
  });
  return harden({
    provider,
    observer,
    recoverRegistry: registry.recoverAbandonedTransaction,
  });
};
harden(makeHostVolumeProvider);
