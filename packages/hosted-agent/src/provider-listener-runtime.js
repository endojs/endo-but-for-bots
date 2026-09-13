// @ts-check

import { E } from '@endo/eventual-send';
import { Fail, makeError, X } from '@endo/errors';
import { makePodmanHostEnvironment } from '@endo/sandbox/podman-host-environment.js';
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
  open,
} from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { makeProviderPipe } from './provider-pipe.js';

/** @import { FileHandle } from 'node:fs/promises' */

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
 * Construct an inert rootless Podman listener owner. Retain the kit before
 * open(); close() fences admission and retains failed initialization cleanup
 * and listener release for retry. The operator owns persistent directory and
 * resolver contents; this kit releases native handles and ownership markers.
 * Direct listener release requires the original child's close event. Other
 * Podman command completion and stale-owner recovery limits are unchanged.
 * The only byte channel to the worker
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
 * @param {Record<string,string>} [options.env] Operator host environment overrides, never guest env.
 * @param {boolean} [options.publicInternet] Operator enables optional public listeners.
 */
export const makePodmanProviderListenerRuntimeKit = ({
  imageRef,
  ownerId,
  stateDirectory,
  host = {},
  env = {},
  maxListeners = 16,
  publicInternet = false,
}) => {
  (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(ownerId) &&
    /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(imageRef)) ||
    Fail`Invalid provider runtime identity`;
  (Number.isInteger(maxListeners) && maxListeners > 0 && maxListeners <= 256) ||
    Fail`Invalid listener capacity`;
  const imageDigest = imageRef.slice(imageRef.indexOf('@') + 1);
  typeof publicInternet === 'boolean' ||
    Fail`Invalid public network configuration`;
  const hostEnvironment = makePodmanHostEnvironment(process.env, env);
  // Low-level injection preserves the default argv/environment construction in
  // tests. High-level run/launch remain trusted complete host implementations.
  const execute = host.executeFile ?? promisify(execFile);
  const spawnChild = host.spawn ?? spawn;
  const run =
    host.run ??
    (args =>
      execute('podman', ['--remote=false', '--syslog=false', ...args], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        killSignal: 'SIGKILL',
        env: hostEnvironment,
      }));
  const launch =
    host.launch ??
    (args =>
      spawnChild('podman', ['--remote=false', '--syslog=false', ...args], {
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
  /** @type {Set<() => Promise<void>>} */
  const cleanup = new Set();
  /** @type {Set<() => Promise<void>>} */
  const pendingCleanup = new Set();
  let disposed = false;
  let initialized = false;
  let lockOwned = false;
  let recoveryOwned = false;
  let sweepRequired = false;
  /** @type {string | undefined} */
  let identity;
  /** @type {FileHandle | undefined} */
  let resolverFile;
  /** @type {Promise<typeof runtime> | undefined} */
  let opening;
  /** @type {Promise<void> | undefined} */
  let closing;
  const lockPath = join(stateDirectory, `${ownerId}.lock`);
  const recoveryPath = join(stateDirectory, `${ownerId}.recover`);
  const resolverConfigPath = join(stateDirectory, 'public-resolv.conf');
  const openFile = host.open ?? open;
  const removeLink = host.unlink ?? unlink;
  const removeRecovery = host.rmdir ?? rmdir;
  const assertOpen = () => {
    !disposed || Fail`Provider runtime disposed`;
  };
  const closeResolver = async () => {
    if (resolverFile) {
      await resolverFile.close();
      resolverFile = undefined;
    }
  };
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
  const sweep = async () => {
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
  };
  const initialize = async () => {
    assertOpen();
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    assertOpen();
    const directory = await lstat(stateDirectory);
    // eslint-disable-next-line no-bitwise
    const sharedPermissions = directory.mode & 0o077;
    (directory.isDirectory() &&
      directory.uid === process.getuid?.() &&
      sharedPermissions === 0) ||
      Fail`Provider runtime state directory is not private`;
    assertOpen();
    const start = await processStart(process.pid);
    start !== null || Fail`Provider runtime requires a procfs process identity`;
    identity = `${process.pid}-${start}`;
    assertOpen();
    const resolverContents =
      'nameserver 127.0.0.53\noptions attempts:1 timeout:2\n';
    if (publicInternet) {
      try {
        resolverFile = await openFile(resolverConfigPath, 'wx', 0o444);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST')
          throw error;
      }
      if (resolverFile) {
        assertOpen();
        await resolverFile.writeFile(resolverContents);
        assertOpen();
        await resolverFile.chmod(0o444);
        await closeResolver();
      }
      const resolverStat = await lstat(resolverConfigPath);
      // eslint-disable-next-line no-bitwise
      const resolverMode = resolverStat.mode & 0o777;
      (resolverStat.isFile() &&
        resolverStat.uid === process.getuid?.() &&
        resolverMode === 0o444 &&
        (await readFile(resolverConfigPath, 'utf8')) === resolverContents) ||
        Fail`Public resolver configuration is not immutable`;
    }
    assertOpen();
    try {
      await symlink(identity, lockPath);
      lockOwned = true;
      sweepRequired = true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST')
        throw error;
      // Serialize stale-owner recovery. An abandoned recovery directory refuses
      // admission for operator repair; it never licenses two live owners.
      assertOpen();
      await mkdir(recoveryPath, { mode: 0o700 });
      recoveryOwned = true;
      try {
        const previous = await readlink(lockPath);
        const match = /^(\d+)-(\d+)$/.exec(previous);
        if (!match) throw makeError(X`Invalid provider runtime lock`);
        const previousStart = await processStart(Number(match[1]));
        previousStart !== match[2] ||
          Fail`Provider runtime owner is already active`;
        assertOpen();
        await removeLink(lockPath);
        await symlink(identity, lockPath);
        lockOwned = true;
        sweepRequired = true;
      } finally {
        await removeRecovery(recoveryPath);
        recoveryOwned = false;
      }
    }
    assertOpen();
    await sweep();
    sweepRequired = false;
    assertOpen();
    initialized = true;
  };
  /**
   * Retain one listener's cleanup before its queued acquisition. This uses the
   * runtime's existing admission queue, listener capacity and cleanup sets.
   * stop() targets only this acquisition, including failed startup; it fences
   * immediately and never equates rejection with native release.
   * @param {{endpoint:any,limits:any,network?:{endpoint:any}}} configuration
   */
  const startKit = ({ endpoint, limits, network = undefined }) => {
    const name = `endo-provider-${randomUUID()}`;
    let child;
    let pipe;
    let control;
    /** @type {Promise<void> | undefined} */
    let stopping;
    let admitted = false;
    let acquiring = true;
    let inactive = false;
    let cleaned = false;
    let live = false;
    let channelClosed = false;
    let namespaceId;
    let networkEvidence;
    const assertAdmission = () => {
      assertOpen();
      !inactive || Fail`Provider listener inactive`;
    };
    /** @returns {Promise<void>} */
    const stop = () => {
      inactive = true;
      live = false;
      // Closing the private pipe can unblock a pending handshake. The final
      // removal still waits for this acquisition to settle, not its public
      // result (whose rejection handler itself requests cleanup).
      if (acquiring) pipe?.close();
      if (cleaned) return Promise.resolve();
      if (stopping) return stopping;
      if (admitted) pendingCleanup.add(stop);
      stopping = (async () => {
        await acquisition.catch(() => {});
        if (admitted) {
          if (control) await deadline(E(control).stop(), 1000).catch(() => {});
          pipe?.close();
          // Retain the runtime's existing native removal/closure contract;
          // this per-listener owner does not add descendant-quiescence proof.
          await remove(name);
          if (child) await deadline(child.finished, 5000);
          cleanup.delete(stop);
          pendingCleanup.delete(stop);
        }
        cleaned = true;
      })().catch(error => {
        stopping = undefined;
        throw error;
      });
      return stopping;
    };
    const acquisition = serialize(async () => {
      if (network !== undefined) {
        (publicInternet && network.endpoint) ||
          Fail`Public network is not configured by the operator`;
      }
      assertAdmission();
      initialized || Fail`Provider runtime is not open`;
      await retryCleanup();
      assertAdmission();
      cleanup.size < maxListeners || Fail`Provider listener capacity exceeded`;
      cleanup.add(stop);
      admitted = true;
      const subprocess = launch([
        'run',
        '--http-proxy=false',
        '--pull=never',
        '-i',
        '--name',
        name,
        '--label',
        `${LABEL}=${ownerId}`,
        '--network=none',
        ...(network ? ['--sysctl=net.ipv4.ip_unprivileged_port_start=0'] : []),
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
        subprocess.once('close', () => resolve(undefined));
      });
      child = { process: subprocess, finished };
      // A process error rejects admission but does not prove native stdio has
      // closed. Keep observing errors until the original close event arrives.
      subprocess.on('error', () => {
        channelClosed = true;
        live = false;
        pipe?.close();
      });
      // Drain stderr for the child's entire lifetime. Diagnostics get only a
      // copied prefix; log volume has no authority to close the inference pipe.
      let diagnosticBytesRemaining = host.onStderr ? 4096 : 0;
      subprocess.stderr.on('data', chunk => {
        if (diagnosticBytesRemaining === 0) return;
        const preview = Uint8Array.from(
          chunk.subarray(0, diagnosticBytesRemaining),
        );
        diagnosticBytesRemaining -= preview.byteLength;
        host.onStderr?.(preview);
      });
      pipe = makeProviderPipe({
        input: subprocess.stdout,
        output: subprocess.stdin,
        bootstrap: harden({
          endpoint,
          limits,
          ...(network ? { network } : {}),
        }),
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
        const [observedNetwork, namespaces, posture] = await Promise.all([
          readNetworkNamespace(procfs, pid),
          readNamespaceIdentities(procfs, pid),
          readProcessStatus(procfs, pid),
        ]);
        (observedNetwork.interfaces.length === 1 &&
          observedNetwork.interfaces[0] === 'lo' &&
          observedNetwork.routableRoutes === 0 &&
          Object.values(namespaces).every(value => value.unshared) &&
          posture.uid === 1000 &&
          posture.gid === 1000 &&
          posture.noNewPrivs === true &&
          posture.seccompMode === 2 &&
          posture.effectiveCapabilities === 0n &&
          posture.permittedCapabilities === 0n &&
          posture.boundingCapabilities === 0n &&
          (!namespaceId || namespaceId === observedNetwork.namespaceId)) ||
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
        namespaceId = observedNetwork.namespaceId;
        return harden({
          endpoint: ready.endpoint,
          containerName: name,
          networkNamespaceId: namespaceId,
          listenerImageDigest: imageDigest,
          ...(networkEvidence ? { network: networkEvidence } : {}),
        });
      };
      assertAdmission();
      !channelClosed || Fail`Provider listener channel closed`;
      live = true;
      await observe();
      if (network) {
        const activated = await deadline(E(control).activateNetwork(), 10_000);
        const proxy = new URL(activated.proxyUrl);
        (activated.policy === 'public-internet' &&
          activated.dnsHost === '127.0.0.53' &&
          proxy.protocol === 'http:' &&
          proxy.hostname === '127.0.0.1' &&
          proxy.port !== '' &&
          proxy.username === '' &&
          proxy.password === '' &&
          proxy.pathname === '/' &&
          proxy.search === '' &&
          proxy.hash === '') ||
          Fail`Public network listener handshake failed`;
        networkEvidence = harden({
          policy: 'public-internet',
          proxyUrl: proxy.origin,
          dnsHost: '127.0.0.53',
          resolverConfigPath,
        });
        await observe();
      }
      !channelClosed || Fail`Provider listener channel closed`;
      void pipe.closed.then(() => stop()).catch(() => {});
      assertAdmission();
      return harden({ observe, stop, closed: pipe.closed });
    }).finally(() => {
      acquiring = false;
    });
    const value = acquisition.catch(async error => {
      if (!admitted) throw error;
      await stop().catch(cleanupError => {
        throw AggregateError(
          [error, cleanupError],
          'Provider listener startup and cleanup failed',
        );
      });
      throw AggregateError([error], 'Provider listener startup failed');
    });
    // A lifecycle owner may observe stop() without consuming the failed value.
    void value.catch(() => {});
    return harden({ value, stop });
  };
  /** @returns {Promise<void>} */
  const close = () => {
    disposed = true;
    if (closing) return closing;
    const attempt = (async () => {
      await opening?.catch(() => {});
      await serialize(async () => {
        for (const clean of cleanup) pendingCleanup.add(clean);
        await retryCleanup();
        await closeResolver();
        // A failed initialization sweep is retained as cleanup work. Its
        // historical failure does not prevent a successful explicit retry.
        if (sweepRequired) {
          await sweep();
          sweepRequired = false;
        }
        if (lockOwned) {
          const current = await readlink(lockPath);
          current === identity || Fail`Provider runtime lock ownership changed`;
          await removeLink(lockPath);
          lockOwned = false;
        }
        if (recoveryOwned) {
          await removeRecovery(recoveryPath);
          recoveryOwned = false;
        }
      });
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };
  const runtime = harden({
    /** @param {Parameters<typeof startKit>[0]} configuration */
    start: configuration => startKit(configuration).value,
    startKit,
    retryCleanup: () => serialize(retryCleanup),
    dispose: close,
  });
  const openRuntime = () => {
    assertOpen();
    opening ??= Promise.resolve().then(async () => {
      await initialize();
      return runtime;
    });
    return opening;
  };
  return harden({ open: openRuntime, close });
};
harden(makePodmanProviderListenerRuntimeKit);

/**
 * Transitional convenience constructor. A failed startup whose rollback also
 * fails does not return a cleanup handle. Native owners must retain the inert
 * kit before open() to retain failed cleanup for explicit retry.
 * @param {Parameters<typeof makePodmanProviderListenerRuntimeKit>[0]} options
 */
export const makePodmanProviderListenerRuntime = async options => {
  const kit = makePodmanProviderListenerRuntimeKit(options);
  try {
    return await kit.open();
  } catch (error) {
    try {
      await kit.close();
    } catch (cleanupError) {
      throw AggregateError(
        [error, cleanupError],
        'Provider runtime startup and cleanup failed',
      );
    }
    throw error;
  }
};
harden(makePodmanProviderListenerRuntime);
