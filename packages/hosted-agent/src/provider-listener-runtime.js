// @ts-check

import { E } from '@endo/eventual-send';
import { Fail, makeError, X } from '@endo/errors';
import {
  readNetworkNamespace,
  readNamespaceIdentities,
  readProcessStatus,
} from '@endo/sandbox/observe.js';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { makeProviderPipe } from './provider-pipe.js';

const execute = promisify(execFile);
const LABEL = 'io.endo.provider.owner';
/**
 * @param {Promise<any>} promise
 * @param {number} milliseconds
 */
const deadline = async (promise, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(makeError(X`Provider runtime timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
};
/** @param {number} pid */
const readStart = async pid => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return /^\d+$/.test(start) ? start : null;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return null;
    throw error;
  }
};

/**
 * Concrete rootless Podman listener owner. The only byte channel to the worker
 * is inherited stdin/stdout. The pinned listener image contains no credential.
 * Its process namespaces remain separate from model slices sharing only netns.
 * Host powers are injectable exclusively for controlled tests.
 *
 * @param {object} options
 * @param {string} options.imageRef Pinned listener image, including its SHA-256 digest.
 * @param {string} options.ownerId Stable operator-owned cleanup scope.
 * @param {string} options.stateDirectory Private directory for a process lock.
 * @param {number} [options.maxListeners]
 * @param {any} [options.host] Trusted host powers, never session inputs.
 */
export const makePodmanProviderListenerRuntime = async ({
  imageRef,
  ownerId,
  stateDirectory,
  host = {},
  maxListeners = 16,
}) => {
  (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(ownerId) &&
    /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(imageRef)) ||
    Fail`Invalid provider runtime identity`;
  (Number.isInteger(maxListeners) && maxListeners > 0 && maxListeners <= 256) ||
    Fail`Invalid listener capacity`;
  const imageDigest = imageRef.slice(imageRef.indexOf('@') + 1);
  // Host-side rootless Podman configuration, never container environment.
  // Proxy and credential variables are deliberately excluded.
  const hostEnvironment = Object.fromEntries(
    ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .filter(name => process.env[name] !== undefined)
      .map(name => [name, process.env[name]]),
  );
  hostEnvironment.PATH ??= '/usr/bin:/bin';
  const run =
    host.run ??
    (args =>
      execute('podman', args, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        killSignal: 'SIGKILL',
        env: hostEnvironment,
      }));
  const launch =
    host.launch ??
    (args =>
      spawn('podman', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: hostEnvironment,
      }));
  const procfs =
    host.procfs ??
    harden({
      readFile: path => readFile(path, 'utf8'),
      readLink: path => readlink(path),
    });
  const processStart = host.readStart ?? readStart;
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDirectory);
  // eslint-disable-next-line no-bitwise
  const sharedPermissions = directory.mode & 0o077;
  (directory.isDirectory() &&
    directory.uid === process.getuid?.() &&
    sharedPermissions === 0) ||
    Fail`Provider runtime state directory is not private`;
  const start = await processStart(process.pid);
  start !== null || Fail`Provider runtime requires a procfs process identity`;
  const identity = `${process.pid}-${start}`;
  const lockPath = join(stateDirectory, `${ownerId}.lock`);
  try {
    await symlink(identity, lockPath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST')
      throw error;
    const recoveryPath = join(stateDirectory, `${ownerId}.recover`);
    // Serialize stale-owner recovery. An abandoned recovery directory refuses
    // admission for operator repair; it never licenses two live owners.
    await mkdir(recoveryPath, { mode: 0o700 });
    try {
      const previous = await readlink(lockPath);
      const match = /^(\d+)-(\d+)$/.exec(previous);
      if (!match) throw makeError(X`Invalid provider runtime lock`);
      const previousStart = await processStart(Number(match[1]));
      previousStart !== match[2] ||
        Fail`Provider runtime owner is already active`;
      await unlink(lockPath);
      await symlink(identity, lockPath);
    } finally {
      await rmdir(recoveryPath);
    }
  }
  /** @type {Set<() => Promise<void>>} */
  const cleanup = new Set();
  /** @type {Set<() => Promise<void>>} */
  const pendingCleanup = new Set();
  let released = false;
  let disposed = false;
  let queue = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const retryCleanup = async () => {
    await null;
    for (const clean of [...pendingCleanup]) {
      // eslint-disable-next-line no-await-in-loop
      await clean();
    }
  };
  const remove = async name => {
    await run(['rm', '-f', '--ignore', '--time', '1', name]);
  };
  try {
    const old = await run([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL}=${ownerId}`,
    ]);
    for (const id of old.stdout.trim().split(/\s+/).filter(Boolean)) {
      /^[a-f0-9]{12,64}$/.test(id) || Fail`Invalid orphan identity`;
      // Inspect exact owner before deletion; no prefix matches confer ownership.
      // eslint-disable-next-line no-await-in-loop
      const { stdout } = await run(['inspect', '--format', '{{json .}}', id]);
      JSON.parse(stdout).Config?.Labels?.[LABEL] === ownerId ||
        Fail`Orphan ownership mismatch`;
      // eslint-disable-next-line no-await-in-loop
      await remove(id);
    }
  } catch (error) {
    await unlink(lockPath);
    throw error;
  }
  const startListener = ({ endpoint, limits }) =>
    serialize(async () => {
      !disposed || Fail`Provider runtime disposed`;
      await retryCleanup();
      cleanup.size < maxListeners || Fail`Provider listener capacity exceeded`;
      const name = `endo-provider-${randomUUID()}`;
      let child;
      let pipe;
      let control;
      let stopping;
      let live = false;
      let channelClosed = false;
      let namespaceId;
      const stop = () => {
        if (stopping) return stopping;
        live = false;
        pendingCleanup.add(stop);
        stopping = (async () => {
          if (control) await deadline(E(control).stop(), 1000).catch(() => {});
          pipe?.close();
          // Container removal, not killing only the attached podman CLI, reaps
          // the isolated worker. Failure retains this closure for a retry.
          await remove(name);
          if (child) await deadline(child.finished, 5000);
          cleanup.delete(stop);
          pendingCleanup.delete(stop);
        })().catch(error => {
          stopping = undefined;
          throw error;
        });
        return stopping;
      };
      cleanup.add(stop);
      try {
        const subprocess = launch([
          'run',
          '--pull=never',
          '-i',
          '--name',
          name,
          '--label',
          `${LABEL}=${ownerId}`,
          '--network=none',
          '--pid=private',
          '--ipc=private',
          // Rootless Podman establishes its mapped user namespace; admission
          // verifies its identity instead of requesting a nested empty map.
          '--user',
          '1000:1000',
          '--read-only',
          '--read-only-tmpfs=false',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--memory=256m',
          '--memory-swap=256m',
          '--pids-limit=64',
          '--cpus=1',
          '--ulimit',
          'nofile=1024:1024',
          '--ulimit',
          'core=0:0',
          '--env',
          'HOME=/home/node',
          '--env',
          'LANG=C.UTF-8',
          '--env',
          'LC_ALL=C.UTF-8',
          '--entrypoint=node',
          imageRef,
          '/opt/endo-provider-worker.mjs',
        ]);
        const finished = new Promise(resolve => {
          subprocess.once('error', () => resolve(undefined));
          subprocess.once('close', () => resolve(undefined));
        });
        child = { process: subprocess, finished };
        let errorBytes = 0;
        subprocess.stderr.on('data', chunk => {
          errorBytes += chunk.byteLength;
          if (errorBytes <= 4096) host.onStderr?.(chunk);
          if (errorBytes > 4096) pipe?.close();
        });
        pipe = makeProviderPipe({
          input: subprocess.stdout,
          output: subprocess.stdin,
          bootstrap: harden({ endpoint, limits }),
        });
        void pipe.closed.then(() => {
          channelClosed = true;
          live = false;
        });
        control = await deadline(pipe.getBootstrap(), 10_000);
        const ready = await deadline(E(control).ready(), 10_000);
        (ready.protocol === 'ProviderListenerV1' &&
          /^http:\/\/127\.0\.0\.1:\d+$/.test(ready.endpoint)) ||
          Fail`Provider listener handshake failed`;
        const observe = async () => {
          live || Fail`Provider listener inactive`;
          const { stdout } = await run([
            'inspect',
            '--format',
            '{{json .}}',
            name,
          ]);
          const inspected = JSON.parse(stdout);
          /** @type {unknown} */
          const pid = inspected.State?.Pid;
          if (typeof pid !== 'number')
            throw makeError(X`Provider listener PID missing`);
          (inspected.State?.Running === true &&
            Number.isInteger(pid) &&
            pid > 0 &&
            inspected.ImageDigest === imageDigest &&
            inspected.Config?.Labels?.[LABEL] === ownerId &&
            inspected.HostConfig?.NetworkMode === 'none' &&
            inspected.HostConfig?.ReadonlyRootfs === true) ||
            Fail`Provider listener process identity mismatch`;
          const [network, namespaces, posture] = await Promise.all([
            readNetworkNamespace(procfs, pid),
            readNamespaceIdentities(procfs, pid),
            readProcessStatus(procfs, pid),
          ]);
          (network.interfaces.length === 1 &&
            network.interfaces[0] === 'lo' &&
            network.routableRoutes === 0 &&
            Object.values(namespaces).every(value => value.unshared) &&
            posture.uid === 1000 &&
            posture.gid === 1000 &&
            posture.noNewPrivs === true &&
            posture.seccompMode === 2 &&
            posture.effectiveCapabilities === 0n &&
            posture.permittedCapabilities === 0n &&
            posture.boundingCapabilities === 0n &&
            (!namespaceId || namespaceId === network.namespaceId)) ||
            Fail`Provider listener isolation is not proved`;
          const final = JSON.parse(
            (await run(['inspect', '--format', '{{json .}}', name])).stdout,
          );
          (live &&
            !channelClosed &&
            final.State?.Running === true &&
            final.State?.Pid === pid &&
            final.ImageDigest === imageDigest &&
            final.Config?.Labels?.[LABEL] === ownerId) ||
            Fail`Provider listener changed during observation`;
          namespaceId = network.namespaceId;
          return harden({
            endpoint: ready.endpoint,
            containerName: name,
            networkNamespaceId: namespaceId,
            listenerImageDigest: imageDigest,
          });
        };
        !channelClosed || Fail`Provider listener channel closed`;
        live = true;
        await observe();
        !channelClosed || Fail`Provider listener channel closed`;
        void pipe.closed.then(() => stop()).catch(() => {});
        return harden({ observe, stop, closed: pipe.closed });
      } catch (error) {
        await stop().catch(cleanupError => {
          throw AggregateError(
            [error, cleanupError],
            'Provider listener startup and cleanup failed',
          );
        });
        throw AggregateError([error], 'Provider listener startup failed');
      }
    });
  return harden({
    start: startListener,
    retryCleanup: () => serialize(retryCleanup),
    dispose: () =>
      serialize(async () => {
        if (released) return;
        disposed = true;
        for (const clean of cleanup) pendingCleanup.add(clean);
        await retryCleanup();
        const current = await readlink(lockPath);
        current === identity || Fail`Provider runtime lock ownership changed`;
        await unlink(lockPath);
        released = true;
      }),
  });
};
harden(makePodmanProviderListenerRuntime);
