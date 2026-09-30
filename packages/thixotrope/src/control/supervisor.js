// @ts-check
/**
 * The local supervisor: the process that owns a Thixotrope state directory
 * and turns it into a running workspace. It is the composition root beneath
 * `bin/thix.js` — the only module that assembles a daemon, the durable and
 * Unix netlayers, application and native-resource installation, and the
 * host services (clock, mailbox), and the only one that holds the engine
 * lease and the private control socket that authorizes administration.
 *
 * Three responsibilities are worth separating when reading it:
 *
 * - **Ownership.** One supervisor per state directory. The engine lease
 *   encloses socket lifetime, so a successor never serves a directory whose
 *   predecessor can still write it, and shutdown drains transient clients
 *   before releasing the store.
 * - **Workspace.** A single durable guest vat holds the user's inventory and
 *   the bindings an attached terminal evaluates against. Host services are
 *   provided lazily and granted into that vat by explicit inventory key,
 *   never ambiently.
 * - **Administration.** Each control-socket connection gets its own
 *   `ThixotropeLocalAdmin` facet over an OCapN session. Connection lifetime
 *   is an observer lifetime only: closing a terminal cancels its ephemeral
 *   subscriptions and leaves every durable guest listener in place.
 *
 * Everything durable lives in the daemon's store or the guest heap; this
 * file holds only the process-lifetime wiring between them.
 */
/** @import { PlatformPowers } from '../platform/powers.js' */
/** @import { FilePowers } from '../platform/files.js' */
/** @import { PromiseKit } from '@endo/promise-kit' */
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { PENDING_ANSWER_ABORTED_MESSAGE } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makePromiseKit } from '@endo/promise-kit';

import { makeInFlight } from '../in-flight.js';
import { settleWithin, withExpiry } from '../platform/timers.js';
import { randomHex128 } from '../random-id.js';
import { describeNativePackage } from '../native/describe-package.js';

import { makeApplicationRegistry } from './application-registry.js';
import { installNativeResource } from './install-native-resource.js';
import { makeDurableAlarms } from '../alarms/durable-alarms.js';
import { makeGuestClock } from '../alarms/guest-clock.js';
import { makeThixotropeDaemon } from '../core/daemon.js';
import { makeDurableNetLayer } from '../net/durable-netlayer.js';
import { makeIronhorseEngine } from '../ironhorse/ironhorse-engine.js';
import { readIronhorseLimits } from '../ironhorse/ironhorse-limits.js';
import { makeLocalControl } from './local-control.js';
import { makeInventoryViewLifetime } from './inventory-view-lifetime.js';
import { makeNativeResourceRegistry } from '../native/registry.js';
import { makeObservableMap } from '../observable-map.js';
import { makeMailbox } from '../mail/mailbox.js';
import { makeMailContact } from '../mail/mail-contact.js';
import { makeMailAddressBook } from '../mail/mail-address-book.js';
import { makeMailIntroductions } from '../mail/introductions.js';
import { makeFileSyncStringAtom } from '../store/file-sync-string-atom.js';
import { makeFsStore } from '../store/store-fs.js';
import {
  assertUnixPeerLocation,
  makeUnixNetLayer,
} from '../net/unix-netlayer.js';

/** @import { WorkerEngine } from '../core/worker-engine.js' */
/** @import { SocketConnection, SocketListener } from '../platform/sockets.js' */

// The shape of what the supervisor keeps in the workspace vat's heap. Guest
// closures the supervisor ships (the inventory, the registries, the clock,
// the mail address book) are frozen in the heap at first evaluation, so a
// build whose closures differ cannot serve an older workspace and refuses
// it rather than run new host code against old guest code.
// 3: alarm acknowledgement; 4: dedicated native manager vats; 5: the mail
// address book introduces contacts through the `mail-introductions` resource
// and its inbox and outbox are observable.
const WORKSPACE_VERSION = 5;

// sun_path on the strictest supported platform: 104 bytes including the NUL.
const MAX_SOCKET_PATH_BYTES = 103;
// A stuck installation cannot block `stop`: installations are resumable, so
// shutdown waits this long for an accepted one and then proceeds. This bounds
// the host-side phases (describing and bundling the package, booting the
// manager); a delivery stalled inside the workspace vat is bounded by the
// engine's request timeout, as every other delivery is.
const INSTALL_DRAIN_MS = 10_000;

/**
 * @param {FilePowers} files
 * @param {string} path
 * @param {unknown} value
 */
