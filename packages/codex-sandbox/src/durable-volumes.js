// @ts-check
/* eslint-disable no-await-in-loop -- Durable side effects must complete in recorded order. */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { execPath, pid } from 'node:process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { Fail, makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { providePrivateDirectory } from '@endo/hosted-agent/hosted-setup.js';
import { makeWorkspaceProjection } from '@endo/hosted-agent/workspace-projection.js';

import { normalizeCodexVolumeLimits } from './volume-limits.js';

/**
 * Real atomic file registry. Linux flock holds a transaction across its callback;
 * only the child holding that lock writes state, with fsync + atomic rename.
 * A crashed parent closes stdin and releases the lock, but leaves a durable
 * poison marker requiring owner/descendant reaping before administrative recovery.
 * timeoutMs bounds control responses and cleanup, not the callback: a hung host
 * capability retains the transaction. Host capabilities must settle only after
 * their effects have completed or their processes were terminated and reaped.
 * A dead helper cannot
 * commit a late parent update. Caller supplies a private, persistent directory.
 * @param {{directory: string, timeoutMs?: number, flockPath?: string, ownerReaper?: {reap(owner: {ownerPid:string,ownerStartTime:string,transactionId:string}): Promise<void>}}} options
 */
export const makeFileVolumeRegistry = async ({
  directory,
  timeoutMs = 60_000,
  flockPath = '/usr/bin/flock',
  ownerReaper,
}) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  (await realpath(directory)) === directory ||
    Fail`Registry path must be canonical`;
  const path = `${directory}/volumes.json`;
  const helper = fileURLToPath(
    new URL('./volume-registry-worker.js', import.meta.url),
  );
  /**
   * @template T
   * @param {(state: any, save: () => Promise<void>) => Promise<T>} operation
   */
  const transaction = async operation => {
    const transactionId = randomUUID();
    const child = spawn(
      flockPath,
      [
        '--exclusive',
        '--no-fork',
        `${directory}/lock`,
        execPath,
        helper,
        path,
        directory,
        transactionId,
        `${pid}`,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    );
    let timer;
    let finished = false;
    let stderr = '';
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', bytes => {
      stderr += bytes.toString();
      if (stderr.length > 4096) child.kill('SIGKILL');
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code =>
        code === 0
          ? resolve(undefined)
          : reject(
              Error(
                `Volume registry helper failed (${code}): ${stderr.slice(0, 4096)}`,
              ),
            ),
      );
    });
    exited.catch(() => undefined);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const next = async () => {
      timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const item = await Promise.race([
        iterator.next(),
        exited.then(() => {
          throw Error('Volume registry closed');
        }),
      ]);
      clearTimeout(timer);
      if (item.done) await exited;
      if (item.done || item.value.length > 1024 * 1024)
        throw Error('Invalid volume registry response');
      return item.value;
    };
    try {
      const state = JSON.parse(await next());
      const save = async () => {
        const text = JSON.stringify({ type: 'save', state });
        text.length <= 1024 * 1024 || Fail`Volume registry too large`;
        await new Promise((resolve, reject) =>
          child.stdin.write(`${text}\n`, error =>
            error ? reject(error) : resolve(undefined),
          ),
        );
        (await next()) === 'saved' ||
          Fail`Volume registry save was not acknowledged`;
      };
      let result;
      let operationError;
      let failed = false;
      try {
        result = await operation(state, save);
      } catch (error) {
        operationError = error;
        failed = true;
      }
      await new Promise((resolve, reject) =>
        child.stdin.write('{"type":"finish"}\n', error =>
          error ? reject(error) : resolve(undefined),
        ),
      );
      (await next()) === 'finished' ||
        Fail`Volume transaction finish was not acknowledged`;
      finished = true;
      child.stdin.end();
      await exited;
      if (failed) throw operationError;
      return result;
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill('SIGKILL');
      await exited.catch(() => undefined);
      lines.close();
      // The callback has settled before this finally. Even if the writer died,
      // no host side effect from this transaction remains in flight. Remove
      // only our own poison marker; other instances cannot retire this callback while its effects continue.
      if (!finished) {
        const recovery = spawn(
          flockPath,
          [
            '--exclusive',
            '--no-fork',
            `${directory}/lock`,
            execPath,
            helper,
            path,
            directory,
            transactionId,
            `${pid}`,
            'recover-settled',
          ],
          { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } },
        );
        const recoveryTimer = setTimeout(
          () => recovery.kill('SIGKILL'),
          timeoutMs,
        );
        try {
          await new Promise((resolve, reject) => {
            recovery.once('error', reject);
            recovery.once('close', code =>
              code === 0
                ? resolve(undefined)
                : reject(Error('Volume transaction recovery remains pending')),
            );
          });
        } finally {
          clearTimeout(recoveryTimer);
        }
      }
    }
  };
  const recoverAbandonedTransaction = async () => {
    if (ownerReaper === undefined) {
      throw makeError(
        X`Registry recovery requires an operator owner/descendant reaper`,
      );
    }
    let marker;
    try {
      marker = JSON.parse(
        await readFile(`${directory}/transaction.json`, 'utf8'),
      );
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return;
      throw error;
    }
    (/^[1-9][0-9]*$/.test(marker.ownerPid) &&
      /^[0-9]+$/.test(marker.ownerStartTime)) ||
      Fail`Unverifiable registry owner identity`;
    let alive = false;
    try {
      const status = await readFile(`/proc/${marker.ownerPid}/stat`, 'utf8');
      alive =
        status.slice(status.lastIndexOf(')') + 2).split(' ')[19] ===
        marker.ownerStartTime;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw error;
    }
    !alive || Fail`Cannot recover a live volume registry owner`;
    let deadline;
    try {
      await Promise.race([
        E(ownerReaper).reap(
          harden({
            ownerPid: marker.ownerPid,
            ownerStartTime: marker.ownerStartTime,
            transactionId: marker.id,
          }),
        ),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                Error('Registry owner reaping timed out; marker retained'),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    const recovery = spawn(
      flockPath,
      [
        '--exclusive',
        '--no-fork',
        `${directory}/lock`,
        execPath,
        helper,
        path,
        directory,
        marker.id,
        `${pid}`,
        'recover-abandoned',
        JSON.stringify(marker),
      ],
      { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } },
    );
    const timer = setTimeout(() => recovery.kill('SIGKILL'), timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        recovery.once('error', reject);
        recovery.once('close', code =>
          code === 0
            ? resolve(undefined)
            : reject(
                Error('Abandoned registry recovery failed; marker retained'),
              ),
        );
      });
    } finally {
      clearTimeout(timer);
    }
  };
  return harden({ transaction, recoverAbandonedTransaction });
};
harden(makeFileVolumeRegistry);

