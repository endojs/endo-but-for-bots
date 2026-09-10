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
  open,
} from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';

import { makeProviderPipe } from './provider-pipe.js';
import { providerNetworkBootstrap } from './provider-network-bootstrap.js';

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
 * @param {{address: string, bootstrapImageRef: string}} [options.publicInternet] Operator-owned synthetic IPv4 address and pinned helper image.
 */
export const makePodmanProviderListenerRuntime = async ({
  imageRef,
  ownerId,
  stateDirectory,
  host = {},
  maxListeners = 16,
  publicInternet,
}) => {
  (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(ownerId) &&
    /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(imageRef)) ||
    Fail`Invalid provider runtime identity`;
  (Number.isInteger(maxListeners) && maxListeners > 0 && maxListeners <= 256) ||
    Fail`Invalid listener capacity`;
  const imageDigest = imageRef.slice(imageRef.indexOf('@') + 1);
  if (publicInternet !== undefined) {
    (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(publicInternet.address) &&
      /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(
        publicInternet.bootstrapImageRef,
      )) ||
      Fail`Invalid public network bootstrap configuration`;
    const assigned = (host.networkInterfaces ?? networkInterfaces)();
    Object.values(assigned)
      .flatMap(items => /** @type {any[]} */ (items || []))
      .some(item => item.address === publicInternet.address) ||
      Fail`Synthetic proxy address must be assigned to this operator host`;
    harden(publicInternet);
  }
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
  const resolverConfigPath = join(stateDirectory, 'public-resolv.conf');
  const resolverContents =
    'nameserver 127.0.0.53\noptions attempts:1 timeout:2\n';
  if (publicInternet) {
    try {
      const file = await open(resolverConfigPath, 'wx', 0o444);
      try {
        await file.writeFile(resolverContents);
        await file.chmod(0o444);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST')
        throw error;
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
  /** @param {{endpoint:any,limits:any,network?:{endpoint:any,address:string}}} configuration */
  const startListener = ({ endpoint, limits, network = undefined }) =>
    serialize(async () => {
      if (network !== undefined) {
        (publicInternet &&
          network.address === publicInternet.address &&
          network.endpoint) ||
          Fail`Public network is not configured by the operator`;
      }
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
      let networkEvidence;
      let helperName;
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
          if (helperName) await remove(helperName);
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
          ...(network
            ? ['--sysctl=net.ipv4.ip_unprivileged_port_start=0']
            : []),
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
        !channelClosed || Fail`Provider listener channel closed`;
        live = true;
        await observe();
        if (network) {
          if (!publicInternet) throw Error('Public network unavailable');
          helperName = `endo-provider-${randomUUID()}`;
          const result = await run([
            'run',
            '--rm',
            '--pull=never',
            '--name',
            helperName,
            '--label',
            `${LABEL}=${ownerId}`,
            '--network',
            `container:${name}`,
            '--pid=private',
            '--ipc=private',
            '--user=0',
            '--read-only',
            '--read-only-tmpfs=false',
            '--cap-drop=ALL',
            '--cap-add=NET_ADMIN',
            '--security-opt=no-new-privileges',
            '--memory=64m',
            '--memory-swap=64m',
            '--pids-limit=16',
            '--cpus=1',
            '--ulimit',
            'nofile=64:64',
            '--ulimit',
            'core=0:0',
            '--entrypoint=python3',
            publicInternet.bootstrapImageRef,
            '-I',
            '-c',
            providerNetworkBootstrap,
            publicInternet.address,
          ]);
          result.stdout.trim() === 'EndoPublicProxyAddressV1' ||
            Fail`Public network bootstrap failed`;
          await remove(helperName);
          helperName = undefined;
          const activated = await deadline(
            E(control).activateNetwork(),
            10_000,
          );
          const proxy = new URL(activated.proxyUrl);
          (activated.policy === 'public-internet' &&
            activated.dnsHost === '127.0.0.53' &&
            proxy.protocol === 'http:' &&
            proxy.hostname === publicInternet.address &&
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
