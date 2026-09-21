// @ts-check

/**
 * Crash-recoverable native placement. Host-private allocation records select
 * uniquely allocated data directories by inode; publication is an atomic
 * no-overwrite hard link into the session namespace. Only data enters a guest
 * mount. Neither missing process-local handles nor directory names prove
 * ownership, and unpublished allocations are never reused by another session.
 * @module
 */

import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const ALLOCATION_PATTERN = /^[a-z0-9][a-zA-Z0-9-]{0,140}$/;

/** @param {string} target */
const inspect = async target => {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return undefined;
    throw error;
  }
};

/** @param {string} directory */
const flushDirectory = async directory => {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * The administrative owner must serialize preparation/removal for each
 * session, including across providers. Orphan inventory/removal additionally
 * requires all allocation/publication operations at this root to be quiescent.
 * Roots and ancestors must remain under stable host control. This does not
 * acknowledge native stop or defend against hostile host-level path races.
 * @param {string} stateRoot
 * @param {object} [powers]
 * @param {typeof flushDirectory} [powers.syncDirectory]
 * @param {(directory: string) => Promise<void>} [powers.removeDirectory]
 * @param {(stage: 'directory-created' | 'record-opened' | 'record-written' | 'record-published' | 'allocation-removed') => Promise<void>} [powers.checkpoint] Test-only process-loss injection.
 */
export const makeStateStorageOperations = (
  stateRoot,
  {
    checkpoint = async () => {},
    syncDirectory = flushDirectory,
    removeDirectory = directory =>
      rm(directory, { recursive: true, force: true }),
  } = {},
) => {
  (typeof stateRoot === 'string' &&
    path.isAbsolute(stateRoot) &&
    path.normalize(stateRoot) === stateRoot &&
    stateRoot !== '/') ||
    Fail`stateRoot must be a normalized absolute non-root path`;
  const owners = `${stateRoot}/.owners`;
  const allocations = `${stateRoot}/native_allocations`;
  const retirements = `${stateRoot}/.retirements`;

  /** @param {string} sessionId */
  const markerPath = sessionId => {
    SESSION_ID_PATTERN.test(sessionId) || Fail`Invalid session id`;
    return `${owners}/${sessionId}`;
  };
  /** @param {string} allocation */
  const allocationPath = allocation => {
    ALLOCATION_PATTERN.test(allocation) || Fail`Invalid allocation id`;
    return `${allocations}/${allocation}`;
  };

  /** @param {boolean} create */
  const validateRoots = async create => {
    const root = await inspect(stateRoot);
    !root?.isSymbolicLink() || Fail`State root must not be a symlink`;
    !root || root.isDirectory() || Fail`State root is not a directory`;
    if (!root && !create) return false;
    let ancestor = path.dirname(stateRoot);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const info = await inspect(ancestor);
      !info?.isSymbolicLink() || Fail`State root contains symbolic links`;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (create) await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    // Native roots (including ancestors) are host-owned and must not be aliases.
    (await realpath(stateRoot)) === stateRoot ||
      Fail`State root contains symbolic links`;
    for (const directory of [owners, allocations, retirements]) {
      // eslint-disable-next-line no-await-in-loop
      const info = await inspect(directory);
      !info?.isSymbolicLink() ||
        Fail`Ownership directory must not be a symlink`;
      !info ||
        info.isDirectory() ||
        Fail`Ownership directory is not a directory`;
      if (create) {
        // eslint-disable-next-line no-await-in-loop
        await mkdir(directory, { recursive: true, mode: 0o700 });
        // eslint-disable-next-line no-await-in-loop
        await chmod(directory, 0o700);
      }
    }
    if (create) {
      // A prior mkdir may have succeeded before its parent's fsync failed.
      // Retry the ancestry flush even when every directory already exists.
      let directory = stateRoot;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        await syncDirectory(directory);
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return true;
  };

  /** @param {string} location */
  const readRecord = async location => {
    const info = await inspect(location);
    if (!info) return undefined;
    (!info.isSymbolicLink() && info.isFile() && info.size <= 4096n) ||
      Fail`Invalid ownership record`;
    let record;
    try {
      record = JSON.parse(await readFile(location, 'utf8'));
    } catch {
      throw Fail`Session state directory is not owned by this session`;
    }
    (record &&
      Object.keys(record).sort().join(',') ===
        'allocation,allocationDev,allocationIno,dataDev,dataIno,sessionId,version' &&
      record.version === 1 &&
      typeof record.sessionId === 'string' &&
      SESSION_ID_PATTERN.test(record.sessionId) &&
      typeof record.allocation === 'string' &&
      ALLOCATION_PATTERN.test(record.allocation) &&
      record.allocation.startsWith(`${record.sessionId}-`) &&
      ['allocationDev', 'allocationIno', 'dataDev', 'dataIno'].every(
        key =>
          typeof record[key] === 'string' && /^[0-9]{1,32}$/.test(record[key]),
      )) ||
      Fail`Session state directory is not owned by this session`;
    return record;
  };

  /**
   * @param {any} record
   * @param {boolean} [allowMissing]
   */
  const validateAllocation = async (record, allowMissing = false) => {
    const allocation = allocationPath(record.allocation);
    const info = await inspect(allocation);
    if (!info && allowMissing) return undefined;
    (info &&
      !info.isSymbolicLink() &&
      info.isDirectory() &&
      String(info.dev) === record.allocationDev &&
      String(info.ino) === record.allocationIno) ||
      Fail`Session state allocation is not owned by this session`;
    const directory = `${allocation}/data`;
    const data = await inspect(directory);
    if (!data && allowMissing) return undefined;
    (data &&
      !data.isSymbolicLink() &&
      data.isDirectory() &&
      String(data.dev) === record.dataDev &&
      String(data.ino) === record.dataIno) ||
      Fail`Session state directory is not owned by this session or is a symbolic link`;
    return directory;
  };

  /** @param {string} sessionId */
  const assertOwnedDirectory = async sessionId => {
    const marker = markerPath(sessionId);
    if (!(await validateRoots(false))) return undefined;
    const record = await readRecord(marker);
    if (!record) {
      // Legacy/unknown fixed-path state is never silently adopted or deleted.
      !(await inspect(`${stateRoot}/${sessionId}`)) ||
        Fail`Session state directory is not owned by this session`;
      return undefined;
    }
    record.sessionId === sessionId ||
      Fail`Session state directory is not owned by this session`;
    return validateAllocation(record, true);
  };

  /** @param {string} sessionId */
  const prepareSessionDirectory = async sessionId => {
    const marker = markerPath(sessionId);
    await validateRoots(true);
    const existing = await assertOwnedDirectory(sessionId);
    if (existing) {
      await chmod(existing, 0o700);
      // link may have succeeded before a previous publication fsync failed.
      await syncDirectory(owners);
      return harden({ directory: existing });
    }
    !(await readRecord(marker)) ||
      Fail`Published session state directory is missing`;
    const allocation = await mkdtemp(`${allocations}/${sessionId}-`);
    const directory = `${allocation}/data`;
    await mkdir(directory, { mode: 0o700 });
    const allocationInfo = await inspect(allocation);
    const dataInfo = await inspect(directory);
    if (!allocationInfo?.isDirectory() || !dataInfo?.isDirectory()) {
      throw Fail`Allocated session directory is unavailable`;
    }
    await syncDirectory(directory);
    await syncDirectory(allocation);
    await syncDirectory(allocations);
    await checkpoint('directory-created');
    const record = {
      version: 1,
      sessionId,
      allocation: path.basename(allocation),
      allocationDev: String(allocationInfo.dev),
      allocationIno: String(allocationInfo.ino),
      dataDev: String(dataInfo.dev),
      dataIno: String(dataInfo.ino),
    };
    const recordPath = `${allocation}/record`;
    /* eslint-disable no-bitwise */
    const handle = await open(
      recordPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    /* eslint-enable no-bitwise */
    try {
      await checkpoint('record-opened');
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(allocation);
    await checkpoint('record-written');
    !(await inspect(`${stateRoot}/${sessionId}`)) ||
      Fail`Session state directory is not owned by this session`;
    await validateAllocation(record);
    // Hard-link publication cannot replace another session record or directory.
    await link(recordPath, marker);
    await syncDirectory(owners);
    await checkpoint('record-published');
    return harden({ directory: await validateAllocation(record) });
  };

  /** @param {string} sessionId */
  const removeSessionDirectory = async sessionId => {
    const marker = markerPath(sessionId);
    await assertOwnedDirectory(sessionId);
    if (!(await validateRoots(false))) return;
    const record = await readRecord(marker);
    if (record) {
      // validateAllocation above refuses substitutions. An interrupted removal
      // may already have removed data or the allocation; absence is retryable.
      await removeDirectory(allocationPath(record.allocation));
      await syncDirectory(allocations);
      await checkpoint('allocation-removed');
      await rm(marker);
    }
    // Retrying after unlink succeeded must still flush its publication.
    if (await inspect(owners)) await syncDirectory(owners);
  };

  /** Read-only inventory; malformed/partial allocations are never deletion proof. */
  const inspectAllocations = async () => {
    if (!(await validateRoots(false))) return harden([]);
    const published = new Set();
    for (const name of await readdir(owners).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      // eslint-disable-next-line no-await-in-loop
      const record = await readRecord(`${owners}/${name}`);
      record?.sessionId === name || Fail`Invalid published session identity`;
      published.add(record.allocation);
    }
    const result = [];
    const allocationNames = await readdir(allocations).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const retiringNames = await readdir(retirements).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const allocation of new Set([...allocationNames, ...retiringNames])) {
      let state = 'unproven';
      try {
        const location = allocationPath(allocation);
        // Do not follow an unknown allocation symlink to read its record.
        // eslint-disable-next-line no-await-in-loop
        const retired = await readRecord(`${retirements}/${allocation}`);
        // eslint-disable-next-line no-await-in-loop
        const info = await inspect(location);
        !info ||
          (info.isDirectory() && !info.isSymbolicLink()) ||
          Fail`Unknown allocation`;
        // eslint-disable-next-line no-await-in-loop
        const record = retired || (await readRecord(`${location}/record`));
        record?.allocation === allocation || Fail`Unknown allocation`;
        // eslint-disable-next-line no-await-in-loop
        await validateAllocation(record, retired !== undefined);
        state = published.has(allocation)
          ? 'published'
          : retired
            ? 'retiring'
            : 'unreferenced';
      } catch {
        // Report, do not infer that an unreadable/partial allocation is ours.
      }
      result.push({ allocation, state });
    }
    return harden(result);
  };

  /**
   * Administrative cleanup requires quiescent producers and stopped native
   * consumers. Only a complete inode-bound unreferenced record permits removal.
   * Unproven allocations require separate explicit operator investigation.
   * @param {string} allocation
   */
  const removeUnreferencedAllocation = async allocation => {
    const location = allocationPath(allocation);
    if (!(await validateRoots(false))) return;
    const retirement = `${retirements}/${allocation}`;
    if (!(await inspect(location)) && !(await inspect(retirement))) {
      // A previous attempt may have unlinked its intent before fsync failed.
      if (await inspect(allocations)) await syncDirectory(allocations);
      if (await inspect(retirements)) await syncDirectory(retirements);
      return;
    }
    const inventory = await inspectAllocations();
    inventory.some(
      entry =>
        entry.allocation === allocation &&
        ['unreferenced', 'retiring'].includes(entry.state),
    ) || Fail`Allocation is published or ownership is unproven`;
    if (!(await readRecord(retirement))) {
      await link(`${allocationPath(allocation)}/record`, retirement);
    }
    await syncDirectory(retirements);
    await removeDirectory(allocationPath(allocation));
    await syncDirectory(allocations);
    await rm(retirement);
    await syncDirectory(retirements);
  };

  return harden({
    prepareSessionDirectory,
    removeSessionDirectory,
    assertOwnedDirectory,
    inspectAllocations,
    removeUnreferencedAllocation,
  });
};
harden(makeStateStorageOperations);

/**
 * Native placement authority, not proof that a sandbox stopped. The caller
 * retains the original provider identity and serializes lifecycle operations.
 * Only data directories enter guest mounts; allocation/ownership roots remain
 * host-private. Unknown or unpublished state is never reused.
 * @param {{ stateRoot: string }} options
 */
export const makeSessionStateStorage = ({ stateRoot }) => {
  const { prepareSessionDirectory, removeSessionDirectory } =
    makeStateStorageOperations(stateRoot);
  return makeExo(
    'SessionStateStorage',
    M.interface('SessionStateStorage', {
      prepareSessionDirectory: M.call(M.string()).returns(M.promise()),
      removeSessionDirectory: M.call(M.string()).returns(M.promise()),
    }),
    { prepareSessionDirectory, removeSessionDirectory },
  );
};
harden(makeSessionStateStorage);
