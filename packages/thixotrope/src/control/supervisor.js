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
/** @import { Workspace, WorkspaceTable } from './workspaces.js' */
/** @import { PlatformPowers } from '../platform/powers.js' */
/** @import { FilePowers } from '../platform/files.js' */
/** @import { PromiseKit } from '@endo/promise-kit' */
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { PENDING_ANSWER_ABORTED_MESSAGE } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makePromiseKit } from '@endo/promise-kit';

import { makeInFlight } from '../in-flight.js';
import { settleWithin } from '../platform/timers.js';
import { locateNativeResource } from '../native/locate-resource.js';
import { randomHex128 } from '../random-id.js';
import { makeSerialQueue } from '../serial-queue.js';

import { evaluateSource } from '../core/evaluate-source.js';
import { makeInstallationIndex } from './installation-index.js';
import { makeBuiltins } from './builtins.js';
import { makeInstaller } from './installer.js';
import { makeMeasuredEngine } from './measured-engine.js';
import { assertInstallationName, assertWorkspaceName } from './names.js';
import { makeRegistry } from './registry.js';
import { makeWorkspaces } from './workspaces.js';
import { makeThixotropeDaemon } from '../core/daemon.js';
import { makeFileSyncStringAtom } from '../store/file-sync-string-atom.js';
import { assertRecordVersion } from '../store/versioned-record.js';
import { makeDurableNetLayer } from '../net/durable-netlayer.js';
import { makeIronhorseEngine } from '../ironhorse/ironhorse-engine.js';
import { readIronhorseLimits } from '../ironhorse/ironhorse-limits.js';
import { makeInventoryViewLifetime } from './inventory-view-lifetime.js';
import { makeLocalControl } from './local-control.js';
import { makeMailIntroductions } from '../mail/introductions.js';
import { makeFsStore } from '../store/store-fs.js';
import {
  assertUnixPeerLocation,
  makeUnixNetLayer,
} from '../net/unix-netlayer.js';

