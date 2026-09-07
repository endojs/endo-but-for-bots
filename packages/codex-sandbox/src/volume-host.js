// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * Rootless Podman volume administration. `run` executes only the given argv
 * as the configured storage owner, with bounded output/deadlines. It returns
 * {code,stdout,stderr}; never run this adapter as root. `stat` uses bigint IDs.
 * The operator must dedicate volumeRoot to this provider's storage account.
 * @param {{run:(argv:string[])=>Promise<any>,stat:(path:string)=>Promise<any>,realpath:(path:string)=>Promise<string>,readdir:(path:string)=>Promise<string[]>,volumeRoot:string}} powers
 */
export const makePodmanSessionVolumes = ({
  run,
  stat,
  realpath,
  readdir,
  volumeRoot,
}) => {
  const inspect = async name => {
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) ||
      Fail`Invalid volume name`;
    const exists = await run(['volume', 'exists', name]);
    if (exists.code === 1) return undefined;
    exists.code === 0 || Fail`Cannot inspect volume existence`;
    const result = await run(['volume', 'inspect', name]);
    result.code === 0 || Fail`Cannot inspect volume`;
    const records = JSON.parse(result.stdout);
    (Array.isArray(records) && records.length === 1) ||
      Fail`Invalid volume inspection`;
    return records[0];
  };
  const identity = async (record, { name, ownerId, sessionId, role }) => {
    (record.Name === name &&
      record.Driver === 'local' &&
      record.Mountpoint === `${volumeRoot}/${name}/_data` &&
      Object.keys(record.Options ?? {}).length === 0 &&
      record.Labels?.['endo.floot.owner'] === ownerId &&
      record.Labels?.['endo.floot.session'] === sessionId &&
      record.Labels?.['endo.floot.role'] === role) ||
      Fail`Volume ownership or backing mismatch`;
    (await realpath(record.Mountpoint)) === record.Mountpoint ||
      Fail`Volume path contains symbolic links`;
    const info = await stat(record.Mountpoint);
    info.isDirectory() || Fail`Volume is not a directory`;
    return harden({
      name,
      mountpoint: record.Mountpoint,
      device: `${info.dev}`,
      inode: `${info.ino}`,
    });
  };
  const ensure = async request => {
    let record = await inspect(request.name);
    if (record === undefined) {
      const result = await run([
        'volume',
        'create',
        '--label',
        `endo.floot.owner=${request.ownerId}`,
        '--label',
        `endo.floot.session=${request.sessionId}`,
        '--label',
        `endo.floot.role=${request.role}`,
        request.name,
      ]);
      result.code === 0 || Fail`Volume creation failed`;
      record = await inspect(request.name);
    }
    record !== undefined || Fail`Created volume is missing`;
    const observed = await identity(record, request);
    const ownership = async () => {
      const result = await run([
        'unshare',
        'stat',
        '-c',
        '%u:%g',
        '--',
        observed.mountpoint,
      ]);
      result.code === 0 || Fail`Cannot observe volume user-namespace ownership`;
      return result.stdout.trim();
    };
    if ((await ownership()) !== '1000:1000') {
      (await readdir(observed.mountpoint)).length === 0 ||
        Fail`Cannot change ownership of a nonempty session volume`;
      const changed = await run([
        'unshare',
        'chown',
        '1000:1000',
        '--',
        observed.mountpoint,
      ]);
      changed.code === 0 || Fail`Cannot initialize session volume ownership`;
      (await ownership()) === '1000:1000' ||
        Fail`Session volume ownership did not verify`;
    }
    return observed;
  };
  const assertUnused = async ({ name }) => {
    const result = await run([
      'ps',
      '--all',
      '--filter',
      `volume=${name}`,
      '--format',
      '{{.ID}}',
    ]);
    (result.code === 0 && result.stdout.trim() === '') ||
      Fail`Volume is still used by a container`;
  };
  const remove = async request => {
    const record = await inspect(request.name);
    if (record === undefined) return;
    const observed = await identity(record, request);
    if (request.identity)
      JSON.stringify(observed) === JSON.stringify(request.identity) ||
        Fail`Volume identity changed before deletion`;
    await assertUnused(request);
    const result = await run(['volume', 'rm', request.name]);
    result.code === 0 || Fail`Volume removal failed`;
  };
  return makeExo(
    'PodmanSessionVolumes',
    M.interface('PodmanSessionVolumes', {
      ensure: M.callWhen(M.record()).returns(M.record()),
      remove: M.callWhen(M.record()).returns(M.any()),
      assertUnused: M.callWhen({ name: M.string() }).returns(M.any()),
    }),
    { ensure, remove, assertUnused },
  );
};
harden(makePodmanSessionVolumes);

