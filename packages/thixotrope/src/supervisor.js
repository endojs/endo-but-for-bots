// @ts-check
/** @import { NodePowers } from './platform/node-powers.js' */
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeApplicationRegistry } from './application-registry.js';
import { makeClockService } from './clock-service.js';
import { makeThixotropeDaemon } from './daemon.js';
import { makeDurableNetLayer } from './durable-netlayer.js';
import { makeIronhorseEngine } from './ironhorse-engine.js';
import { makeLocalControl } from './local-control.js';
import { makeInventoryViewLifetime } from './inventory-view-lifetime.js';
import { makeHttpServices } from './http-services.js';
import { makeObservableInventory } from './observable-inventory.js';
import { makeMailbox } from './mailbox.js';
import { makeMailContact } from './mail-contact.js';
import { makeMailAddressBook } from './mail-address-book.js';
import { makeFileSyncStringAtom } from './file-sync-string-atom.js';
import { makeFsStore } from './store-fs.js';
import { assertUnixPeerLocation, makeUnixNetLayer } from './unix-netlayer.js';

/** @import { WorkerEngine } from './worker-engine.js' */
/** @import { Socket } from 'node:net' */

/**
 * @param {NodePowers} powers
 * @param {string} path
 * @param {unknown} value
 */
const save = async (powers, path, value) => {
  const { open, rename } = powers.fsPromises;
  const { resolve } = powers.path;
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
 * @param {NodePowers} powers
 * @param {string} statePath
 * @param {{engine?: WorkerEngine, idleSleepMs?: number, alarmNow?: () => bigint}} [options]
 */
export const serveThixotrope = async (
  powers,
  statePath,
  { engine, idleSleepMs = 30_000, alarmNow } = {},
) => {
  const { chmod, lstat, mkdir, readFile, rm } = powers.fsPromises;
  const { join, resolve } = powers.path;
  const { createServer } = powers.net;
  const { createHash } = powers.crypto;
  const { process, performance, console } = powers;
  const { inspect } = powers.util;
  const { fileURLToPath } = powers.url;
  const { setTimeout, clearTimeout, setImmediate } = powers.timers;
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
    makeIronhorseEngine(powers, {
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
    httpServices ??= makeHttpServices(powers, {
      storage: makeFileSyncStringAtom(
        powers,
        join(statePath, 'http-services.json'),
      ),
      publish: (handler, secret) => daemon.publish(handler, secret),
      unpublish: secret => daemon.unpublish(secret),
      openClient: () => daemon.openEphemeralClient(),
    });
    return httpServices;
  };
  /** @type {ReturnType<typeof makeClockService> | undefined} */
  let clockService;
  const provideClockService = () => {
    clockService ??= makeClockService(powers, {
      storage: makeFileSyncStringAtom(powers, join(statePath, 'clock.json')),
      getDaemon: () => daemon,
      ...(alarmNow === undefined ? {} : { now: alarmNow }),
    });
    return clockService;
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
    daemon = await makeThixotropeDaemon(powers, {
      store: makeFsStore(powers, statePath),
      engine: measured,
      codec: syrupCodec,
      idleSleepMs,
      resources: {
        'alarm-scheduler': description =>
          provideClockService().resource(description),
        'http-listener': description =>
          provideHttpServices().resource(description),
      },
      makeNetlayer: async ({ handlers, logger, resumption }) => {
        // makeThixotropeDaemon already holds the exclusive engine lease.
        await rm(peerPath, { force: true });
        return makeDurableNetLayer(powers, {
          handlers,
          logger,
          resumption,
          makeBaseNetlayer: async networkPowers => {
            peerNetlayer = await makeUnixNetLayer(powers, {
              ...networkPowers,
              socketPath: peerPath,
            });
            return peerNetlayer;
          },
        });
      },
    });
    await provideHttpServices().start();
    await provideClockService().start();
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
      await save(powers, configPath, config);
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
      await save(powers, configPath, config);
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
    // The workspace owns the durable root. Reuse its presence during this host
    // lifetime instead of journaling another evaluator call for every command.
    /** @type {Promise<any> | undefined} */
    let mailboxAddressBook;
    const getMailbox = () => {
      if (mailboxAddressBook) return mailboxAddressBook;
      const opening = workspace.evaluate(
        `(globalThis.mailAddressBook ??= (async () => {
          globalThis.mailbox ??= E(vats).createWorker('mailbox')
            .then(worker => E(worker).getEvaluator())
            .then(evaluator => E(evaluator).evaluate(${JSON.stringify(`(${makeMailbox.toString()})()`)}));
          const mailbox = await globalThis.mailbox;
          if (!inventory.has('contacts')) {
            inventory.set('contacts', (${makeObservableInventory.toString()})());
          }
          return (${makeMailAddressBook.toString()})(
            mailbox, inventory.get('contacts'), (${makeMailContact.toString()})
          );
        })())`,
      );
      mailboxAddressBook = opening;
      // Failed initialization can be repaired in the workspace. Do not pin a
      // rejected attempt in the host after the user repairs its durable root.
      void opening.catch(() => {
        if (mailboxAddressBook === opening) mailboxAddressBook = undefined;
      });
      return opening;
    };
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
        location: assertUnixPeerLocation(powers, invitation.location),
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
      clockGrant: async key => {
        if (requested) throw Error('Supervisor is stopping');
        if (typeof key !== 'string' || !key.length || key.length > 128)
          throw Error('Invalid inventory key');
        const clock = await provideClockService().getClock();
        await workspace.evaluate('(inventory.set(key, clock), true)', {
          key,
          clock,
        });
        return true;
      },
      alarmStatus: () => {
        const status = provideClockService().status();
        return harden({
          ...status,
          ...status.scheduler,
          error: status.error ?? status.scheduler?.error,
        });
      },
      invite: async name => {
        const { invitation, identity } =
          await E(getMailbox()).inviteWithIdentity(name);
        const secret = daemon.publish(invitation);
        // The publication's cancellation authority follows its identity even
        // if the user renames or removes the address-book entry later.
        await workspace.evaluate(
          '((globalThis.mailInvitations ??= new Map()).set(secret, identity), true)',
          { secret, identity },
        );
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
        await workspace.evaluate(
          `(async () => {
            const identity = globalThis.mailInvitations?.get(secret);
            if (identity) {
              await E(identity).cancelInvitation();
              mailInvitations.delete(secret);
            }
            return true;
          })()`,
          { secret: invitation.secret },
        );
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
          'E(mailAddressBook).send(name, text, inventory.get(key))',
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
      const view = makeInventoryViewLifetime(powers, inventory);
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
      void makeLocalControl(powers, socket, 'worker', admin).catch(() =>
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
              try {
                await clockService?.shutdown();
              } finally {
                await httpServices?.shutdown();
              }
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
        try {
          await clockService?.shutdown();
        } finally {
          await httpServices?.shutdown();
        }
      } finally {
        await closePeers();
        await daemon?.crash();
      }
    }
    throw error;
  }
};
harden(serveThixotrope);
