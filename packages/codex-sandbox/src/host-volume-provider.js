// @ts-check

import { makeXfsVolumeQuotaObserver } from '@endo/sandbox/xfs-volume-quota.js';
import { makeCodexHostCommands } from './codex-quota-host.js';
import {
  makeCodexDurableVolumeProvider,
  makeFileVolumeRegistry,
} from './durable-volumes.js';
import {
  makePodmanSessionVolumes,
  makeXfsSessionQuota,
} from './volume-host.js';

/**
 * Host-only Linux composition. The quota executable is an operator-installed
 * narrow bridge, not a general privileged shell — see `codex-quota-host.js`,
 * which the native sandbox runtime shares for its own observer. No session
 * selects these paths.
 * @param {{directory:string, sessionsDirectory:string, ownerId:string,
 * volumeRoot:string, filesystem:string,
 * projectIds:{first:number,last:number}, volumeLimits?:{stateBytes:bigint},
 * mounterEnv?:Record<string,string>,
 * quotaCommand:string, sudoPath?:string, flockPath?:string, ownerReaper?:any}} options
 */
export const makeHostVolumeProvider = async ({
  directory,
  sessionsDirectory,
  ownerId,
  volumeRoot,
  filesystem,
  projectIds,
  volumeLimits,
  mounterEnv,
  quotaCommand,
  sudoPath = '/usr/bin/sudo',
  flockPath = '/usr/bin/flock',
  ownerReaper,
}) => {
  const { run, runQuota, files } = await makeCodexHostCommands({
    quotaCommand,
    sudoPath,
  });
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
    sessionsDirectory,
    ...(mounterEnv ? { mounterEnv } : {}),
  });
  return harden({
    provider,
    observer,
    recoverRegistry: registry.recoverAbandonedTransaction,
  });
};
harden(makeHostVolumeProvider);