/**
 * Privileged XFS allocator limited to canonical registered volume directories.
 * `run` is a separate initial-user-namespace authority, fixed read/write quota
 * commands only; bounded output, LC_ALL=C, deadlines and stderr rejection.
 * `observer` is makeXfsVolumeQuotaObserver from the sandbox package.
 * The registry exclusively reserves project IDs before this method is called.
 * @param {{volumeRoot:string,filesystem:string,run:(file:string,argv:string[])=>Promise<string>,stat:(path:string)=>Promise<any>,realpath:(path:string)=>Promise<string>,readdir:(path:string)=>Promise<string[]>,observer:any}} powers
 */
export const makeXfsSessionQuota = ({
  volumeRoot,
  filesystem,
  run,
  stat,
  realpath,
  readdir,
  observer,
}) => {
  (/^(\/[A-Za-z0-9_.-]+)+$/.test(volumeRoot) &&
    /^(\/[A-Za-z0-9_.-]+)+$/.test(filesystem)) ||
    Fail`Quota roots must be canonical paths`;
  const ensure = async request => {
    const { name, mountpoint, projectId, hardBytes, initialize } = request;
    (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) &&
      mountpoint === `${volumeRoot}/${name}/_data` &&
      typeof projectId === 'number' &&
      Number.isInteger(projectId) &&
      projectId > 0 &&
      projectId <= 0xffff_ffff &&
      typeof hardBytes === 'bigint' &&
      hardBytes > 0n &&
      hardBytes % 1024n === 0n) ||
      Fail`Invalid quota allocation`;
    const matches = evidence =>
      evidence.projectId === projectId &&
      evidence.hardBytes === hardBytes &&
      evidence.device === request.device &&
      evidence.inode === request.inode;
    let existing;
    try {
      existing = await E(observer).observe({ name, mountpoint });
    } catch (error) {
      if (!initialize) throw error;
    }
    if (existing !== undefined) {
      matches(existing) ||
        Fail`Existing project quota differs from durable registry`;
      return;
    }
    // A failed initialization is only repeatable while nothing was published.
    // Never recursively relabel a nonempty durable workspace to repair drift.
    ((await realpath(mountpoint)) === mountpoint &&
      (await readdir(mountpoint)).length === 0) ||
      Fail`Quota initialization requires an empty canonical volume`;
    const before = await stat(mountpoint);
    (`${before.dev}` === request.device && `${before.ino}` === request.inode) ||
      Fail`Volume changed before quota allocation`;
    await run('/usr/sbin/xfs_quota', [
      '-x',
      '-c',
      `project -s -p ${mountpoint} ${projectId}`,
      filesystem,
    ]);
    await run('/usr/sbin/xfs_quota', [
      '-x',
      '-c',
      `limit -p bhard=${hardBytes / 1024n}k ${projectId}`,
      filesystem,
    ]);
    matches(await E(observer).observe({ name, mountpoint })) ||
      Fail`Allocated quota did not verify`;
  };
  return makeExo(
    'XfsSessionQuota',
    M.interface('XfsSessionQuota', {
      ensure: M.callWhen(M.record()).returns(M.any()),
      observe: M.callWhen(M.record()).returns(M.record()),
    }),
    { ensure, observe: request => E(observer).observe(request) },
  );
};
harden(makeXfsSessionQuota);