const save = async (files, path, value) => {
  await files.writeTextAtomic(path, `${JSON.stringify(value)}\n`);
};

/**
 * Run a single local supervisor. The engine lease encloses socket lifetime.
 * @param {PlatformPowers} platform
 * @param {string} statePath
 * @param {{engine?: WorkerEngine, idleSleepMs?: number, alarmNow?: () => bigint}} [options]
 */
export const serveThixotrope = async (
  platform,
  statePath,
  { engine, idleSleepMs = 30_000, alarmNow } = {},
) => {
  const {
    timers,
    random,
    logging,
    paths,
    files,
    syncFiles,
    processes,
    sockets,
    hashes,
    environment,
    display,
  } = platform;
  const log = logging.sub('thixotrope', 'supervisor');
  const randomId = () => randomHex128(random);
  statePath = paths.resolve(statePath);
  const socketPath = paths.join(statePath, 'control.sock');
  const peerPath = paths.join(statePath, 'peers.sock');
  // A Unix socket path is bounded by sun_path (104 bytes with its NUL on the
  // strictest platform). The peer path is checked again by every peer that
  // dials it; the control path is only ever bound here, so this is its one
  // check. Both are refused before the state directory is created, so a
  // path that can never serve leaves nothing behind.
  for (const path of [socketPath, peerPath]) {
    if (new TextEncoder().encode(path).length > MAX_SOCKET_PATH_BYTES) {
      throw Error(
        `Socket path exceeds ${MAX_SOCKET_PATH_BYTES} bytes; use a shorter state directory: ${path}`,
      );
    }
  }
  await files.makeDirectory(statePath, { mode: 0o700 });
  const stat = await files.stat(statePath);
  if (stat.kind !== 'directory' || !(await files.isPrivateToUser(statePath))) {
    throw Error(
      'The state directory must be a private directory owned by this user (mode 0700).',
    );
  }
  const packagePath = paths.fileURLToPath(new URL('../../', import.meta.url));
  const ironhorseLimits = engine ? undefined : readIronhorseLimits(environment);
  const rawEngine =
    engine ??
    makeIronhorseEngine(
      { processes, files, paths, timers, hashes },
      {
        ...ironhorseLimits,
        workerBinary:
          environment.get('THIXOTROPE_IRONHORSE_WORKER') ??
          paths.resolve(
            packagePath,
            '../../target/release/thixotrope-ironhorse-worker',
          ),
        bootPaths: ['boot.js', 'worker-peer.js'].map(name =>
          paths.join(packagePath, 'dist-ironhorse', name),
        ),
        storePath: paths.join(statePath, 'heaps'),
      },
    );
  if (!rawEngine.acquireStore)
    throw Error('Supervisor requires exclusive store ownership support');
  const configPath = paths.join(statePath, 'workspace.json');
  let config;
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
    const start = timers.monotonicNow();
    try {
      return await operation();
    } finally {
      metrics[name].count += 1n;
      metrics[name].milliseconds += timers.monotonicNow() - start;
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
  /** @type {Set<SocketConnection>} */
  const controlConnections = new Set();
  /**
   * Drop a control connection at once: a throw on the writer takes pending
   * reads and writes down with it, and `closed` resolves for the cleanup
   * registered on it.
   * @param {SocketConnection} connection
   */
  const drop = connection => {
    void connection.writer
      .throw(Error('Supervisor closed the connection'))
      .catch(() => {});
  };
  const pendingDisconnects = makeInFlight();
  /** @type {Map<SocketConnection, () => Promise<void>>} */
  const disconnectViews = new Map();
  /** @type {SocketListener | undefined} */
  let controlListener;
  let listening = false;
  let requested = false;
  // Settles when this supervisor has been asked to stop, by `stop`, a signal,
  // or a fatal condition; `serveThixotrope` hands the promise to its caller.
  /** @type {PromiseKit<void>} */
  const stopKit = makePromiseKit();
  const { promise: stopped } = stopKit;
  const requestStop = () => stopKit.resolve();
  let daemon;
  // The host keeps deadlines and unacknowledged outcomes, with one timer for
  // the earliest deadline. It calls nothing; settling a promise resource
  // wakes whichever vat was listening on it.
  const alarms = makeDurableAlarms(
    { timers },
    {
      storage: makeFileSyncStringAtom(
        syncFiles,
        paths.join(statePath, 'alarms.json'),
      ),
      makeResource: (name, description) =>
        daemon.makeResource(name, description),
      retireResource: (name, description) =>
        daemon.retireResource(name, description),
      ...(alarmNow === undefined ? {} : { now: alarmNow }),
    },
  );
  /** @type {Awaited<ReturnType<typeof makeUnixNetLayer>> | undefined} */
  let peerNetlayer;
  const closePeers = async () => {
    peerNetlayer?.shutdown();
    await peerNetlayer?.closed;
  };
  const closeSocket = () => {
    for (const connection of controlConnections) drop(connection);
  };
  const closeControl = async () => {
    if (!listening || !controlListener) return;
    listening = false;
    const { closed } = controlListener;
    controlListener.close();
    const viewCleanup = Promise.allSettled(
      [...disconnectViews.values()].map(disconnect => disconnect()),
    );
    // Flush the stop acknowledgement, then bound the wait for clients to close.
    for (const connection of controlConnections) {
      void connection.writer.return(undefined).catch(() => {});
    }
    await withExpiry(timers, 1000, closeSocket, () => closed);
    // A failed guest may never settle subscription setup or cancellation.
    // Continue to daemon shutdown after a grace period; startup discards any
    // ephemeral registrations that survive in the guest's persistent image.
    await settleWithin(
      timers,
      1000,
      Promise.all([viewCleanup, pendingDisconnects.drain()]),
    );
    await files.remove(socketPath, { force: true });
  };

  try {
    daemon = await makeThixotropeDaemon(
      { timers, random, logging },
      {
        store: makeFsStore({ syncFiles, paths }, statePath),
        engine: measured,
        nativeWorkers: platform.nativeWorkers,
        codec: syrupCodec,
        idleSleepMs,
        validateState: async () => {
          try {
            config = JSON.parse(await files.readText(configPath));
          } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
              throw error;
          }
          if (config !== undefined && config.version !== WORKSPACE_VERSION) {
            throw Error(
              `Incompatible workspace metadata: this build requires version ${WORKSPACE_VERSION}; migrate or use a fresh state directory`,
            );
          }
        },
        // Re-arm the host timer from the durable table once every worker
        // session is seated and before any vat is notified, so an alarm
        // already past its deadline settles as part of startup, with its
        // listener seated, rather than at some later point after it.
        beforeStartNotices: () => alarms.start(),
        onRetireWorker: workerId => {
          alarms.retireWorker(workerId);
        },
        resources: {
          alarm: alarms.resource,
          alarms: alarms.clockResource,
          // Makers run while the endpoint restores, before `daemon` is
          // assigned and before the netlayer exists, so every use of the
          // daemon is deferred to the call.
          'mail-introductions': () =>
            makeMailIntroductions({
              publish: value => daemon.publish(value),
              unpublish: secret => daemon.unpublish(secret),
              importReference: (location, secret) =>
                daemon.importReference(location, secret),
              location: () => daemon.location,
              assertLocation: location =>
                assertUnixPeerLocation({ syncFiles, paths }, location),
            }),
        },
        makeNetlayer: async ({ handlers, logger, resumption }) => {
          // makeThixotropeDaemon already holds the exclusive engine lease.
          await files.remove(peerPath, { force: true });
          return makeDurableNetLayer(
            { timers, random },
            {
              handlers,
              logger,
              resumption,
              makeBaseNetlayer: async networkPowers => {
                peerNetlayer = await makeUnixNetLayer(
                  { sockets, syncFiles, paths },
                  {
                    ...networkPowers,
                    socketPath: peerPath,
                  },
                );
                return peerNetlayer;
              },
            },
          );
        },
      },
    );

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
        version: WORKSPACE_VERSION,
        workerId,
        publication: `workspace-${workerId}`,
        initialized: false,
      };
      await save(files, configPath, config);
    }
    if (
      config?.version !== WORKSPACE_VERSION ||
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
      await save(files, configPath, config);
    }
    let inventory;
    let applications;
    if (
      !daemon
        .inspectWorkers()
        .find(worker => worker.workerId === config.workerId)?.failure
    ) {
      inventory = await workspace.evaluate(
        `(globalThis.inventory ??= (${makeObservableMap.toString()})())`,
      );
      await E(inventory).disconnectEphemeral();
      applications = await workspace.evaluate(
        `(globalThis.apps ??= (${makeApplicationRegistry.toString()})(vats, inventory))`,
      );
    }
    // Only the lock owner may reclaim the socket left by a dead supervisor.
    await files.remove(socketPath, { force: true });
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
            .then(evaluator => E(evaluator).evaluate(${JSON.stringify(`(${makeMailbox.toString()})((${makeObservableMap.toString()}))`)}));
          const mailbox = await globalThis.mailbox;
          if (!inventory.has('contacts')) {
            inventory.set('contacts', (${makeObservableMap.toString()})());
          }
          const mail = (${makeMailAddressBook.toString()})(
            mailbox, inventory.get('contacts'), (${makeMailContact.toString()}), introductions
          );
          if (!inventory.has('mail')) inventory.set('mail', mail);
          return mail;
        })())`,
        { introductions: daemon.makeResource('mail-introductions') },
      );
      // Supervisor restart is a lifetime boundary for view subscriptions on
      // the mailbox, as it is for the inventory's.
      mailboxAddressBook = opening.then(async book => {
        await workspace.evaluate(
          'E(mailbox).disconnectEphemeral().then(() => true)',
        );
        return book;
      });
      // Failed initialization can be repaired in the workspace. Do not pin a
      // rejected attempt in the host after the user repairs its durable root.
      const wrapped = mailboxAddressBook;
      void wrapped.catch(() => {
        if (mailboxAddressBook === wrapped) mailboxAddressBook = undefined;
      });
      return wrapped;
    };
    /**
     * The clock lives in the workspace vat, holding its own promises and
     * cleanup acknowledgements. The host keeps deadlines and unacknowledged outcomes.
     *
     * One clock shared through the inventory, as before: a consumer that wants
     * its own can be granted the alarm facet directly, but the grant users know
     * is a clock.
     *
     * @type {Promise<any> | undefined}
     */
    let workspaceClock;
    const getClock = () => {
      if (workspaceClock) return workspaceClock;
      const opening = workspace.evaluate(
        `(globalThis.clock ??= (${makeGuestClock.toString()})(alarms, { restartMessage }))`,
        {
          alarms: daemon.makeResource('alarms', { workerId: config.workerId }),
          restartMessage: PENDING_ANSWER_ABORTED_MESSAGE,
        },
      );
      workspaceClock = opening;
      void opening.catch(() => {
        if (workspaceClock === opening) workspaceClock = undefined;
      });
      return opening;
    };

    if (inventory !== undefined) {
      await workspace.evaluate(
        `(globalThis.nativeResources ??= (${makeNativeResourceRegistry.toString()})(inventory), true)`,
      );
    }

    let installingNative = Promise.resolve();
    const adminMethods = {
      help: () =>
        'Local supervisor: evaluate(source), status(), stop(), install(name, bundle, grants), applications(), installNative(name, directory), clockGrant(key), alarmStatus(), reachability(), collect(), inventoryStatus(), invite(name), accept(name, invitationText), revokeInvitation(invitationText), contacts(), inbox(), outbox(), send(name, text, key), takeMessage(id, key), discardMessage(id); each connection also has watchInventory(listener).',
      evaluate: async source => {
        if (requested) throw Error('Supervisor is stopping');
        if (typeof source !== 'string')
          throw Error('Expected JavaScript source');
        const value = await workspace.evaluate(source);
        return display.describe(value);
      },
      status: () =>
        harden({
          workspace: config.workerId,
          ...(ironhorseLimits ? { ironhorse: ironhorseLimits } : {}),
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
        timers.setTimer(requestStop, 0);
        return 'Stopping supervisor';
      },
      install: async (name, bundle, grants) => {
        if (requested) throw Error('Supervisor is stopping');
        if (applications === undefined)
          throw Error(
            'The workspace vat is quarantined; repair it before installing',
          );
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
        const digest = hashes.sha256Hex(new TextEncoder().encode(bundle));
        await E(applications).install(name, bundle, digest, grants);
        return (await E(applications).list()).find(
          entry => entry.name === name,
        );
      },
      applications: () => {
        if (applications === undefined)
          throw Error('The workspace vat is quarantined; repair it first');
        return E(applications).list();
      },
      reachability: () => daemon.inspectReachability(),
      // An allocation has no guest root until its facade reaches the registry.
      // Serialize collection with installations across that short boundary.
      collect: () => {
        const collecting = installingNative.then(() => daemon.collectVats());
        installingNative = collecting.then(
          () => {},
          () => {},
        );
        return collecting;
      },
      inventoryStatus: () => {
        if (inventory === undefined)
          throw Error('The workspace vat is quarantined; repair it first');
        return E(inventory).subscriptionCounts();
      },
      installNative: (name, directory) => {
        const installing = installingNative.then(async () => {
          if (requested) throw Error('Supervisor is stopping');
          if (inventory === undefined)
            throw Error(
              'The workspace vat is quarantined; repair it before installing',
            );
          if (typeof directory !== 'string')
            throw Error('Expected a native resource directory');
          const description = await describeNativePackage(
            { files, paths, hashes },
            paths.resolve(directory),
          );
          const { bundle, digest: bundleDigest } =
            await platform.bundler.bundle(description.durablePath);
          const checked = await describeNativePackage(
            { files, paths, hashes },
            description.directory,
          );
          if (checked.digest !== description.digest)
            throw Error('Native package changed during installation');
          const digest = hashes.sha256Hex(
            new TextEncoder().encode(
              JSON.stringify([
                description.directory,
                description.digest,
                bundleDigest,
              ]),
            ),
          );
          await installNativeResource(daemon, workspace, {
            name,
            digest,
            allocationKey: randomId(),
            bundle,
            adapters: daemon.makeResource('native-adapter', {
              moduleUrl: description.moduleUrl,
              packageIdentity: {
                directory: description.directory,
                digest: description.digest,
              },
            }),
          });
          return harden({ name, directory: description.directory, digest });
        });
        installingNative = installing.then(
          () => {},
          () => {},
        );
        return installing;
      },
      clockGrant: async key => {
        if (requested) throw Error('Supervisor is stopping');
        if (typeof key !== 'string' || !key.length || key.length > 128)
          throw Error('Invalid inventory key');
        const clock = await getClock();
        await workspace.evaluate('(inventory.set(key, clock), true)', {
          key,
          clock,
        });
        return true;
      },
      alarmStatus: () => {
        const status = alarms.status();
        // Plain numbers: the CLI prints this record as JSON, and each count
        // is bounded by the alarm table's row limit. `pending` rows are still
        // armed; `retained` counts every row the table holds, armed or
        // settled and awaiting the clock's acknowledgement.
        return harden({
          pending: Number(status.armed),
          retained: Number(status.retained),
          materialised: Number(status.materialised),
          stopped: status.stopped,
        });
      },
      invite: name => E(getMailbox()).invite(name),
      accept: (name, invitationText) =>
        E(getMailbox()).accept(name, invitationText),
      revokeInvitation: invitationText =>
        E(getMailbox()).revokeInvitation(invitationText),
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
      takeMessage: async (id, key) => {
        if (typeof key !== 'string' || !key.length)
          throw Error('Expected inventory key');
        await getMailbox();
        return workspace.evaluate(
          'E(mailbox).take(id).then(value => { inventory.set(key, value); return true; })',
          { id, key },
        );
      },
      discardMessage: id => E(getMailbox()).discard(id),
    };
    controlListener = await sockets.listenPath({
      path: socketPath,
      mode: 0o600,
      onConnection: connection => {
        if (requested) {
          drop(connection);
          return;
        }
        controlConnections.add(connection);
        const view = makeInventoryViewLifetime(timers, inventory);
        const disconnect = () => {
          disconnectViews.delete(connection);
          return view.disconnect();
        };
        disconnectViews.set(connection, disconnect);
        void connection.closed.then(() => {
          controlConnections.delete(connection);
          const cleanup = disconnect().catch(error => {
            // A quarantined vat cannot run cancellation; its ephemeral
            // listeners will be discarded if it is ever recovered in a new
            // supervisor.
            if (!requested) log.error('inventory disconnect:', error.message);
          });
          pendingDisconnects.track(cleanup);
        });
        const admin = Far('ThixotropeLocalAdmin', {
          ...adminMethods,
          watchInventory: listener => {
            if (requested) throw Error('Connection is closing');
            return view.watch(listener);
          },
        });
        void makeLocalControl(
          { sockets, random },
          connection,
          'worker',
          admin,
        ).catch(() => drop(connection));
      },
      onError: error => {
        log.error('control listener failed:', error);
      },
    });
    listening = true;
    let closing;
    const close = () => {
      closing ??= (async () => {
        requested = true;
        // Remove the endpoint while still holding the lease. A successor's
        // socket must never be removed by this process after ownership passes.
        try {
          await settleWithin(timers, INSTALL_DRAIN_MS, installingNative);
          await closeControl();
        } finally {
          try {
            try {
              alarms.shutdown();
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
        alarms.shutdown();
      } finally {
        await closePeers();
        await daemon?.crash();
      }
    }
    throw error;
  }
};
harden(serveThixotrope);