const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/**
 * The roles this provider allocates a quota-backed volume for.
 *
 * `workspace` was one of them until 2026-09-16. It is now the 9P projection
 * of the tree the session already has, so the slice, the session's file
 * tools, the guest's workspace capability and Floot's publisher all read one
 * tree rather than the slice writing to a volume nothing else could see. A
 * record written before that change still lists its workspace volume; the
 * volume is retired in place — never mounted again, removed with the rest of
 * the record on `destroy` — because reusing its project ID would let a later
 * session inherit an earlier one's quota.
 */
const roles = harden(['state']);
const isRetired = volume => !roles.includes(volume.role);

/**
 * Durable session-volume state machine. The operator supplies rootless Podman
 * and a separately privileged quota allocator; these never reach the model.
 * Podman methods create ordinary volumes with ownership labels, inspect their
 * physical identity, and remove without force. Quota assignment is idempotent
 * for a reserved project ID and must refuse nonempty unowned directories.
 *
 * A session's workspace is not among the volumes: it is the 9P projection of
 * a tree the session already has, established here alongside the state
 * volume's lease so the two are acquired and released together.
 *
 * @param {object} powers
 * @param {string} powers.ownerId
 * @param {{first:number,last:number}} powers.projectIds
 * @param {any} powers.registry
 * @param {any} powers.volumes
 * @param {any} powers.quota
 * @param {{stateBytes:bigint}} [powers.volumeLimits]
 * @param {string} powers.sessionsDirectory The private root this provider
 * creates each session's mount point, 9P socket directory, and — for a
 * session that brings no worktree of its own — its workspace tree under.
 * @param {Record<string,string>} [powers.mounterEnv] The operator's mount
 * and umount programs.
 * @param {typeof makeWorkspaceProjection} [powers.projectWorkspace]
 * @param {(label: string, directory: string) => Promise<void>} [powers.provideDirectory]
 * @param {(path: string) => Promise<string | undefined>} [powers.canonicalDirectory]
 * Resolve an operator-supplied worktree, or resolve to undefined when it is
 * not an existing directory.
 */
