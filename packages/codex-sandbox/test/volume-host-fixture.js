// @ts-check

import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { env } from 'node:process';
import { promisify } from 'node:util';

import { makeXfsVolumeQuotaObserver } from '@endo/sandbox/xfs-volume-quota.js';

import {
  makeCodexDurableVolumeProvider,
  makeFileVolumeRegistry,
} from '../src/durable-volumes.js';
import {
  makePodmanSessionVolumes,
  makeXfsSessionQuota,
} from '../src/volume-host.js';

const execute = promisify(execFile);

/**
 * Explicit manual Linux acceptance fixture. sudo is confined to this test
 * harness and the two fixed XFS executables; production supplies quota authority
 * through its service boundary instead. No model receives these powers.
 * @param {{directory:string,ownerId:string,projectIds:{first:number,last:number},volumeRoot:string,filesystem:string}} options
 */
export const makeLiveVolumeFixture = async ({
  directory,
  ownerId,
  projectIds,
  volumeRoot,
  filesystem,
}) => {
  const command = async (file, args) =>
    execute(file, args, {
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LC_ALL: 'C',
        HOME: env.HOME,
        XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
      },
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      killSignal: 'SIGKILL',
    });
  const run = async argv => {
    try {
      const result = await command('/usr/bin/podman', argv);
      return { code: 0, ...result };
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
      throw Error('Unexpected privileged quota executable');
    const { stdout, stderr } = await command('/usr/bin/sudo', [
      '--non-interactive',
      file,
      ...args,
    ]);
    if (stderr) throw Error(stderr);
    return stdout;
  };
  const filePowers = {
    realpath,
    readdir,
    stat: path => stat(path, { bigint: true }),
  };
  const observer = makeXfsVolumeQuotaObserver({
    volumeRoot,
    filesystem,
    ...filePowers,
    run: runQuota,
  });
  const quota = makeXfsSessionQuota({
    volumeRoot,
    filesystem,
    ...filePowers,
    run: runQuota,
    observer,
  });
  const volumes = makePodmanSessionVolumes({ volumeRoot, ...filePowers, run });
  const registry = await makeFileVolumeRegistry({ directory });
  const reopen = () =>
    makeCodexDurableVolumeProvider({
      ownerId,
      projectIds,
      registry,
      volumes,
      quota,
    });
  return harden({ provider: reopen(), observer, reopen, run });
};
harden(makeLiveVolumeFixture);