/** @import { WorkerEngine } from '../core/worker-engine.js' */

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
// which the launcher's binding names in place of a directory, and the
// clock is a native resource, with no host alarm ledger; 10: the
// installation registry is the host's, in a registry vat of its own with an
// index beside it, and a workspace only resolves grants and holds values;
// 11: workspaces are a table, each in a vat allocated under a key derived
// from its name, and an installation belongs to a workspace or to the
// daemon, whose clock every workspace is handed; 12: a host resource is
// bound to a worker and a key, and a launcher's key is its ephemeral
// bundle digest; 13: an export record names its resource's binding.
const WORKSPACE_VERSION = 13;
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
  /** @type {WorkspaceTable | undefined} */
  let config;
  const { engine: measured, timings } = makeMeasuredEngine(rawEngine, timers);
  const pendingDisconnects = makeInFlight();
  // The views each live control connection holds, by its facet, for the
  // stop to end together.
  /** @type {Map<object, () => Promise<void>>} */
  const disconnectViews = new Map();
  // The control socket's facet, once provided: the native resource whose
  // adapter listens for local administration sessions; or, when it could
  // not be provided, the host's own listener in its place.
  /** @type {any} */
  let controlFacet;
  /** @type {{ close: () => Promise<void> } | undefined} */
  let fallbackListener;
  // The per-connection administration facet the control adapter asks for at
  // each connection; made once the administration below exists, which a
  // connection accepted before then waits for.
  /** @type {(() => object) | undefined} */
  let makeConnectionFacet;
  /** @type {PromiseKit<void>} */
  const readyKit = makePromiseKit();
  void readyKit.promise.catch(() => {});
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
  const closeControl = async () => {
    const viewCleanup = Promise.allSettled(
      [...disconnectViews.values()].map(disconnect => disconnect()),
    );
    // The adapter stops accepting and ends its connections, after the stop
    // acknowledgement it has already forwarded; bounded, since a stuck
    // adapter must not hold the stop, and the daemon's shutdown ends the
    // process in any case.
    if (controlFacet !== undefined) {
      const closing = controlFacet;
      controlFacet = undefined;
      await settleWithin(
        timers,
        1000,
        E(closing)
          .close()
          .catch((/** @type {Error} */ error) => {
            log.error('control socket not closed:', error);
          }),
      );
    }
    if (fallbackListener !== undefined) {
      const closing = fallbackListener;
      fallbackListener = undefined;
      await settleWithin(timers, 1000, closing.close());
    }
    // A failed guest may never settle subscription setup or cancellation.
    // Continue to daemon shutdown after a grace period; startup discards any
    // ephemeral registrations that survive in the guest's persistent image.
    await settleWithin(
      timers,
      1000,
      Promise.all([viewCleanup, pendingDisconnects.drain()]),
    );
    // Still holding the lease: a successor's socket is never removed by this
    // process after ownership passes.
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
        adapterProcesses: platform.adapterProcesses,
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
          if (config !== undefined)
            assertRecordVersion(
              'workspace metadata',
              config.version,
              WORKSPACE_VERSION,
            );
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
          // The operator's administration, host code, from which the
          // control socket's adapter starts each client's session: one
          // facet per connection, ended with it.
          'control-admin': () =>
            Far('ThixotropeControlAdmin', {
              help: () =>
                'connect() makes the administration facet one client connection speaks to; close() on that facet ends what it holds.',
              connect: async () => {
                await readyKit.promise;
                if (requested || makeConnectionFacet === undefined)
                  throw Error('Supervisor is not accepting connections');
                return makeConnectionFacet();
              },
            }),
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
      config = { version: WORKSPACE_VERSION, workspaces: {} };
      await save(files, configPath, config);
    }
    if (
      config?.version !== WORKSPACE_VERSION ||
      typeof config.workspaces !== 'object' ||
      config.workspaces === null
    )
      throw Error('Invalid workspace metadata');
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
      const { name, workspace } = request;
      const held = index.get(workspace, name);
      // A record of the host's own is replaced by the registry's at its
      // first step; one still the host's names a request the registry never
      // received, the host having ended in between, and is replaced too.
      const provisional =
        held === undefined ||
        (held.provisional === true &&
          (await E(registry).lookup(name, workspace)) === undefined);
      if (provisional) {
        index.record(workspace, name, {
          ...(workspace === undefined ? {} : { workspace }),
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
        if (provisional && index.get(workspace, name)?.provisional === true)
          index.forget(workspace, name);
        throw error;
      }
    };
    const { provide, shipClock, shipControl, shipMailbox } = makeBuiltins({
      store,
      platform,
      paths,
      packagePath,
      daemon,
      registry,
      registryHealthy,
      requestInstall,
      randomId,
      log,
    });
    // The clock's facet as provided this lifetime, handed to every
    // workspace; dropped when the clock is removed, so a workspace made
    // afterwards is handed nothing stale and the next start's clock instead.
    /** @type {unknown} */
    let clockFacet;

    const {
      workspaces,
      DEFAULT_WORKSPACE,
      openWorkspace,
      provideInto,
      createWorkspace,
      takeBack,
      describeWorkspace,
    } = makeWorkspaces({
      daemon,
      hashes,
      config,
      saveConfig: () => save(files, configPath, config),
      log,
      serialized,
      registry,
      registryHealthy,
      getIndex: () => index,
      provide,
      shipMailbox,
      clockFacet: () => clockFacet,
      isStopping: () => requested,
    });
    // Every workspace is opened before the clock is provided, so a clock
    // whose vat is gone is taken back from each of them; a workspace is
    // served, and visible, once everything has been provided into it.
    /** @type {Workspace[]} */
    const opened = [];
    for (const name of new Set([
      DEFAULT_WORKSPACE,
      ...Object.keys(config.workspaces),
    ])) {
      assertWorkspaceName(name);
      // eslint-disable-next-line no-await-in-loop
      opened.push(await openWorkspace(name));
    }
    clockFacet = await provide('clock', shipClock, {
      onStale: value => takeBack('clock', value, opened),
    });
    for (const workspace of opened) {
      // eslint-disable-next-line no-await-in-loop
      await provideInto(workspace);
      workspaces.set(workspace.name, workspace);
    }
    /** @param {Workspace} workspace */
    const assertWorkspace = workspace => {
      if (requested) throw Error('Supervisor is stopping');
      if (workspace.access === undefined)
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
            .map(({ workspace, name, kind, digest, grants, status, error }) =>
              harden({
                ...(workspace === undefined ? {} : { workspace }),
                name,
                kind,
                digest,
                grants,
                status,
                error,
              }),
            );
    // Vats the installer has handed out and the registry has not yet named
    // are kept from collection; one retired meanwhile is no longer a vat.
    const kept = () =>
      [...allocating].filter(id => daemon.listWorkerIds().includes(id));
    const daemonMethods = {
      help: () =>
        'Local supervisor. Daemon-wide: status(), stop(), installations(), reachability(), collect(), workspaces(), createWorkspace(name), selectWorkspace(name), close(). In the selected workspace, `default` unless selected: evaluate(source), install(name, bundle, grants), installNative(name, directory), remove(name), alarmStatus(), inventoryStatus(), invite(name), accept(name, invitationText), revokeInvitation(invitationText), contacts(), inbox(), outbox(), send(name, text, key), takeMessage(id, key), discardMessage(id), watchInventory(listener).',
      stop: () => {
        timers.setTimer(requestStop, 0);
        return 'Stopping supervisor';
      },
      installations: () => {
        if (requested) throw Error('Supervisor is stopping');
        return listInstallations();
      },
      reachability: () => daemon.inspectReachability({ keep: kept() }),
      collect: () => serialized(() => daemon.collectVats({ keep: kept() })),
      workspaces: () => harden([...workspaces.values()].map(describeWorkspace)),
      /** @param {string} name */
      createWorkspace: async name =>
        describeWorkspace(await createWorkspace(name)),
    };
    /**
     * The methods of one connection on the workspace it has selected.
     * @param {() => Workspace} current
     */
    const makeWorkspaceMethods = current => ({
      status: () =>
        harden({
          workspace: current().workerId,
          workspaces: Object.fromEntries(
            [...workspaces.values()].map(({ name, workerId }) => [
              name,
              workerId,
            ]),
          ),
          registry: registryWorker.workerId,
          ...(ironhorseLimits ? { ironhorse: ironhorseLimits } : {}),
          workers: daemon.inspectWorkers(),
          timings: timings(),
        }),
      /** @param {string} source */
      evaluate: async source => {
        if (requested) throw Error('Supervisor is stopping');
        if (typeof source !== 'string')
          throw Error('Expected JavaScript source');
        const value = await current().worker.evaluate(source);
        return display.describe(value);
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
        const workspace = current();
        assertWorkspace(workspace);
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
            workspace: workspace.name,
            access: workspace.access,
            kind: 'application',
            digest: bundleDigest,
            allocationKey: randomId(),
            grants,
            bundleDigest,
          }),
        );
        await result;
        return (await E(registry).list()).find(
          (/** @type {{workspace?: string, name: string}} */ entry) =>
            entry.workspace === workspace.name && entry.name === name,
        );
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
        const workspace = current();
        assertWorkspace(workspace);
        assertRegistry();
        if (typeof directory !== 'string')
          throw Error('Expected a native resource directory');
        const entries = await locateNativeResource(
          { files, paths },
          paths.resolve(directory),
        );
        const { bundle } = await platform.bundler.bundle(entries.durablePath);
        const ephemeralBundle = await platform.bundler.bundleNative(
          entries.ephemeralPath,
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
            workspace: workspace.name,
            access: workspace.access,
            kind: 'native',
            digest,
            allocationKey: randomId(),
            durableDigest,
            ephemeralDigest,
          }),
        );
        await result;
        return harden({ name, directory: entries.directory, digest });
      },
      /**
       * Remove an installation of either kind by name: its vat is retired,
       * the processes it launched are closed, and the name is free again,
       * whether the installation completed, failed, or was interrupted.
       * Capabilities already handed out from it break. The selected
       * workspace's installation under the name goes first; failing that,
       * the daemon-wide one, taken back from every workspace.
       * @param {string} name
       */
      remove: async name => {
        if (requested) throw Error('Supervisor is stopping');
        assertInstallationName(name);
        const workspace = current();
        if (registryHealthy()) {
          if (await E(registry).remove(name, workspace.name)) return true;
          // The socket this very request came through: removing it would
          // end administration for the lifetime, the stop included.
          if (name === 'control')
            throw Error(
              'The control socket cannot be removed; it is provided afresh at every start',
            );
          const held = await E(registry).lookup(name);
          if (held !== undefined) {
            const removed = await E(registry).remove(name);
            if (removed && held.value !== undefined)
              await takeBack(name, held.value);
            if (removed && name === 'clock') clockFacet = undefined;
            return removed;
          }
        }
        // The registry vat does not hold the name, or cannot answer. The
        // host index may still: for a request that never reached the
        // registry, the host having ended between recording it and handing
        // it over, or for a vat the registry cannot retire. It is retired
        // and forgotten here; the inventory entry, if any, is the
        // workspace's to clear.
        for (const scope of [workspace.name, undefined]) {
          const entry = index.get(scope, name);
          if (entry !== undefined) {
            if (scope === undefined && name === 'control')
              throw Error(
                'The control socket cannot be removed; it is provided afresh at every start',
              );
            const { workerId } = entry;
            if (
              workerId !== undefined &&
              daemon.listWorkerIds().includes(workerId)
            )
              // eslint-disable-next-line no-await-in-loop
              await serialized(() => daemon.getWorker(workerId).retire());
            index.forget(scope, name);
            return true;
          }
        }
        return false;
      },
      alarmStatus: async () => {
        const workspace = current();
        assertWorkspace(workspace);
        // The clock counts its own pending alarms; the host keeps none.
        if (!(await workspace.worker.evaluate("inventory.has('clock')")))
          throw Error('The clock is not installed');
        const { pending } = await workspace.worker.evaluate(
          "E(inventory.get('clock')).status()",
        );
        return harden({ pending: Number(pending) });
      },
      inventoryStatus: () => {
        const { inventory } = current();
        if (inventory === undefined)
          throw Error('The workspace vat is quarantined; repair it first');
        return E(inventory).subscriptionCounts();
      },
      /** @param {string} name */
      invite: name => E(current().getAddressBook()).invite(name),
      /**
       * @param {string} name
       * @param {string} invitationText
       */
      accept: (name, invitationText) =>
        E(current().getAddressBook()).accept(name, invitationText),
      /** @param {string} invitationText */
      revokeInvitation: invitationText =>
        E(current().getAddressBook()).revokeInvitation(invitationText),
      contacts: () => E(current().getAddressBook()).contacts(),
      inbox: () => E(current().getAddressBook()).inbox(),
      outbox: () => E(current().getAddressBook()).outbox(),
      /**
       * @param {string} name
       * @param {string} text
       * @param {string} key
       */
      send: async (name, text, key) => {
        const workspace = current();
        // Resolve the grant in the workspace so only the explicitly selected
        // value crosses into the mailbox vat.
        await workspace.getAddressBook();
        return workspace.worker.evaluate(
          'E(mailAddressBook).send(name, text, inventory.get(key))',
          { name, text, key },
        );
      },
      /**
       * @param {string} id
       * @param {string} key
       */
      takeMessage: async (id, key) => {
        if (typeof key !== 'string' || !key.length)
          throw Error('Expected inventory key');
        const workspace = current();
        const book = await workspace.getAddressBook();
        return workspace.worker.evaluate(
          'E(book).take(id).then(value => { inventory.set(key, value); return true; })',
          { id, key, book },
        );
      },
      /** @param {string} id */
      discardMessage: id => E(current().getAddressBook()).discard(id),
    });
    /**
     * The administration one client connection speaks to: the daemon's
     * methods and the selected workspace's, `default` until it selects
     * another, with inventory views per workspace that end with the
     * connection, which the control adapter closes when the client goes.
     * An adapter that dies closes none of its facets; their views, whose
     * listeners the hub has broken by then, stay listed until the stop ends
     * them, since no cheaper signal names which facets were that adapter's.
     */
    makeConnectionFacet = () => {
      let selected = /** @type {Workspace} */ (
        workspaces.get(DEFAULT_WORKSPACE)
      );
      /** @type {Map<string, ReturnType<typeof makeInventoryViewLifetime>>} */
      const views = new Map();
      const viewOf = (/** @type {Workspace} */ workspace) => {
        let view = views.get(workspace.name);
        if (view === undefined) {
          view = makeInventoryViewLifetime(timers, workspace.inventory);
          views.set(workspace.name, view);
        }
        return view;
      };
      /** @type {object} */
      let facet;
      const disconnect = async () => {
        disconnectViews.delete(facet);
        await Promise.all([...views.values()].map(view => view.disconnect()));
      };
      facet = Far('ThixotropeLocalAdmin', {
        ...daemonMethods,
        ...makeWorkspaceMethods(() => selected),
        /** @param {string} name */
        selectWorkspace: name => {
          assertWorkspaceName(name);
          const workspace = workspaces.get(name);
          if (workspace === undefined)
            throw Error(`Unknown workspace: ${name}`);
          selected = workspace;
          return describeWorkspace(workspace);
        },
        /** @param {any} listener */
        watchInventory: listener => {
          if (requested) throw Error('Connection is closing');
          assertWorkspace(selected);
          return viewOf(selected).watch(listener);
        },
        close: () => {
          const cleanup = disconnect().catch(error => {
            // A quarantined vat cannot run cancellation; its ephemeral
            // listeners will be discarded if it is ever recovered in a new
            // supervisor.
            if (!requested) log.error('inventory disconnect:', error.message);
          });
          pendingDisconnects.track(cleanup);
          return cleanup;
        },
      });
      disconnectViews.set(facet, disconnect);
      return facet;
    };
    /**
     * The control socket as host code, for a start that cannot have the
     * native resource serve it: the registry vat quarantined, say. The
     * repair path must not route through the thing being repaired, so the
     * host listens itself, the same framing and facets, and says so.
     * @param {string} reason
     */
    const serveFallback = async reason => {
      // The resource's adapter may be serving the path already, rebuilt at
      // this start from a registration its manager vat kept: its
      // connections reach the same administration, so the host stands
      // down rather than take a live listener's socket.
      /** @type {Set<import('../platform/sockets.js').SocketConnection>} */
      const connections = new Set();
      const listen = () =>
        sockets.listenPath({
          path: socketPath,
          mode: 0o600,
          onConnection: connection => {
            if (requested || makeConnectionFacet === undefined) {
              void connection.writer
                .throw(Error('Supervisor closed the connection'))
                .catch(() => {});
              return;
            }
            connections.add(connection);
            void connection.closed.then(() => connections.delete(connection));
            const facet = /** @type {any} */ (makeConnectionFacet());
            void makeLocalControl(
              { sockets, random },
              connection,
              'worker',
              facet,
            )
              .then(session => session.closed)
              .catch(error => {
                void connection.writer.throw(error).catch(() => {});
              })
              .finally(() => facet.close());
          },
          onError: error => {
            log.error('control listener failed:', error);
          },
        });
      /** @type {Awaited<ReturnType<typeof listen>>} */
      let listener;
      try {
        listener = await listen();
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EADDRINUSE')
          throw error;
        if (await sockets.probePath(socketPath)) {
          log.error(`control socket served by its adapter: ${reason}`);
          return;
        }
        // Only the lock owner may reclaim the socket left by a dead
        // supervisor.
        await files.remove(socketPath, { force: true });
        listener = await listen();
      }
      log.error(`control socket served by the host: ${reason}`);
      fallbackListener = harden({
        close: async () => {
          listener.close();
          for (const connection of connections)
            void connection.writer.return(undefined).catch(() => {});
          await listener.closed;
        },
      });
    };
    // Served last, once everything a connection can reach exists.
    controlFacet = await provide('control', shipControl, {
      onStale: value => takeBack('control', value, opened),
      powers: harden({ admin: daemon.makeResource('control-admin') }),
      replaceUnhealthy: true,
    });
    if (controlFacet === undefined) {
      await serveFallback('the control socket could not be provided');
    } else {
      try {
        await E(controlFacet).serve(socketPath);
      } catch (error) {
        log.error('control socket not served:', error);
        // Nothing of it stays desired: a registration left behind would
        // have the adapter take the path from the host at its next rebuild.
        const closing = controlFacet;
        controlFacet = undefined;
        await settleWithin(
          timers,
          1000,
          E(closing)
            .close()
            .catch(() => {}),
        );
        await serveFallback('its adapter could not listen');
      }
    }
    readyKit.resolve();
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
            requestStop();
          }
        }
      })();
      return closing;
    };
    return harden({ socketPath, stopped, close });
  } catch (error) {
    readyKit.reject(error);
    try {
      await closeControl();
    } finally {
      await closePeers();
      await daemon?.crash();
    }
    throw error;
  }
};
harden(serveThixotrope);