export const makeCodexDurableVolumeProvider = ({
  ownerId,
  projectIds,
  registry,
  volumes,
  quota,
  volumeLimits,
  sessionsDirectory,
  mounterEnv = {},
  projectWorkspace = makeWorkspaceProjection,
  provideDirectory = providePrivateDirectory,
  canonicalDirectory = async path => {
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory()) return undefined;
    return realpath(path);
  },
}) => {
  const limits = normalizeCodexVolumeLimits(volumeLimits);
  (typeof ownerId === 'string' &&
    ownerId.length > 0 &&
    ownerId.length <= 256) ||
    Fail`Invalid volume owner`;
  (Number.isInteger(projectIds.first) &&
    Number.isInteger(projectIds.last) &&
    projectIds.first > 0 &&
    projectIds.last > projectIds.first &&
    projectIds.last <= 0xffff_ffff) ||
    Fail`Invalid exclusive project ID range`;
  (typeof sessionsDirectory === 'string' &&
    sessionsDirectory.startsWith('/') &&
    !sessionsDirectory.endsWith('/')) ||
    Fail`Invalid Codex session directory root`;
  const mounts = new WeakMap();
  const active = new Map();
  /**
   * Resolve the host tree this session's workspace projects.
   *
   * Floot supplies `workspaceHostPath` when the session's preset has a git
   * workspace — the same path it gives Claude and OpenCode — so the slice
   * sees the worktree the publisher serves. A session without one gets a
   * tree of its own under this provider's root, which is what the other two
   * adapters do with `workspaceDir`.
   *
   * @param {string} sessionId
   * @param {unknown} workspaceHostPath
   * @param {string} ownRoot
   */
  const resolveWorkspaceRoot = async (
    sessionId,
    workspaceHostPath,
    ownRoot,
  ) => {
    if (workspaceHostPath === undefined) {
      await provideDirectory('Codex session workspace', ownRoot);
      return ownRoot;
    }
    (typeof workspaceHostPath === 'string' &&
      workspaceHostPath.startsWith('/') &&
      !workspaceHostPath.includes('\0') &&
      workspaceHostPath.length <= 4096) ||
      Fail`Codex workspaceHostPath must be an absolute host path, got ${q(workspaceHostPath)}`;
    const canonical = await canonicalDirectory(
      /** @type {string} */ (workspaceHostPath),
    );
    if (!canonical) {
      throw Fail`Codex workspaceHostPath ${q(workspaceHostPath)} must be an existing directory`;
    }
    canonical === workspaceHostPath ||
      Fail`Codex workspaceHostPath ${q(workspaceHostPath)} must be canonical; it resolves to ${q(canonical)}`;
    // The provider's own root holds the registry, the mount points and the
    // socket directories. Projecting it would let a session read and write
    // the records that bound it.
    (canonical !== sessionsDirectory &&
      !canonical.startsWith(`${sessionsDirectory}/`)) ||
      Fail`Codex workspaceHostPath ${q(workspaceHostPath)} must be disjoint from the session storage root`;
    return canonical;
  };
  const assertSession = sessionId =>
    (typeof sessionId === 'string' && sessionPattern.test(sessionId)) ||
    Fail`Invalid volume session`;
  const checkRegistry = state => {
    const nextProjectId = /** @type {number} */ (state.nextProjectId);
    (state.version === 1 &&
      typeof state.nextProjectId === 'number' &&
      Number.isInteger(state.nextProjectId) &&
      nextProjectId > 0 &&
      nextProjectId <= 0xffff_ffff &&
      state.sessions &&
      typeof state.sessions === 'object' &&
      !Array.isArray(state.sessions)) ||
      Fail`Invalid volume registry`;
    if (state.ownerId === undefined) {
      state.ownerId = ownerId;
      state.nextProjectId = projectIds.first;
      state.projectIds = projectIds;
    }
    (state.projectIds?.first === projectIds.first &&
      state.projectIds?.last === projectIds.last) ||
      Fail`Project ID range changed`;
    state.ownerId === ownerId || Fail`Volume registry owner mismatch`;
  };
  const identity = (sessionId, role) =>
    `floot-${createHash('sha256').update(`${ownerId}\0${sessionId}\0${role}`).digest('hex')}`;
  const ensure = async spec => {
    const { sessionId } = spec;
    assertSession(sessionId);
    return registry.transaction(async (state, save) => {
      checkRegistry(state);
      let record = Object.hasOwn(state.sessions, sessionId)
        ? state.sessions[sessionId]
        : undefined;
      // A lease in the registry is either this process's or a dead
      // incarnation's, and only the second is an obstruction. `active` holds
      // the ones this process took, so reopening a workspace it already holds
      // is idempotent — which is what a revived session's own next turn is
      // doing. Recovery cannot serve that case and should not: it refuses a
      // live local lease on purpose. A lease with no live holder here still
      // requires explicit recovery, unchanged.
      !record?.lease ||
        active.get(sessionId) === record.lease ||
        Fail`Session volumes have an outstanding durable lease`;
      if (!record) {
        const nextProjectId = /** @type {number} */ (state.nextProjectId);
        (!state.exhausted && nextProjectId < projectIds.last) ||
          Fail`XFS project ID space exhausted`;
        record = {
          phase: 'creating',
          sessionId,
          volumes: roles.map((role, index) => ({
            role,
            name: identity(sessionId, role),
            projectId: nextProjectId + index,
            hardBytes: `${limits.stateBytes}`,
            ready: false,
          })),
        };
        // One ID per role, and the range is a host-lifetime budget rather
        // than a concurrency limit — IDs are never recycled — so dropping the
        // workspace volume halves what a session costs it.
        if (nextProjectId + roles.length > projectIds.last)
          state.exhausted = true;
        else state.nextProjectId = nextProjectId + roles.length;
        state.sessions[sessionId] = record;
        await save();
      }
      record.phase !== 'deleting' ||
        Fail`Session volume deletion must finish before reopening`;
      // A retired role is not re-ensured: its quota is whatever it was
      // allocated with, and nothing mounts it. `destroy` still removes it.
      for (const volume of record.volumes.filter(held => !isRetired(held))) {
        BigInt(volume.hardBytes) === limits.stateBytes ||
          Fail`Stored Codex volume limits changed; explicit migration required`;
        // Each intent is durable before touching a resource; retries reuse the
        // same volume/project identity and never erase existing user data.
        const observed = await E(volumes).ensure({
          name: volume.name,
          ownerId,
          sessionId,
          role: volume.role,
        });
        if (volume.identity !== undefined) {
          JSON.stringify(observed) === JSON.stringify(volume.identity) ||
            Fail`Durable volume identity changed`;
        } else {
          volume.identity = observed;
          await save();
        }
        await E(quota).ensure({
          ...observed,
          projectId: volume.projectId,
          hardBytes: BigInt(volume.hardBytes),
          initialize: !volume.ready,
        });
        const evidence = await E(quota).observe({
          name: volume.name,
          mountpoint: observed.mountpoint,
        });
        (evidence.projectId === volume.projectId &&
          evidence.hardBytes === BigInt(volume.hardBytes) &&
          evidence.device === observed.device &&
          evidence.inode === observed.inode &&
          evidence.enforced &&
          evidence.projectInherited) ||
          Fail`Durable quota evidence mismatch`;
        volume.ready = true;
        await save();
      }
      record.phase = 'ready';
      await save();
      return harden({ sessionId });
    });
  };
  const mountWorkspace = async (workspace, spec) => {
    const { sessionId } = spec;
    assertSession(sessionId);
    workspace.sessionId === sessionId || Fail`Workspace session mismatch`;
    !active.has(sessionId) || Fail`Session volumes already leased`;
    let lease;
    let projection;
    const leaseId = randomUUID();
    active.set(sessionId, leaseId);
    try {
      await ensure(spec);
      await registry.transaction(async (state, save) => {
        const record = Object.hasOwn(state.sessions, sessionId)
          ? state.sessions[sessionId]
          : undefined;
        !record.lease || Fail`Session volumes already leased`;
        record.lease = leaseId;
        await save();
      });
      // The session's private placement. The mount point is created by the
      // mounter and removed on unmount; the socket directory is this
      // provider's to create and own, and its liveness is what proves to a
      // later incarnation whether the bridge is gone.
      const sessionDirectory = join(sessionsDirectory, sessionId);
      const mounterSocketDir = join(sessionDirectory, '9p');
      await provideDirectory('Codex session 9P directory', mounterSocketDir);
      const workspaceRootPath = await resolveWorkspaceRoot(
        sessionId,
        spec.workspaceHostPath,
        join(sessionDirectory, 'tree'),
      );
      // Retained before it is established, so a failed mount is still closed
      // by the rollback below.
      projection = projectWorkspace(
        {
          workspaceRootPath,
          workspaceMountPoint: join(sessionDirectory, 'workspace'),
          mounterSocketDir,
          mounterEnv,
        },
        { env: mounterEnv },
      );
      await projection.mount();
      lease = makeExo(
        'CodexVolumeLease',
        M.interface('CodexVolumeLease', {
          unmount: M.callWhen().returns(M.any()),
        }),
        {
          unmount: async () => {
            if (!mounts.has(lease)) return;
            // The kernel mount outlives every process that knows about it,
            // so it comes down before the record that named it: a released
            // lease whose projection survived would let a successor mount a
            // second projection over the first.
            await projection.close();
            await registry.transaction(async (state, save) => {
              const record = Object.hasOwn(state.sessions, sessionId)
                ? state.sessions[sessionId]
                : undefined;
              if (record?.lease === leaseId) {
                delete record.lease;
                await save();
              }
            });
            mounts.delete(lease);
            if (active.get(sessionId) === leaseId) active.delete(sessionId);
          },
        },
      );
      mounts.set(lease, { sessionId, leaseId, projection });
      return lease;
    } catch (error) {
      active.delete(sessionId);
      // Admission failed, so nothing holds the projection; a kit closed here
      // takes down a mount it may have established a moment ago.
      if (projection) {
        try {
          await projection.close();
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            'Volume lease admission and workspace projection cleanup failed',
            { cause: closeError },
          );
        }
      }
      // Publication never happened, so a committed but unacknowledged lease
      // reservation can be retired without touching any successor lease.
      try {
        await registry.transaction(async (state, save) => {
          const record = Object.hasOwn(state.sessions, sessionId)
            ? state.sessions[sessionId]
            : undefined;
          if (record?.lease === leaseId) {
            delete record.lease;
            await save();
          }
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Volume lease admission and reservation cleanup failed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
  };
  const describe = async (lease, { sessionId }) => {
    const held = mounts.get(lease);
    held?.sessionId === sessionId || Fail`Invalid or retired volume lease`;
    return registry.transaction(async state => {
      checkRegistry(state);
      const record = Object.hasOwn(state.sessions, sessionId)
        ? state.sessions[sessionId]
        : undefined;
      (record?.phase === 'ready' && record.lease === held.leaseId) ||
        Fail`Session volumes are not ready or lease was revoked`;
      const stateVolume = record.volumes.find(
        volume => volume.role === 'state',
      );
      if (typeof stateVolume?.name !== 'string') {
        throw Fail`Session state volume is missing from its record`;
      }
      return harden({
        sessionId,
        stateVolume: stateVolume.name,
        // The workspace is not a volume: it is the host mount point of this
        // session's 9P projection, which the slice binds as an attested
        // attach rather than a host bind.
        workspaceMountPoint: held.projection.mountPoint,
      });
    });
  };
  const destroy = async ({ sessionId }) => {
    assertSession(sessionId);
    !active.has(sessionId) || Fail`Cannot destroy leased session volumes`;
    return registry.transaction(async (state, save) => {
      checkRegistry(state);
      const record = Object.hasOwn(state.sessions, sessionId)
        ? state.sessions[sessionId]
        : undefined;
      if (!record) return;
      !record.lease || Fail`Cannot destroy a durably leased session`;
      record.phase = 'deleting';
      await save();
      for (const volume of record.volumes) {
        if (!volume.removed) {
          await E(volumes).remove({
            name: volume.name,
            ownerId,
            sessionId,
            role: volume.role,
            identity: volume.identity,
          });
          volume.removed = true;
          await save();
        }
        // Never reuse project IDs: a crash or orphan cannot inherit a later
        // session's quota. Empty-project limit retirement is administrative.
      }
      delete state.sessions[sessionId];
      await save();
    });
  };
  // Call only after the previous daemon incarnation has stopped and its
  // owner-scoped container reaper has completed. Never automatic takeover.
  const recoverLease = async ({ sessionId }) =>
    registry.transaction(async (state, save) => {
      assertSession(sessionId);
      !active.has(sessionId) || Fail`Cannot recover a local live lease`;
      checkRegistry(state);
      const record = Object.hasOwn(state.sessions, sessionId)
        ? state.sessions[sessionId]
        : undefined;
      if (!record?.lease) return;
      for (const volume of record.volumes)
        await E(volumes).assertUnused({ name: volume.name });
      delete record.lease;
      await save();
    });
  return harden({
    recoverLease,
    makeWorkspace: ensure,
    mountWorkspace,
    volumeProvider: makeExo(
      'CodexVolumeProvider',
      M.interface('CodexVolumeProvider', {
        describe: M.callWhen(M.remotable(), { sessionId: M.string() }).returns(
          M.record(),
        ),
      }),
      { describe },
    ),
    destroy,
  });
};
harden(makeCodexDurableVolumeProvider);
