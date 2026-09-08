// @ts-check
/* global setImmediate */
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { syrupCodec } from '@endo/ocapn/syrup';
import { createHash } from 'node:crypto';
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

import { makeApplicationRegistry } from './application-registry.js';
import { makeThixotropeDaemon } from './daemon.js';
import { makeDurableNetLayer } from './durable-netlayer.js';
import { makeIronhorseEngine } from './ironhorse-engine.js';
import { makeLocalControl } from './local-control.js';
import { makeInventoryViewLifetime } from './inventory-view-lifetime.js';
import { makeHttpServices } from './http-services.js';
import { makeObservableInventory } from './observable-inventory.js';
import { makeMailbox } from './mailbox.js';
import { makeFsStore } from './store-fs.js';
import { assertUnixPeerLocation, makeUnixNetLayer } from './unix-netlayer.js';

/** @import { WorkerEngine } from './worker-engine.js' */
/** @import { Socket } from 'node:net' */

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
  const peerPath = join(statePath, 'peers.sock');
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
  /** @type {Set<Promise<void>>} */
  const pendingDisconnects = new Set();
  /** @type {Map<Socket, () => Promise<void>>} */
  const disconnectViews = new Map();
  const server = createServer();
  let listening = false;
  let requested = false;
  let requestStop;
  const stopped = new Promise(resolveStop => {
    requestStop = resolveStop;
  });
  let daemon;
  /** @type {ReturnType<typeof makeHttpServices> | undefined} */
  let httpServices;
  const provideHttpServices = () => {
    httpServices ??= makeHttpServices({
      statePath,
      publish: (handler, secret) => daemon.publish(handler, secret),
      unpublish: secret => daemon.unpublish(secret),
      openClient: () => daemon.openEphemeralClient(),
    });
    return httpServices;
  };
  /** @type {Awaited<ReturnType<typeof makeUnixNetLayer>> | undefined} */
  let peerNetlayer;
  const closePeers = async () => {
    peerNetlayer?.shutdown();
    await peerNetlayer?.closed;
  };
  const closeSocket = () => {
    for (const socket of sockets) socket.destroy();
  };
  const closeControl = async () => {
    if (!listening) return;
    listening = false;
    const closed = new Promise(resolveClose =>
      server.close(() => resolveClose(undefined)),
    );
    const viewCleanup = Promise.allSettled(
      [...disconnectViews.values()].map(disconnect => disconnect()),
    );
    // Flush the stop acknowledgement, then bound the wait for clients to close.
    for (const socket of sockets) socket.end();
    const timer = setTimeout(closeSocket, 1000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
    // A failed guest may never settle subscription setup or cancellation.
    // Continue to daemon shutdown after a grace period; startup discards any
    // ephemeral registrations that survive in the guest's persistent image.
    let cleanupTimer;
    try {
      await Promise.race([
        Promise.all([viewCleanup, ...pendingDisconnects]),
        new Promise(resolveCleanup => {
          cleanupTimer = setTimeout(resolveCleanup, 1000);
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
    await rm(socketPath, { force: true });
  };

  try {
    daemon = await makeThixotropeDaemon({
      store: makeFsStore(statePath),
      engine: measured,
      codec: syrupCodec,
      idleSleepMs,
      resources: {
        'http-listener': description =>
          provideHttpServices().resource(description),
      },
      makeNetlayer: async ({ handlers, logger, resumption }) => {
        // makeThixotropeDaemon already holds the exclusive engine lease.
        await rm(peerPath, { force: true });
        return makeDurableNetLayer({
          handlers,
          logger,
          resumption,
          makeBaseNetlayer: async powers => {
            peerNetlayer = await makeUnixNetLayer({
              ...powers,
              socketPath: peerPath,
            });
            return peerNetlayer;
          },
        });
      },
    });
    await provideHttpServices().start();
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
    let inventory;
    let applications;
    if (
      !daemon
        .inspectWorkers()
        .find(worker => worker.workerId === config.workerId)?.failure
    ) {
      inventory = await workspace.evaluate(
        `(globalThis.inventory ??= (${makeObservableInventory.toString()})())`,
      );
      await E(inventory).disconnectEphemeral();
      applications = await workspace.evaluate(
        `(globalThis.apps ??= (${makeApplicationRegistry.toString()})(vats, inventory))`,
      );
    }
    // Only the lock owner may reclaim the socket left by a dead supervisor.
    await rm(socketPath, { force: true });
    const getMailbox = () =>
      workspace.evaluate(
        `(globalThis.mailbox ??= E(vats).createWorker('mailbox').then(worker => E(worker).getEvaluator()).then(evaluator => E(evaluator).evaluate(${JSON.stringify(`(${makeMailbox.toString()})()`)})))`,
      );
    /** @param {unknown} text */
    const parseInvitation = text => {
      if (typeof text !== 'string' || text.length > 4096)
        throw Error('Invalid invitation');
      const invitation = JSON.parse(text);
      const name = /** @type {unknown} */ (invitation?.name);
      if (
        invitation?.version !== 1 ||
        typeof invitation.secret !== 'string' ||
        !/^[0-9a-f]{32}$/.test(invitation.secret) ||
        typeof name !== 'string' ||
        !name.length ||
        name.length > 128
      )
        throw Error('Invalid invitation');
      return {
        ...invitation,
        location: assertUnixPeerLocation(invitation.location),
      };
    };
    const adminMethods = {
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
      install: async (name, bundle, grants) => {
        if (requested) throw Error('Supervisor is stopping');
        if (typeof bundle !== 'string') throw Error('Expected module bundle');
        // Keep decoding and forwarding below the current guest crank budget.
        // This is a conservative admission profile, not a JS source-size limit.
        if (
          new TextEncoder().encode(JSON.stringify([name, bundle, grants]))
            .length >
          16 * 1024
        )
          throw Error(
            'Installation payload exceeds the current 16 KiB profile',
          );
        const digest = createHash('sha256').update(bundle).digest('hex');
        await E(applications).install(name, bundle, digest, grants);
        return (await E(applications).list()).find(
          entry => entry.name === name,
        );
      },
      applications: () => E(applications).list(),
      reachability: () => daemon.inspectReachability(),
      collect: () => daemon.collectVats(),
      inventoryStatus: () => E(inventory).subscriptionCounts(),
      httpGrant: async (key, port) => {
        if (requested) throw Error('Supervisor is stopping');
        if (typeof key !== 'string' || !key.length)
          throw Error('Expected inventory key');
        const description = provideHttpServices().allocate(port);
        const listener = daemon.makeResource('http-listener', description);
        await workspace.evaluate('(inventory.set(key, listener), true)', {
          key,
          listener,
        });
        return E(listener).status();
      },
      httpServices: () => provideHttpServices().list(),
      invite: async name => {
        const invitation = await E(getMailbox()).invite(name);
        const secret = daemon.publish(invitation);
        return JSON.stringify({
          version: 1,
          location: daemon.location,
          secret,
          name,
        });
      },
      connect: async (name, invitationText) => {
        const invitation = parseInvitation(invitationText);
        const remote = await daemon.importReference(
          invitation.location,
          invitation.secret,
        );
        return E(getMailbox()).connect(name, remote);
      },
      revokeInvitation: async text => {
        const invitation = parseInvitation(text);
        if (invitation.location.designator !== peerPath)
          throw Error('Invitation belongs to another supervisor');
        await E(getMailbox()).cancelInvitation(invitation.name);
        daemon.unpublish(invitation.secret);
        return true;
      },
      contacts: () => E(getMailbox()).contacts(),
      inbox: () => E(getMailbox()).inbox(),
      outbox: () => E(getMailbox()).outbox(),
      send: async (name, text, key) => {
        // Resolve the grant in the workspace so only the explicitly selected
        // value crosses into the mailbox vat.
        await getMailbox();
        return workspace.evaluate(
          'E(mailbox).send(name, text, inventory.get(key))',
          { name, text, key },
        );
      },
      takeOffer: async (id, key) => {
        if (typeof key !== 'string' || !key.length)
          throw Error('Expected inventory key');
        await getMailbox();
        return workspace.evaluate(
          'E(mailbox).take(id).then(value => { inventory.set(key, value); return true; })',
          { id, key },
        );
      },
      discardOffer: id => E(getMailbox()).discard(id),
    };
    server.on('connection', socket => {
      if (requested) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      const view = makeInventoryViewLifetime(inventory);
      const disconnect = () => {
        disconnectViews.delete(socket);
        return view.disconnect();
      };
      disconnectViews.set(socket, disconnect);
      socket.once('close', () => {
        sockets.delete(socket);
        const cleanup = disconnect().catch(error => {
          // A quarantined vat cannot run cancellation; its ephemeral listeners
          // will be discarded if it is ever recovered in a new supervisor.
          if (!requested) console.error('Inventory disconnect:', error.message);
        });
        pendingDisconnects.add(cleanup);
        void cleanup.finally(() => pendingDisconnects.delete(cleanup));
      });
      const admin = Far('ThixotropeLocalAdmin', {
        ...adminMethods,
        watchInventory: listener => {
          if (requested) throw Error('Connection is closing');
          return view.watch(listener);
        },
      });
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
            try {
              await httpServices?.shutdown();
            } finally {
              await closePeers();
              await daemon.shutdown();
            }
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
      try {
        await httpServices?.shutdown();
      } finally {
        await closePeers();
        await daemon?.crash();
      }
    }
    throw error;
  }
};
harden(serveThixotrope);
