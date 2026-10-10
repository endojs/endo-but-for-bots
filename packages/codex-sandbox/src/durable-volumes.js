// @ts-check
/* eslint-disable no-await-in-loop -- Durable side effects must complete in recorded order. */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { execPath, pid } from 'node:process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { Fail, makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

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
 * @param {{directory: string, timeoutMs?: number, ownerReaper?: {reap(owner: {ownerPid:string,ownerStartTime:string,transactionId:string}): Promise<void>}}} options
 */
export const makeFileVolumeRegistry = async ({
  directory,
  timeoutMs = 60_000,
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
      '/usr/bin/flock',
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
          '/usr/bin/flock',
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
      '/usr/bin/flock',
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
const roles = harden(['workspace', 'state']);

/**
 * Durable session-volume state machine. The operator supplies rootless Podman
 * and a separately privileged quota allocator; these never reach the model.
 * Podman methods create ordinary volumes with ownership labels, inspect their
 * physical identity, and remove without force. Quota assignment is idempotent
 * for a reserved project ID and must refuse nonempty unowned directories.
 *
 * @param {{ownerId:string, projectIds:{first:number,last:number}, registry:any, volumes:any, quota:any}} powers
 */
export const makeCodexDurableVolumeProvider = ({
  ownerId,
  projectIds,
  registry,
  volumes,
  quota,
}) => {
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
  const mounts = new WeakMap();
  const active = new Map();
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
      !record?.lease || Fail`Session volumes have an outstanding durable lease`;
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
            hardBytes: `${(role === 'workspace' ? 8n : 4n) * 1024n ** 3n}`,
            ready: false,
          })),
        };
        if (nextProjectId + 2 > projectIds.last) state.exhausted = true;
        else state.nextProjectId = nextProjectId + 2;
        state.sessions[sessionId] = record;
        await save();
      }
      record.phase !== 'deleting' ||
        Fail`Session volume deletion must finish before reopening`;
      for (const volume of record.volumes) {
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
      lease = makeExo(
        'CodexVolumeLease',
        M.interface('CodexVolumeLease', {
          unmount: M.callWhen().returns(M.any()),
        }),
        {
          unmount: async () => {
            if (!mounts.has(lease)) return;
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
      mounts.set(lease, { sessionId, leaseId });
      return lease;
    } catch (error) {
      active.delete(sessionId);
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
    mounts.get(lease)?.sessionId === sessionId ||
      Fail`Invalid or retired volume lease`;
    return registry.transaction(async state => {
      checkRegistry(state);
      const record = Object.hasOwn(state.sessions, sessionId)
        ? state.sessions[sessionId]
        : undefined;
      (record?.phase === 'ready' &&
        record.lease === mounts.get(lease)?.leaseId) ||
        Fail`Session volumes are not ready or lease was revoked`;
      return harden({
        sessionId,
        workspaceVolume: record.volumes[0].name,
        stateVolume: record.volumes[1].name,
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
