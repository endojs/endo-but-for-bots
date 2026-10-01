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
 *   provided at every start and granted into that vat by explicit inventory key,
 *   never ambiently.
 * - **Administration.** Each control-socket connection gets its own
 *   `ThixotropeLocalAdmin` facet over an OCapN session. Connection lifetime
 *   is an observer lifetime only: closing a terminal cancels its ephemeral
 *   subscriptions and leaves every durable guest listener in place.
 *
 * Everything durable lives in the daemon's store or the guest heap; this
 * file holds only the process-lifetime wiring between them.
 */
/** @import { ThixotropeDaemon } from '../core/daemon.js' */
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
import { describeNativeResource } from '../native/describe-resource.js';
import { randomHex128 } from '../random-id.js';
import { makeSerialQueue } from '../serial-queue.js';

import { evaluateSource } from '../core/evaluate-source.js';
import { makeInstallationIndex } from './installation-index.js';
import { makeInstaller } from './installer.js';
import { makeRegistry } from './registry.js';
import { makeWorkspaceAccess } from './workspace-access.js';
import { makeThixotropeDaemon } from '../core/daemon.js';
import { makeFileSyncStringAtom } from '../store/file-sync-string-atom.js';
import { make as makeClock } from '../../resources/clock/durable.js';
import { makeDurableNetLayer } from '../net/durable-netlayer.js';
import { makeIronhorseEngine } from '../ironhorse/ironhorse-engine.js';
import { readIronhorseLimits } from '../ironhorse/ironhorse-limits.js';
import { makeLocalControl } from './local-control.js';
import { makeInventoryViewLifetime } from './inventory-view-lifetime.js';
import { makeObservableMap } from '../observable-map.js';
import { makeMailbox } from '../mail/mailbox.js';
import { makeMailContact } from '../mail/mail-contact.js';
import { makeMailAddressBook } from '../mail/mail-address-book.js';
import { makeMailIntroductions } from '../mail/introductions.js';
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
// 4: dedicated native manager vats; 5: the mail address book introduces
// contacts through the `mail-introductions` resource and its inbox and outbox
// are observable; 6: a manager's adapter launcher is described by the
// manager, so retiring the manager closes its processes; 7: one
// `installations` registry for applications and native resources, whose
// values live in the inventory under their names; 8: the clock and the
// mailbox are installations the supervisor provides, each in its own vat;
// 9: native adapters are launched from bundles stored under their digest,
// which the launcher's description names in place of a directory, and the
// clock is a native resource, with no host alarm ledger; 10: the
// installation registry is the host's, in a registry vat of its own with an
// index beside it, and a workspace only resolves grants and holds values.
const WORKSPACE_VERSION = 10;
// The daemon takes allocation keys from the host alone, so a fixed key names
// the host's own registry vat and nothing else can carry it.
const REGISTRY_ALLOCATION_KEY = '00000000000000000000000000000001';

// sun_path on the strictest supported platform: 104 bytes including the NUL.
const MAX_SOCKET_PATH_BYTES = 103;
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
 * @param {{engine?: WorkerEngine, idleSleepMs?: number}} [options]
 */
