// @ts-check
/* global setImmediate */
import { Far } from '@endo/far';
import harden from '@endo/harden';
import { syrupCodec } from '@endo/ocapn/syrup';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';
import process from 'node:process';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';

import { makeThixotropeDaemon } from './daemon.js';
import { makeIronhorseEngine } from './ironhorse-engine.js';
import { makeLocalControl } from './local-control.js';
import { makeFsStore } from './store-fs.js';

/** @import { WorkerEngine } from './worker-engine.js' */

/**
 * @param {string} path
 * @param {unknown} value
 */
const save = async (path, value) => {
  const file = await open(`${path}.tmp`, 'w', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(`${path}.tmp`, path);
  const directory = await open(resolve(path, '..'), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

/**
 * Run a single local supervisor. The engine lease encloses socket lifetime.
 * @param {string} statePath
 * @param {{engine?: WorkerEngine, idleSleepMs?: number}} [options]
 */
export const serveThixotrope = async (
  statePath,
  { engine, idleSleepMs = 30_000 } = {},
) => {
  statePath = resolve(statePath);
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  const stat = await lstat(statePath);
  if (
    !stat.isDirectory() ||
    // Unix permission bits.
    // eslint-disable-next-line no-bitwise
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  ) {
    throw Error(
      'The state directory must be a private directory owned by this user (mode 0700).',
    );
  }
  const socketPath = join(statePath, 'control.sock');
  const packagePath = fileURLToPath(new URL('../', import.meta.url));
  const rawEngine =
    engine ??
    makeIronhorseEngine({
      workerBinary:
        process.env.THIXOTROPE_IRONHORSE_WORKER ??
        resolve(
          packagePath,
          '../../target/release/thixotrope-ironhorse-worker',
        ),
      bootPaths: ['boot.js', 'worker-peer.js'].map(name =>
        join(packagePath, 'dist-ironhorse', name),
      ),
      storePath: join(statePath, 'heaps'),
    });
  if (!rawEngine.acquireStore)
    throw Error('Supervisor requires exclusive store ownership support');
  const metrics = {
    delivery: { count: 0n, milliseconds: 0 },
    snapshot: { count: 0n, milliseconds: 0 },
    wake: { count: 0n, milliseconds: 0 },
  };
  /**
   * @template T
   * @param {keyof typeof metrics} name
   * @param {() => Promise<T>} operation
   */
  const timed = async (name, operation) => {
    const start = performance.now();
    try {
      return await operation();
    } finally {
      metrics[name].count += 1n;
      metrics[name].milliseconds += performance.now() - start;
    }
  };
  const measured = harden({
    ...rawEngine,
    start: async options => {
      const worker = await timed('wake', () => rawEngine.start(options));
      return harden({
        ...worker,
        deliver: bytes => timed('delivery', () => worker.deliver(bytes)),
        snapshot: () => timed('snapshot', () => worker.snapshot()),
      });
    },
  });
  const sockets = new Set();
  const server = createServer();
  let listening = false;
  let requested = false;
  let requestStop;
  const stopped = new Promise(resolveStop => {
    requestStop = resolveStop;
  });
  let daemon;
  const closeSocket = () => {
    for (const socket of sockets) socket.destroy();
  };
  const closeControl = async () => {
    if (!listening) return;
    listening = false;
    const closed = new Promise(resolveClose =>
      server.close(() => resolveClose(undefined)),
    );
    // Flush the stop acknowledgement, then bound the wait for clients to close.
    for (const socket of sockets) socket.end();
    const timer = setTimeout(closeSocket, 1000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
    await rm(socketPath, { force: true });
  };

  try {
    daemon = await makeThixotropeDaemon({
      store: makeFsStore(statePath),
      engine: measured,
      codec: syrupCodec,
      idleSleepMs,
      makeNetlayer: async () =>
        harden({
          location: harden({
            type: 'ocapn-peer',
            network: 'thix-local',
            transport: 'thix-local',
            designator: 'supervisor',
            hints: false,
          }),
          shutdown: closeSocket,
        }),
    });
    const configPath = join(statePath, 'workspace.json');
    let config;
    try {
      config = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw error;
    }
    if (config === undefined) {
      // createWorker records the label with its id. Recover that allocation
      // if a crash occurred before workspace.json selected it.
      const candidates = daemon
        .inspectWorkers()
        .filter(worker => worker.debugLabel === 'workspace');
      if (candidates.length > 1)
        throw Error('Ambiguous interrupted workspace initialization');
      const workerId =
        candidates.length === 1
          ? candidates[0].workerId
          : (await daemon.createWorker({ debugLabel: 'workspace' })).workerId;
      config = {
        version: 1,
        workerId,
        publication: `workspace-${workerId}`,
        initialized: false,
      };
      await save(configPath, config);
    }
    if (
      config?.version !== 1 ||
      !daemon.listWorkerIds().includes(config.workerId) ||
      config.publication !== `workspace-${config.workerId}` ||
      typeof config.initialized !== 'boolean'
    )
      throw Error('Invalid workspace metadata');
    const workspace = daemon.getWorker(config.workerId);
    // Metadata selects the vat before initialization. Repeating initialization
    // after a crash reuses its globals instead of replacing retained values.
    if (!config.initialized) {
      const root = await workspace.evaluate(
        "(globalThis.vats ??= controller, globalThis.workspaceRoot ??= Far('Workspace', { help: () => 'Persistent workspace' }))",
        { controller: daemon.makeResource('worker-controller') },
      );
      daemon.publish(root, config.publication);
      await workspace.sleep();
      config.initialized = true;
      await save(configPath, config);
    }
    // Only the lock owner may reclaim the socket left by a dead supervisor.
    await rm(socketPath, { force: true });
    const admin = Far('ThixotropeLocalAdmin', {
      help: () => 'Local supervisor: evaluate(source), status(), stop().',
      evaluate: async source => {
        if (requested) throw Error('Supervisor is stopping');
        if (typeof source !== 'string')
          throw Error('Expected JavaScript source');
        const value = await workspace.evaluate(source);
        return inspect(value, {
          customInspect: false,
          getters: false,
          depth: 3,
        });
      },
      status: () =>
        harden({
          workspace: config.workerId,
          workers: daemon.inspectWorkers(),
          timings: Object.fromEntries(
            Object.entries(metrics).map(([name, metric]) => [
              name,
              {
                count: String(metric.count),
                milliseconds: metric.milliseconds,
              },
            ]),
          ),
        }),
      stop: () => {
        setImmediate(requestStop);
        return 'Stopping supervisor';
      },
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      void makeLocalControl(socket, 'worker', admin).catch(() =>
        socket.destroy(),
      );
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolveListen(undefined);
      });
    });
    listening = true;
    await chmod(socketPath, 0o600);
    let closing;
    const close = () => {
      closing ??= (async () => {
        requested = true;
        // Remove the endpoint while still holding the lease. A successor's
        // socket must never be removed by this process after ownership passes.
        try {
          await closeControl();
        } finally {
          try {
            await daemon.shutdown();
          } finally {
            closeSocket();
            requestStop();
          }
        }
      })();
      return closing;
    };
    return harden({ socketPath, stopped, close });
  } catch (error) {
    try {
      await closeControl();
    } finally {
      closeSocket();
      await daemon?.crash();
    }
    throw error;
  }
};
harden(serveThixotrope);