export const serveThixotrope = async (
  platform,
  statePath,
  { engine, idleSleepMs = 30_000 } = {},
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
  /** @type {PromiseKit<ThixotropeDaemon>} */
  const daemonKit = makePromiseKit();
  // A daemon that fails to start rejects the kit for the host calls waiting
  // on it; the failure itself is the caller's, so the kit's copy is handled.
  void daemonKit.promise.catch(() => {});
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
    const store = makeFsStore({ syncFiles, paths }, statePath);
    // Collection takes its turn with a vat allocation in flight, which has
    // no root until its facade is answered; the registry vat itself
    // serialises installations and removals, and roots the vat of an
    // installation it is driving.
    const serialized = makeSerialQueue();
    // Vats the installer has handed out that the registry vat has not yet
    // named in a later call: nothing roots one until the registry holds its
    // facade, so a collection is told to keep them.
    /** @type {Set<string>} */
    const allocating = new Set();
    // The host's own record of installations, written by the registry vat
    // at every step and read here when that vat cannot answer; loaded under
    // the store lease, with the workspace metadata.
    /** @type {ReturnType<typeof makeInstallationIndex>} */
    let index;
    daemon = await makeThixotropeDaemon(
      { timers, random, logging },
      {
        store,
        engine: measured,
        nativeWorkers: platform.nativeWorkers,
        codec: syrupCodec,
        idleSleepMs,
        // A bundle an installation has put in the store but not yet staged
        // is named by the index until it is.
        retainBundles: () =>
          index
            .list()
            .flatMap(entry =>
              [
                entry.bundleDigest,
                entry.durableDigest,
                entry.ephemeralDigest,
              ].filter(digest => typeof digest === 'string'),
            ),
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
          const atom = makeFileSyncStringAtom(
            syncFiles,
            paths.join(statePath, 'installations.json'),
          );
          index = makeInstallationIndex(
            harden({
              read: atom.read,
              // Written under the store lease only, like every store write.
              /** @param {string} text */
              write: text => {
                rawEngine.assertStoreOwnership?.();
                atom.write(text);
              },
            }),
          );
        },
        resources: {
          installer: () =>
            makeInstaller({
              daemon: daemonKit.promise,
              store,
              serialize: serialized,
              allocating,
            }),
          'installation-index': () => index.resource(),
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
    ).then(
      built => {
        daemonKit.resolve(built);
        return built;
      },
      error => {
        daemonKit.reject(error);
        throw error;
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
    // The registry vat is the host's: allocated under a fixed key, so every
    // start finds the same vat with no record to lose, and published under
    // a name only the host knows, as a retention root. Publishing is
    // idempotent, so it is made at every start rather than recorded.
    const registryWorker = await daemon.createWorker({
      debugLabel: 'registry',
      allocationKey: REGISTRY_ALLOCATION_KEY,
    });
    const registryPublication = `registry-${registryWorker.workerId}`;
    const registryHealthy = () =>
      !daemon
        .inspectWorkers()
        .find(worker => worker.workerId === registryWorker.workerId)?.failure;
    // A quarantined registry vat is left as it is: the host serves without
    // it, listing and removing installations from its index, and says so.
    /** @type {any} */
    let registry;
    if (registryHealthy()) {
      // The registry's source is more than one message should carry on
      // Ironhorse: a vat that already holds the registry is asked first, so
      // a start costs one message, and the transfer goes in bounded chunks.
      registry = await registryWorker.evaluate('globalThis.registry');
      if (registry === undefined) {
        registry = await evaluateSource(
          registryWorker,
          `(({ installer, index, restartMessage }) =>
            (globalThis.registry ??= (${makeRegistry.toString()})({ installer, index, restartMessage })))`,
          {
            installer: daemon.makeResource('installer'),
            index: daemon.makeResource('installation-index'),
            restartMessage: PENDING_ANSWER_ABORTED_MESSAGE,
          },
        );
      }
      daemon.publish(registry, registryPublication);
    } else {
      log.error(
        'The registry vat is quarantined: installations are listed and removed from the host index, and none can be made; this version offers no command to repair it',
      );
    }
    const assertRegistry = () => {
      if (!registryHealthy())
        throw Error(
          'The registry vat is quarantined; installations can be listed and removed, not made',
        );
    };
    /**
     * Hand an installation request to the registry vat. The host's index
     * names the request's bundles first: the registry journals the request
     * before the host hears of it, so a host that ended between the two
     * would otherwise sweep the bundles at its next start, from under the
     * driver resuming the request. The registry's own record replaces this
     * one at its first step; one for a request the registry refused is
     * forgotten here.
     * @param {any} request
     */
    const requestInstall = async request => {
      if (requested) throw Error('Supervisor is stopping');
      const { name } = request;
      const held = index.get(name);
      // A record of the host's own is replaced by the registry's at its
      // first step; one still the host's names a request the registry never
      // received, the host having ended in between, and is replaced too.
      const provisional =
        held === undefined ||
        (held.provisional === true &&
          (await E(registry).lookup(name)) === undefined);
      if (provisional) {
        index.record(name, {
          kind: request.kind,
          digest: request.digest,
          grants: Array.isArray(request.grants) ? request.grants : [],
          allocationKey: request.allocationKey,
          ...(request.bundleDigest === undefined
            ? {}
            : { bundleDigest: request.bundleDigest }),
          ...(request.durableDigest === undefined
            ? {}
            : { durableDigest: request.durableDigest }),
          ...(request.ephemeralDigest === undefined
            ? {}
            : { ephemeralDigest: request.ephemeralDigest }),
          status: 'pending',
          provisional: true,
        });
      }
      try {
        return await E(registry).install(request);
      } catch (error) {
        // Refused before the registry held it: still the host's record.
        if (provisional && index.get(name)?.provisional === true)
          index.forget(name);
        throw error;
      }
    };
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
    /** @type {any} */
    let workspaceAccess;
    if (
      !daemon
        .inspectWorkers()
        .find(worker => worker.workerId === config.workerId)?.failure
    ) {
      inventory = await workspace.evaluate(
        `(globalThis.inventory ??= (${makeObservableMap.toString()})())`,
      );
      await E(inventory).disconnectEphemeral();
      // The workspace's whole part in installing: resolving grants and
      // holding installed values. The registry vat does the rest. A vat
      // that already holds the access object is asked first, so a start
      // costs one message rather than the source again.
      workspaceAccess = await workspace.evaluate('globalThis.workspaceAccess');
      if (workspaceAccess === undefined) {
        workspaceAccess = await evaluateSource(
          workspace,
          `(() => (globalThis.workspaceAccess ??= (${makeWorkspaceAccess.toString()})(inventory)))`,
          {},
        );
      }
      /**
       * An installation the supervisor provides rather than the user: the
       * same path as any installation, so it has a vat, a budget and a
       * failure lifetime of its own, is listed with the rest, and can be
       * removed, in which case the next start provides it again. Its digest
       * is a constant: what it ships changes only with the workspace
       * version. A name the user has taken is theirs; the supervisor says so
       * and goes on without. Nothing here reads the inventory global, which
       * the user may have replaced.
       *
       * The registry finds one it holds again, so a healthy installation
       * costs a start one lookup; only one that is missing, or whose
       * installation did not complete, is installed, and its code is put in
       * the store for that.
       * @param {string} name
       * @param {() => Promise<{kind: 'application', bundleDigest: string} | {kind: 'native', durableDigest: string, ephemeralDigest: string}>} stage
       *   put the code in the store and name it
       */
      const provide = async (name, stage) => {
        if (!registryHealthy()) {
          log.error(`${name} not provided: the registry vat is quarantined`);
          return;
        }
        try {
          const held = await E(registry).lookup(name);
          if (held?.status === 'ready') {
            if (
              held.workerId !== undefined &&
              daemon.listWorkerIds().includes(held.workerId)
            )
              return;
            // Ready, but its vat is gone: retired by the host while the
            // registry could not answer. The name is freed and provided
            // afresh.
            await E(registry).remove(name);
          }
          const { result } = await requestInstall(
            harden({
              name,
              digest: `builtin:${name}`,
              allocationKey: randomId(),
              grants: [],
              workspace: workspaceAccess,
              ...(await stage()),
            }),
          );
          await result;
        } catch (error) {
          log.error(`${name} not provided:`, error);
        }
      };
      // The clock is a native resource shipped with the package: its manager
      // vat holds every pending deadline, and its adapter process holds the
      // timers. Removing it retires both; the next start provides it again.
      // Its durable factory is shipped by source like every other built-in,
      // so it must be whole (closing over nothing but the guest prelude); the
      // adapter's module is bundled into the store under its digest, so the
      // package's own directory is never pinned and may change underneath a
      // running installation. The installed clock keeps running the bundle
      // it was installed with, so a change to what its two halves say to
      // each other is a WORKSPACE_VERSION bump, which makes a fresh
      // installation of it.
      await provide('clock', async () => {
        const directory = paths.resolve(packagePath, 'resources', 'clock');
        return {
          kind: 'native',
          durableDigest: store.putBundle(`({ make: ${makeClock.toString()} })`),
          ephemeralDigest: store.putBundle(
            await platform.bundler.bundleNative(
              paths.join(directory, 'ephemeral.js'),
            ),
          ),
        };
      });
      await provide('mailbox', async () => ({
        kind: 'application',
        bundleDigest: store.putBundle(
          `({ make: () => (${makeMailbox.toString()})((${makeObservableMap.toString()})) })`,
        ),
      }));
    }
    // Only the lock owner may reclaim the socket left by a dead supervisor.
    await files.remove(socketPath, { force: true });
    // The workspace owns the durable root. Reuse its presence during this host
    // lifetime instead of journaling another evaluator call for every command.
    /** @type {Promise<any> | undefined} */
    let mailboxAddressBook;
    const getMailbox = () => {
      if (mailboxAddressBook) return mailboxAddressBook;
      // Some fifteen kilobytes of guest source, more than one message can
      // carry: transferred in bounded messages, on a stage of its own so no
      // future transfer into the workspace can collide with it. A vat that
      // already holds the address book is asked first, so a supervisor
      // restart costs one message rather than the whole transfer again.
      const introductions = daemon.makeResource('mail-introductions');
      const opening = workspace
        .evaluate('globalThis.mailAddressBook')
        .then(existing =>
          existing !== undefined
            ? existing
            : evaluateSource(
                workspace,
                `(({ introductions }) => {
          // The book and its contacts look the mailbox up at each use, so
          // one provided afresh after a removal is the one they speak to,
          // and its absence is reported at every use, not memoised.
          const provideMailbox = () => {
            const mailbox = inventory.get('mailbox');
            if (mailbox === undefined)
              throw Error('The workspace has no mailbox; restart the supervisor to provide one');
            return mailbox;
          };
          provideMailbox();
          return (globalThis.mailAddressBook ??= (async () => {
            if (!inventory.has('contacts')) {
              inventory.set('contacts', (${makeObservableMap.toString()})());
            }
            const mail = (${makeMailAddressBook.toString()})(
              provideMailbox, inventory.get('contacts'), (${makeMailContact.toString()}), introductions
            );
            if (!inventory.has('mail')) inventory.set('mail', mail);
            return mail;
          })());
        })`,
                { introductions },
                { stage: 'thixotrope.mailSource' },
              ),
        );
      // Supervisor restart is a lifetime boundary for view subscriptions on
      // the mailbox, as it is for the inventory's; the mailbox vat is woken
      // for it on the first mail command of a lifetime, not at every start.
      mailboxAddressBook = opening.then(async book => {
        await workspace.evaluate(
          "E(inventory.get('mailbox')).disconnectEphemeral().then(() => true)",
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
    const assertWorkspace = () => {
      if (requested) throw Error('Supervisor is stopping');
      if (workspaceAccess === undefined)
        throw Error('The workspace vat is quarantined; repair it first');
    };
    /**
     * The registry vat's view of what is installed, or the host index's
     * when that vat cannot answer, in the same shape: the index also names
     * vats, allocation keys and bundles, which stay the host's.
     */
    const listInstallations = async () =>
      registryHealthy()
        ? E(registry).list()
        : index
            .list()
            .map(({ name, kind, digest, grants, status, error }) =>
              harden({ name, kind, digest, grants, status, error }),
            );
    // Vats the installer has handed out and the registry has not yet named
    // are kept from collection; one retired meanwhile is no longer a vat.
    const kept = () =>
      [...allocating].filter(id => daemon.listWorkerIds().includes(id));
    const adminMethods = {
      help: () =>
        'Local supervisor: evaluate(source), status(), stop(), install(name, bundle, grants), installNative(name, directory), installations(), remove(name), alarmStatus(), reachability(), collect(), inventoryStatus(), invite(name), accept(name, invitationText), revokeInvitation(invitationText), contacts(), inbox(), outbox(), send(name, text, key), takeMessage(id, key), discardMessage(id); each connection also has watchInventory(listener).',
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
          registry: registryWorker.workerId,
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
      /**
       * Install an application from its bundle into a fresh vat, with the
       * named inventory entries as its powers; its root takes the name in
       * the inventory. The bundle is staged into the vat in bounded messages,
       * so there is no request-size cap; grants are checked in the workspace
       * before any vat exists.
       * @param {string} name
       * @param {string} bundle
       * @param {Array<[string, string]>} grants
       */
      install: async (name, bundle, grants) => {
        assertWorkspace();
        assertRegistry();
        if (typeof bundle !== 'string') throw Error('Expected module bundle');
        // The bundle goes into the store, where the registry vat has the
        // host stage it from; the vat never holds it. The install answers
        // once the factory has been called; the factory itself may await
        // anything, and nothing here waits for it but this request.
        const bundleDigest = store.putBundle(bundle);
        const { result } = await requestInstall(
          harden({
            name,
            kind: 'application',
            digest: bundleDigest,
            allocationKey: randomId(),
            grants,
            workspace: workspaceAccess,
            bundleDigest,
          }),
        );
        await result;
        return (await E(registry).list()).find(entry => entry.name === name);
      },
      installations: () => {
        if (requested) throw Error('Supervisor is stopping');
        return listInstallations();
      },
      reachability: () => daemon.inspectReachability({ keep: kept() }),
      collect: () => serialized(() => daemon.collectVats({ keep: kept() })),
      inventoryStatus: () => {
        if (inventory === undefined)
          throw Error('The workspace vat is quarantined; repair it first');
        return E(inventory).subscriptionCounts();
      },
      /**
       * Install a native resource from its directory: both entry modules
       * are bundled, the durable one for the manager vat and the ephemeral
       * one for every process the manager launches, and both go into the
       * store under their digests, where the registry vat has the host take
       * them from. The installation's identity is the pair of digests, so
       * the directory is not consulted again and may be edited or removed
       * afterwards; its new version is a new installation.
       * @param {string} name
       * @param {string} directory
       */
      installNative: async (name, directory) => {
        assertWorkspace();
        assertRegistry();
        if (typeof directory !== 'string')
          throw Error('Expected a native resource directory');
        const description = await describeNativeResource(
          { files, paths },
          paths.resolve(directory),
        );
        const { bundle } = await platform.bundler.bundle(
          description.durablePath,
        );
        const ephemeralBundle = await platform.bundler.bundleNative(
          description.ephemeralPath,
        );
        // Bundling is the host's and may outlast a stop: nothing goes into
        // the store once the supervisor is stopping.
        if (requested) throw Error('Supervisor is stopping');
        const durableDigest = store.putBundle(bundle);
        const ephemeralDigest = store.putBundle(ephemeralBundle);
        const digest = hashes.sha256Hex(
          new TextEncoder().encode(
            JSON.stringify([durableDigest, ephemeralDigest]),
          ),
        );
        const { result } = await requestInstall(
          harden({
            name,
            kind: 'native',
            digest,
            allocationKey: randomId(),
            workspace: workspaceAccess,
            durableDigest,
            ephemeralDigest,
          }),
        );
        await result;
        return harden({ name, directory: description.directory, digest });
      },
      /**
       * Remove an installation of either kind by name: its vat is retired,
       * the processes it launched are closed, and the name is free again,
       * whether the installation completed, failed, or was interrupted.
       * Capabilities already handed out from it break.
       * @param {string} name
       */
      remove: async name => {
        if (requested) throw Error('Supervisor is stopping');
        if (typeof name !== 'string' || !name.length)
          throw Error('Expected an inventory name');
        if (registryHealthy() && (await E(registry).remove(name))) return true;
        // The registry vat does not hold the name, or cannot answer. The
        // host index may still: for a request that never reached the
        // registry, the host having ended between recording it and handing
        // it over, or for a vat the registry cannot retire. It is retired
        // and forgotten here; the inventory entry, if any, is the
        // workspace's to clear.
        const entry = index.get(name);
        if (entry === undefined) return false;
        const { workerId } = entry;
        if (workerId !== undefined && daemon.listWorkerIds().includes(workerId))
          await serialized(() => daemon.getWorker(workerId).retire());
        index.forget(name);
        return true;
      },
      alarmStatus: async () => {
        assertWorkspace();
        // The clock counts its own pending alarms; the host keeps none.
        if (!(await workspace.evaluate("inventory.has('clock')")))
          throw Error('The clock is not installed');
        const { pending } = await workspace.evaluate(
          "E(inventory.get('clock')).status()",
        );
        return harden({ pending: Number(pending) });
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
        const book = await getMailbox();
        return workspace.evaluate(
          'E(book).take(id).then(value => { inventory.set(key, value); return true; })',
          { id, key, book },
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
          // An installation in flight is the registry vat's to resume: its
          // continuation survives the stop, so nothing here waits for it.
          await closeControl();
        } finally {
          try {
            await closePeers();
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
      await closePeers();
      await daemon?.crash();
    }
    throw error;
  }
};
harden(serveThixotrope);
