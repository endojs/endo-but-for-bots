// @ts-check
/** @import { Logger } from '../platform/logging.js' */
/** @import { AdapterProcessPowers } from '../platform/adapter-processes.js' */
/** @import { RandomPowers } from '../platform/random.js' */
/** @import { TimerPowers } from '../platform/timers.js' */
import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';
import { E, Far } from '@endo/far';
import { encodeSwissnum, swissnumFromBytes } from '@endo/ocapn/client/util';
import { makeCryptography } from '@endo/ocapn/cryptography';

import { makeOcapnHub } from '../net/hub.js';
import { makePeerSessions } from '../net/peer-sessions.js';
import { makeDurableWorkerTransport } from './durable-worker-transport.js';
import { makeInProcessHubSession } from '../net/in-process-session.js';
import { makeTransientHubClient } from '../net/transient-hub-client.js';
import { makeFirstFailure, makeInFlight } from '../in-flight.js';
import { HEX128_PATTERN, randomHex128 as randomHexFrom } from '../random-id.js';
import { makeNativeAdapters } from '../native/adapters.js';
import { makeLogPowers, silentLogger } from '../platform/logging.js';
import { settleWithin } from '../platform/timers.js';
import { inspectVatReachability } from './vat-reachability.js';
import { WorkerHaltError } from './worker-engine.js';
import {
  boundKeyOf,
  boundWorkerOf,
  makeWorkerSessionRecords,
} from './worker-session-records.js';

/**
 * @import {ERef, FarRef} from '@endo/eventual-send'
 * @import {Connection, OcapnBootstrap} from '@endo/ocapn/client/types'
 * @import {WorkerEngine} from './worker-engine.js'
 * @import {ThixotropeStore} from '../store/store.js'
 * @import {ThixotropeWorkerShell} from './worker-peer.js'
 */

/**
 * The thixotrope daemon, hub edition: mostly a forwarding and
 * slot-rewriting hub, per design. The daemon is NOT an OCapN client —
 * the Thixotrope hub (`src/net/hub.js`) routes every message between
 * sessions by structural transcoding over persisted c-list tables, so
 * the daemon reifies nothing that flows between workers and peers:
 * no presences, no promises, no subscriptions, no obligation rows.
 *
 * Sessions on the hub:
 * - each worker, over a durable worker transport (frames journaled
 *   against heap snapshots; the worker runs the full OCapN peer);
 * - each remote peer, over the injected netlayer (with the durable
 *   netlayer, frames and identity persist per resume token and the
 *   session reattaches to the hub on resume — the hub's tables carry
 *   the rest);
 * - ONE reifying endpoint: an in-process OCapN client that hosts the
 *   daemon's genuine objects (system resources, the worker
 *   controller) and gives the embedder its admin route (evaluate,
 *   publish). It is the only place values live, it is restored across
 *   restarts by the worker-session-records machinery (resources
 *   re-instantiated by name at their recorded positions, pending
 *   answers rejected at-most-once), and nothing routed between other
 *   sessions ever touches it.
 *
 * A daemon restart is: reload hub tables, reattach worker transports
 * (asleep), restore the endpoint's session, and let remote peers
 * resume. Positions are rows; nothing is re-seated because nothing
 * was reified.
 *
 * @typedef {object} ThixotropeWorkerAdmin
 * @property {string} workerId
 * @property {string | undefined} debugLabel
 * @property {(source: string, endowments?: Record<string, unknown>) => Promise<any>} evaluate
 * @property {() => boolean} isAwake
 * @property {() => Promise<void>} wake
 * @property {() => Promise<void>} sleep
 * @property {() => Promise<void>} retire
 * @property {(target: object) => void} notifyOnStart ask the host to call
 *   `started()` on this held object at every daemon startup
 * @property {() => void} clearStartNotice
 */

/**
 * What a host resource is bound to: a worker, in which case retiring the
 * worker retires the resource, and a small key a resource may add to tell
 * instances bound to one worker apart (an adapter launcher's bundle digest,
 * say). A resource bound to neither is a daemon-wide singleton.
 *
 * @typedef {object} ResourceBinding
 * @property {string} [workerId] a worker this daemon serves
 * @property {string} [key]
 */

/**
 * @typedef {object} ThixotropeDaemon
 * @property {any} location this daemon's OCapN location; combine with a
 *   publication's swissnum to mint a sturdy ref on any peer
 * @property {(secret: string) => { location: any, secret: string }} makeSturdyRefDetails
 * @property {(source: string, endowments?: Record<string, unknown>) => Promise<any>} eval
 *   evaluate in a fresh implicitly-created worker and return the
 *   result; the worker persists like any other (find it via
 *   `listWorkerIds`, retire it via `getWorker(id).retire()`)
 * @property {(options?: { debugLabel?: string, ephemeral?: boolean, allocationKey?: string }) => Promise<ThixotropeWorkerAdmin>} createWorker
 * @property {(workerId: string) => ThixotropeWorkerAdmin} getWorker
 * @property {() => Array<string>} listWorkerIds
 * @property {(keep: Iterable<string>) => Array<string>} sweepBundles free
 *   the stored bundles no launcher names and the embedder does not keep
 * @property {(name: string, binding?: ResourceBinding) => object} makeResource
 *   a host resource, memoised per name and binding and recorded as such
 *   against every export of it, so a restart makes the same instance again
 * @property {(name: string, binding?: ResourceBinding) => boolean} retireResource
 *   forget a resource instance and null its recorded exports, so a restart
 *   seats tombstones for it rather than re-running its factory
 * @property {(value: object, secret?: string) => string} publish
 * @property {(secret: string) => void} unpublish
 * @property {(location: any, secret: string) => Promise<any>} importReference fetch a remote publication through the durable hub session
 * @property {() => Promise<Awaited<ReturnType<typeof makeTransientHubClient>>>} openTransientClient open disposable host request/observer session
 * @property {<T = any>(secret: string | Uint8Array) => Promise<T>} lookup the
 *   embedder's in-process route to a publication, through the endpoint.
 *   The daemon cannot know what interface a publication has — the
 *   embedder that published it does — so `T` is the embedder's to name
 *   on the receiving declaration. Its default leaves the result as
 *   unconstrained as it was before, so an embedder that names nothing
 *   is unaffected.
 * @property {(options?: { keep?: Array<string> }) => ReturnType<typeof inspectVatReachability>} inspectReachability
 * @property {(options?: { keep?: Array<string> }) => Promise<Array<string>>} collectVats
 * @property {() => Promise<void>} shutdown
 * @property {() => Promise<void>} crash drain queued work then terminate without snapshots
 */

const textEncoder = new TextEncoder();
const SHELL_SWISSNUM = swissnumFromBytes(textEncoder.encode('shell'));
// The endpoint's pseudo-worker id: its session records (resource
// bindings, pending answers) live in this worker store.
const ENDPOINT_ID = 'e'.repeat(32);
const ENDPOINT_SESSION = 'endpoint';
// How long startup waits, in all, for notified vats to re-establish whatever
// they own.
const START_NOTICE_MS = 10_000;

/**
 * @param {object} powers
 * @param {TimerPowers} powers.timers
 * @param {RandomPowers} powers.random
 * @param {Logger} powers.logging
 * @param {object} options
 * @param {ThixotropeStore} options.store
 * @param {WorkerEngine} options.engine
 * @param {any} options.codec an OCapN codec, e.g. `syrupCodec`
 * @param {(powers: { handlers: any, logger: any, resumption: any }) => Promise<any> | any} options.makeNetlayer
 * @param {Record<string, (binding?: unknown) => object>} [options.resources]
 * @param {AdapterProcessPowers} [options.adapterProcesses]
 * @param {number} [options.idleSleepMs] put a worker to sleep after this long
 *   with no deliveries (see the durable worker transport's idle-sleep
 *   policy); omitted means workers sleep only on request
 * @param {boolean} [options.verbose]
 * @returns {Promise<ThixotropeDaemon>}
 */
const buildDaemon = async (
  { timers, random, logging },
  {
    store,
    engine,
    codec,
    makeNetlayer,
    resources = {},
    adapterProcesses,
    idleSleepMs = undefined,
    verbose = false,
  },
) => {
  // 128 random bits as lowercase hex: worker ids and default swissnums.
  const randomHex128 = () => randomHexFrom(random);

  // Verbose puts the daemon's own diagnostics and OCapN's protocol tracing
  // on stderr together. A durable-record write failure is not opt-in, so the
  // session records below keep the host's own logger.
  const log = verbose
    ? makeLogPowers({
        log: logging.error,
        info: logging.error,
        error: logging.error,
      }).sub('thixotrope', 'daemon')
    : silentLogger;

  const cryptography = makeCryptography(codec, length =>
    random.randomBytes(length),
  );
  /** @type {any} */
  const handoffDialRef = {};
  const hub = makeOcapnHub({
    codec,
    store: harden({
      getState: () => store.getHubState(),
      setState: (/** @type {any} */ state) => store.setHubState(state),
    }),
    cryptography,
    handoffs: harden({
      connect: (/** @type {any} */ location, /** @type {string} */ key) =>
        handoffDialRef.connect(location, key),
    }),
  });

  /** @type {Map<string, { transport: any, sink: any, shellP?: Promise<ThixotropeWorkerShell> }>} */
  const workers = new Map();

  /** @param {string} workerId */
  const provideWorkerSession = workerId => {
    let entry = workers.get(workerId);
    if (entry === undefined) {
      const workerStore = store.provideWorkerStore(workerId);
      /** @type {any} */
      const holder = {};
      const transport = makeDurableWorkerTransport(
        { timers, logging },
        {
          workerId,
          store: workerStore,
          engine,
          idleSleepMs,
          debugLabel: workerStore.getMeta().debugLabel,
          // An ephemeral worker is resident by construction. Its state is
          // discarded at the next startup regardless, so snapshotting it on
          // idle is I/O spent on something already known to be disposable —
          // and a resource adapter that sleeps is one that has to be woken by
          // the very traffic it exists to absorb.
          resident: workerStore.getMeta().ephemeral === true,
          onFatal: () => hub.retireSession(workerId),
          onFrame: (
            /** @type {Uint8Array} */ bytes,
            /** @type {number} */ sequenceNumber,
          ) => holder.sink.deliver(bytes, sequenceNumber),
        },
      );
      holder.sink = hub.attachSession(workerId, {
        send: (
          /** @type {Uint8Array} */ bytes,
          /** @type {string | undefined} */ sequence = undefined,
        ) => transport.write(bytes, sequence),
        // The worker transport journals frames against heap snapshots;
        // hub frames toward a momentarily-detached worker session must
        // queue, never break.
        durable: true,
        requireAcceptance: true,
      });
      if (workerStore.getMeta().failure !== undefined)
        hub.retireSession(workerId);
      entry = { transport, sink: holder.sink };
      workers.set(workerId, entry);
    }
    return entry;
  };

  // --- the endpoint: the daemon's one reifying session ---

  // Records scoped to the endpoint: resource bindings per export
  // slot, and at-most-once answer obligations. Links and forwarders
  // no longer arise — the hub carries all cross-session references.
  const resourceMakers = /** @type {Record<string, any>} */ ({});
  const records = makeWorkerSessionRecords({
    store,
    resources: resourceMakers,
    reportError: logging.sub('thixotrope', 'worker-sessions').error,
  });

  /**
   * Endpoint import presence -> hub-facing position, for `publish`.
   * Weak, so the map does not itself pin every import the endpoint
   * ever saw.
   *
   * @type {WeakMap<object, bigint>}
   */
  const importPositions = new WeakMap();

  let stopped = false;
  let stopping = false;
  /** @type {Set<Awaited<ReturnType<typeof makeTransientHubClient>>>} */
  const transientClients = new Set();
  const openingTransientClients = makeInFlight();
  // These are outgoing answer positions, not restored incoming resolver obligations.
  // Settled cached answers and imports do not independently pin their vats.
  const pendingEndpointAnswers = new Set();
  // The endpoint's session with the hub: established through the
  // resumeSession seam (handshake-free, restorable exports), frames
  // flowing directly between the hub duct and the client's message
  // handler.
  const endpoint = await makeInProcessHubSession({
    random,
    codec,
    hub,
    id: ENDPOINT_ID,
    sessionKey: ENDPOINT_SESSION,
    networkId: 'thixotrope-endpoint',
    logger: log.sub('endpoint'),
    debugLabel: 'thixotrope-endpoint',
    sessionHooks: {
      ...records.sessionHooks,
      onImport: (
        /** @type {Connection} */ connection,
        /** @type {string} */ slot,
        /** @type {FarRef<object>} */ value,
      ) => {
        if (slot[0] === 'a' && slot[1] === '-') {
          const position = slot.slice(2);
          pendingEndpointAnswers.add(position);
          const settled = () => {
            pendingEndpointAnswers.delete(position);
          };
          void Promise.resolve(value).then(settled, settled);
        }
        if (slot[0] === 'o' && slot[1] === '-') {
          importPositions.set(value, BigInt(slot.slice(2)));
        }
      },
    },
    location: harden({
      type: /** @type {const} */ ('ocapn-peer'),
      network: 'thixotrope-endpoint',
      transport: 'thixotrope-endpoint',
      designator: 'endpoint',
      hints: /** @type {const} */ (false),
    }),
    isClosed: () => stopped,
    onEnd: () => {},
    onShutdown: () => {},
  });
  const endpointClient = endpoint.client;
  records.registerWorkerConnection(endpoint.connection, ENDPOINT_ID);
  const endpointResumed = endpoint.resume();
  records.registerResumedSession(ENDPOINT_ID, endpointResumed);

  // --- remote peers: netlayer sessions on the hub ---

  /** @type {any} */
  const netlayerRef = {};
  const peers = makePeerSessions({
    hub,
    store,
    cryptography,
    codec,
    netlayerRef,
    randomHex128,
    log,
    isStopped: () => stopped,
  });
  handoffDialRef.connect = peers.connect;
  const { hubHandlers, resumption } = peers;

  // --- the embedder API, through the endpoint ---

  const endpointSessionP = endpointClient.provideSession(
    endpoint.resumption.peerLocation,
  );

  /** @type {ThixotropeDaemon['lookup']} */
  const lookup = async secret => {
    const session = await endpointSessionP;
    const bytes =
      typeof secret === 'string'
        ? encodeSwissnum(secret)
        : swissnumFromBytes(secret);
    return E(session.getBootstrap()).fetch(bytes);
  };

  /**
   * The worker's shell, reached by introducing the worker's bootstrap
   * into the endpoint session out of band — never via the publications
   * table, which roots vat GC.
   *
   * @param {string} workerId
   */
  const provideShell = workerId => {
    // Look up, never create: a retired worker must not come back as a
    // zombie session with no store behind it.
    const entry = workers.get(workerId);
    if (entry === undefined) {
      throw Fail`worker ${q(workerId)} has been retired`;
    }
    if (entry.shellP === undefined) {
      const facing = hub.introduce(ENDPOINT_SESSION, {
        session: workerId,
        position: 0n,
      });
      /** @type {FarRef<OcapnBootstrap>} */
      const bootstrap = endpointResumed.provideImport({
        type: 'o',
        position: facing,
      });
      /** @type {ERef<ThixotropeWorkerShell>} */
      const shell = E(bootstrap).fetch(SHELL_SWISSNUM);
      entry.shellP = Promise.resolve(shell);
    }
    return entry.shellP;
  };

  /**
   * Record which held object to call `started()` on at every daemon startup.
   *
   * The publication that lets a later process find the object again is the
   * daemon's own: its secret is minted here, kept in worker meta, and never
   * handed out. A start notice is therefore a reference the caller holds,
   * not a bearer token it has to keep somewhere, and nothing that reads
   * worker meta learns a way to reach the object.
   *
   * @param {string} workerId
   * @param {object | undefined} target an object the endpoint holds, or
   *   undefined to clear the notice
   */
  const setStartNotice = (workerId, target) => {
    workers.has(workerId) || Fail`unknown worker ${q(workerId)}`;
    const workerStore = store.provideWorkerStore(workerId);
    const { startNotify: previous, ...meta } = workerStore.getMeta();
    if (target === undefined) {
      if (previous !== undefined) hub.unpublish(previous);
      workerStore.setMeta(meta);
      return;
    }
    const position = importPositions.get(target);
    if (position === undefined) {
      throw Fail`start notice target must be an object held by the daemon endpoint`;
    }
    // Reusing the secret keeps a retried installation to one row. The secret
    // is recorded before the row is published: a crash between the two then
    // leaves a secret that names nothing, which the next startup reports and
    // a retry republishes under, rather than a pinned row nothing names.
    const secret = previous ?? randomHex128();
    workerStore.setMeta({ ...meta, startNotify: secret });
    hub.publishHeld(secret, { session: ENDPOINT_SESSION, position });
  };

  /**
   * A worker is going away for good: withdraw the publication its start
   * notice holds, which no later process could otherwise find or release.
   * @param {string} workerId
   */
  const withdrawStartNotice = workerId => {
    const { startNotify } = store.provideWorkerStore(workerId).getMeta();
    if (startNotify !== undefined) hub.unpublish(startNotify);
  };

  /**
   * A binding as it is recorded: its defined fields in one order, so the
   * same binding is the same key, or null for a daemon-wide singleton. A
   * binding to a worker names one this daemon serves.
   * @param {ResourceBinding | null | undefined} binding
   */
  const canonicalBinding = binding => {
    if (binding === undefined || binding === null) return null;
    (typeof binding === 'object' &&
      Object.keys(binding).every(
        field => field === 'workerId' || field === 'key',
      )) ||
      Fail`A resource binding names a worker and a key, or neither`;
    const { workerId, key } = binding;
    workerId === undefined ||
      (typeof workerId === 'string' && workers.has(workerId)) ||
      Fail`A resource is bound to a worker this daemon serves`;
    key === undefined ||
      typeof key === 'string' ||
      Fail`A resource key is a string`;
    if (workerId === undefined && key === undefined) return null;
    return harden({
      ...(workerId === undefined ? {} : { workerId }),
      ...(key === undefined ? {} : { key }),
    });
  };

  /**
   * A worker gone for good: its start notice withdrawn, its hub session's
   * table entry dropped with its rows (ids are random and never reused),
   * and its store deleted.
   * @param {string} workerId
   */
  const forgetWorker = workerId => {
    withdrawStartNotice(workerId);
    hub.forgetSession(workerId);
    store.deleteWorker(workerId);
  };

  /** @param {string} workerId */
  const retireWorkerNow = async workerId => {
    const entry = workers.get(workerId);
    if (entry !== undefined) {
      workers.delete(workerId);
      try {
        await entry.transport.retire();
      } catch (error) {
        // Still here: a caller that decides by `listWorkerIds` must see the
        // worker until it is gone, and retry the retirement rather than
        // forget a vat whose store and start notice survive.
        workers.set(workerId, entry);
        throw error;
      }
      entry.sink.detach();
    }
    forgetWorker(workerId);
    // Only now is the worker gone for good; what is bound to it can be
    // released: every host resource bound to the worker, whose instances
    // are forgotten and whose recorded exports a restart seats tombstones
    // for, and the native processes it launched. A failure here is
    // reported, not allowed to leave the worker half-retired: the store and
    // session are already deleted.
    const retireLog = logging.sub('thixotrope', 'daemon');
    try {
      records.retireResourcesWhere(
        (_, binding) => boundWorkerOf(binding) === workerId,
      );
    } catch (error) {
      // The next start retires what is bound to a worker it does not serve.
      retireLog.error('bound resources not retired:', error);
    }
    await nativeAdapters
      .retireWorker(workerId)
      .catch(error => retireLog.error('native adapters not retired:', error));
  };

  /**
   * Make a worker, or find the one made under the allocation key: a worker
   * is recorded with what it was made with, so a second allocation under
   * the key answers the same worker or refuses other options.
   * @param {{ debugLabel?: string, ephemeral?: boolean, allocationKey?: string }} options
   * @returns {string} the worker id
   */
  const allocateWorker = ({ debugLabel, ephemeral = false, allocationKey }) => {
    debugLabel === undefined ||
      typeof debugLabel === 'string' ||
      Fail`debugLabel must be a string`;
    typeof ephemeral === 'boolean' || Fail`ephemeral must be a boolean`;
    if (allocationKey !== undefined) {
      (typeof allocationKey === 'string' &&
        HEX128_PATTERN.test(allocationKey)) ||
        Fail`Expected a host-generated allocation key`;
      for (const [id] of workers) {
        const meta = store.provideWorkerStore(id).getMeta();
        if (meta.allocationKey === allocationKey) {
          (meta.debugLabel === debugLabel &&
            Boolean(meta.ephemeral) === ephemeral) ||
            Fail`Worker allocation options changed`;
          return id;
        }
      }
    }
    const workerId = randomHex128();
    if (debugLabel !== undefined || ephemeral || allocationKey !== undefined) {
      const workerStore = store.provideWorkerStore(workerId);
      workerStore.setMeta({
        ...workerStore.getMeta(),
        ...(debugLabel === undefined ? {} : { debugLabel }),
        ...(ephemeral ? { ephemeral: true } : {}),
        ...(allocationKey === undefined ? {} : { allocationKey }),
      });
    }
    provideWorkerSession(workerId);
    return workerId;
  };

  /**
   * Evaluate in a worker through its shell. Implicit harden: callers pass
   * plain records; the copy makes the wire's frozen-argument requirement
   * invisible to them.
   * @param {string} workerId
   * @param {string} source
   * @param {Record<string, unknown>} [endowments]
   */
  const evaluateIn = async (workerId, source, endowments = {}) => {
    const shell = await provideShell(workerId);
    return E(shell).evaluate(source, harden({ ...endowments }));
  };

  /**
   * @param {string} workerId
   * @returns {ThixotropeWorkerAdmin}
   */
  const makeWorkerAdmin = workerId => {
    const entryOf = () => {
      const entry = workers.get(workerId);
      if (entry === undefined) {
        throw Fail`worker ${q(workerId)} has been retired`;
      }
      return entry;
    };
    return harden({
      workerId,
      debugLabel: store.provideWorkerStore(workerId).getMeta().debugLabel,
      evaluate: (source, endowments = {}) =>
        evaluateIn(workerId, source, endowments),
      isAwake: () => entryOf().transport.isAwake(),
      wake: async () => entryOf().transport.wake(),
      sleep: async () => entryOf().transport.sleep(),
      retire: async () => retireWorkerNow(workerId),
      notifyOnStart: target => setStartNotice(workerId, target),
      clearStartNotice: () => setStartNotice(workerId, undefined),
    });
  };

  // Built-in resources: live in the endpoint like any resource.
  const makeWorkerFacadeResource = (/** @type {any} */ binding) => {
    const { workerId } = /** @type {{ workerId: string }} */ (binding);
    return Far('ThixotropeWorkerFacade', {
      help: () =>
        'ThixotropeWorkerFacade: evaluate(source, endowments) evaluates in this worker with the properties of the endowments record bound as named values; getId() returns the worker id; retire() permanently deletes the worker.',
      getId: () => workerId,
      // Return the guest shell so pending guest answers stay guest-to-guest.
      getEvaluator: () => provideShell(workerId),
      /**
       * @param {string} source
       * @param {Record<string, unknown>} [endowments]
       */
      evaluate: (source, endowments = {}) =>
        evaluateIn(workerId, source, endowments),
      retire: async () => retireWorkerNow(workerId),
      /**
       * Ask the host to call `started()` on `target` at every daemon startup.
       *
       * @param {object} target an object this worker holds
       */
      notifyOnStart: target => setStartNotice(workerId, target),
      clearStartNotice: () => setStartNotice(workerId, undefined),
    });
  };
  const makeWorkerControllerResource = () =>
    Far('ThixotropeWorkerController', {
      help: () =>
        'ThixotropeWorkerController: createWorker(debugLabel?) creates a durable worker and returns its facade; createEphemeralWorker(debugLabel?) creates one whose heap the next daemon startup discards.',
      /** @param {string} [debugLabel] */
      createWorker: async debugLabel =>
        records.provideResource('worker-facade', {
          workerId: allocateWorker({ debugLabel }),
        }),
      /**
       * A worker whose heap is not a recovery baseline: the next daemon
       * startup retires it rather than restoring it. For a guest that adapts
       * an ephemeral host resource and wants its working state — connections,
       * buffers, descriptors — to die with the process that held them, rather
       * than reasoning about which of it is safe to persist.
       *
       * References into it break when it is retired, and the hub's session
       * epoch guarantees they can never designate its successor.
       *
       * @param {string} [debugLabel]
       */
      createEphemeralWorker: async debugLabel =>
        records.provideResource('worker-facade', {
          workerId: allocateWorker({ debugLabel, ephemeral: true }),
        }),
    });
  const nativeAdapters = makeNativeAdapters(
    { adapterProcesses, random, timers },
    {
      hub,
      importBootstrap: id =>
        endpointResumed.provideImport({
          type: 'o',
          position: hub.introduce(ENDPOINT_SESSION, {
            session: id,
            position: 0n,
          }),
        }),
      bundlePath: digest => store.bundlePath(digest),
      // The owner hears of its adapter's own exit through the same held
      // object its start notice reaches, so a manager with anything desired
      // rebuilds between daemon starts as it does at one.
      onAdapterExit: workerId => {
        const report = (/** @type {unknown} */ error) =>
          logging
            .sub('thixotrope', 'daemon')
            .error(`exit notice for ${q(workerId)} failed:`, error);
        try {
          if (stopping || !workers.has(workerId)) return;
          const { startNotify } = store.provideWorkerStore(workerId).getMeta();
          if (startNotify === undefined) return;
          lookup(startNotify)
            .then(target => E(target).exited())
            .catch(report);
        } catch (error) {
          report(error);
        }
      },
    },
  );
  Object.assign(resourceMakers, resources, {
    'native-adapter': nativeAdapters.resource,
    'worker-facade': makeWorkerFacadeResource,
    'worker-controller': makeWorkerControllerResource,
  });

  // An ephemeral worker's heap is not a recovery baseline. Discard it before
  // anything can reattach to it, so its holders meet a tombstone rather than a
  // half-restored incarnation of whatever it was adapting. A clean shutdown
  // could have retired these, but a crash does not, so startup is the path
  // that has to be right.
  const storedWorkerIds = store
    .listWorkerIds()
    .filter(workerId => workerId !== ENDPOINT_ID);
  const ephemeralWorkers = storedWorkerIds
    .map(
      workerId =>
        /** @type {const} */ ([
          workerId,
          store.provideWorkerStore(workerId).getMeta(),
        ]),
    )
    .filter(([, meta]) => meta.ephemeral === true);
  // A resource bound to a worker this start will not serve, an ephemeral
  // one or one whose retirement ended between deleting its store and
  // nulling its records, is retired before the records are seated, so its
  // holders meet tombstones rather than instances for a worker that is gone.
  const surviving = new Set(
    storedWorkerIds.filter(
      workerId =>
        !ephemeralWorkers.some(([ephemeral]) => ephemeral === workerId),
    ),
  );
  records.retireResourcesWhere((_, binding) => {
    const bound = boundWorkerOf(binding);
    return bound !== undefined && !surviving.has(bound);
  });

  // Seat the endpoint's recorded exports before accepting any retained hub
  // output. Startup writes toward the hub wait until its sink is attached.
  records.restoreWorker(ENDPOINT_ID);
  endpoint.attach();

  for (const [workerId, meta] of ephemeralWorkers) {
    // An image left by an explicit sleep, or by a build that put ephemeral
    // workers to sleep at shutdown, will never be restored: release it with the
    // worker. A release that fails leaks one image; it must not stop the
    // sweep, or startup would fail on the same worker every time.
    const ref = meta.snapshot?.ref;
    if (ref !== undefined && engine.releaseSnapshot) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await engine.releaseSnapshot(ref);
      } catch (error) {
        logging
          .sub('thixotrope', 'daemon')
          .error('ephemeral worker image not released:', error);
      }
    }
    forgetWorker(workerId);
  }

  // Reattach worker transports asleep, after the endpoint can receive frames.
  for (const workerId of store.listWorkerIds()) {
    if (workerId !== ENDPOINT_ID) {
      provideWorkerSession(workerId);
    }
  }

  // Only after every session is seated does the daemon accept
  // connections: an early resume must never race the restore.
  netlayerRef.netlayer = await makeNetlayer({
    handlers: hubHandlers,
    logger: log.sub('netlayer'),
    resumption,
  });
  for (const token of store.listSessionTokens()) {
    const meta = store.provideSessionStore(token).getMeta();
    if (meta.retired)
      hub.retireSession(meta.hubSessionKey ?? `peer:${token}`, meta.hubEpoch);
  }
  // The transient sessions a previous process left, named before this one
  // can seat any of its own.
  const staleTransient = Object.keys(
    store.getHubState()?.sessions ?? {},
  ).filter(key => key.startsWith('transient:'));
  netlayerRef.netlayer.start?.();
  const { location } = netlayerRef.netlayer;

  // Gift redemptions interrupted by the previous process's death:
  // their withdrawals (and any queued traffic) persist in the hub
  // tables, but the dial in flight died with the process. Redial.
  for (const dial of hub.pendingDials()) {
    handoffDialRef.connect(dial.location, dial.sessionKey);
  }

  const stopDaemon = async () => {
    stopping = true;
    const transientFailure = makeFirstFailure();
    await nativeAdapters
      .shutdown()
      .catch(error => transientFailure.record(error));
    // A client still being constructed must finish before releasing the lease.
    await openingTransientClients.drain();
    for (const client of transientClients) {
      try {
        client.close();
      } catch (error) {
        transientFailure.record(error);
      }
    }
    transientClients.clear();
    for (const entry of workers.values()) entry.transport.end();
    try {
      // Drain every transport even when one termination fails. No queued wake
      // may outlive the state-directory ownership released by our caller.
      const results = await Promise.allSettled(
        [...workers.values()].map(entry => entry.transport.crash()),
      );
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
      transientFailure.assertNone();
    } finally {
      stopped = true;
      endpointClient.shutdown();
      netlayerRef.netlayer.shutdown();
    }
  };

  // An accepted dispatch can outlive the process before its worker runs.
  // Resume journal suffixes now: hub deduplication correctly suppresses a
  // second dispatch, so no future network traffic need wake these workers.
  // Checkpointed sleepers and quarantined workers remain asleep.
  try {
    // Peer connections without a resume token, HTTP sockets and other
    // transient host observers do not survive a process.
    // Cleanup is inside the startup failure guard: persistence refusal must
    // still stop all transports before releasing exclusive store ownership.
    for (const key of staleTransient) hub.forgetSession(key);
    await Promise.all(
      [...workers].map(async ([workerId, entry]) => {
        const workerStore = store.provideWorkerStore(workerId);
        const meta = workerStore.getMeta();
        if (
          meta.failure === undefined &&
          workerStore.journalLength() > (meta.snapshot?.cut ?? 0)
        ) {
          try {
            await entry.transport.wake();
          } catch (error) {
            // Fatal guest replay quarantines only that worker, just as live
            // delivery does. Infrastructure failures still abort startup.
            if (
              !(error instanceof WorkerHaltError) ||
              workerStore.getMeta().failure === undefined
            )
              throw error;
          }
        }
      }),
    );

    // Start notices, after every session is seated and the netlayer is up.
    //
    // No separate wake: the delivery is the wake.
    //
    // Awaited, within one bound for all of them. A caller that gets a
    // started daemon back is entitled to assume that whatever a notified vat
    // re-establishes — a bound socket, say — is in place, which send-only
    // would not give it. But a vat that cannot restore must not be able to
    // wedge startup, and one that fails must not abort it: the failure is
    // for that vat to report. Delivering the notices together keeps startup
    // latency from growing with the number of installed resources.
    const report = (/** @type {unknown} */ error) =>
      logging.sub('thixotrope', 'daemon').error('start notice failed:', error);
    /** @type {Array<Promise<unknown>>} */
    const notices = [];
    for (const [workerId] of workers) {
      const { startNotify } = store.provideWorkerStore(workerId).getMeta();
      if (startNotify !== undefined) {
        notices.push(
          lookup(startNotify)
            .then(target => E(target).started())
            .catch(report),
        );
      }
    }
    await settleWithin(timers, START_NOTICE_MS, Promise.all(notices));
  } catch (error) {
    await stopDaemon();
    throw error;
  }

  /** @param {{keep?: string[]}} [options] */
  const inspectReachability = ({ keep = [] } = {}) =>
    inspectVatReachability({
      workers: [...workers].map(([workerId, entry]) => {
        const { debugLabel } = store.provideWorkerStore(workerId).getMeta();
        return { workerId, awake: entry.transport.isAwake(), debugLabel };
      }),
      hubState: store.getHubState(),
      endpointExports: store.provideWorkerStore(ENDPOINT_ID).getTablesRecord()
        ?.exports,
      endpointPendingAnswers: [...pendingEndpointAnswers],
      connectedSessions: peers.connectedSessionKeys(),
      keep,
    });

  /** @type {ThixotropeDaemon} */
  const daemon = {
    location,
    makeSturdyRefDetails: secret => harden({ location, secret }),
    eval: async (source, endowments = {}) => {
      // The lambda-shaped entry point: evaluation implies a worker.
      return evaluateIn(allocateWorker({}), source, endowments);
    },
    createWorker: async (options = {}) =>
      makeWorkerAdmin(allocateWorker(options)),
    getWorker: workerId => {
      workers.has(workerId) || Fail`unknown worker ${q(workerId)}`;
      return makeWorkerAdmin(workerId);
    },
    listWorkerIds: () => [...workers.keys()].sort(),
    /**
     * Free every stored bundle that neither a native adapter's launcher
     * names (its key is the ephemeral bundle the launcher starts processes
     * from) nor the embedder keeps, the bundles of the installations it
     * still holds. One that none names belonged to an installation since
     * removed, or to a request the embedder never handed on, which a retry
     * stores again. The embedder calls it while no request is between the
     * store and its records, as at start before it accepts any. Returns the
     * digests freed.
     * @param {Iterable<string>} keep
     */
    sweepBundles: keep => {
      const named = new Set(keep);
      const endpointExports =
        store.provideWorkerStore(ENDPOINT_ID).getTablesRecord()?.exports ?? {};
      for (const recorded of Object.values(endpointExports)) {
        const found = /** @type {any} */ (recorded);
        const key = boundKeyOf(found?.binding);
        if (
          found?.kind === 'resource' &&
          found.name === 'native-adapter' &&
          key !== undefined
        )
          named.add(key);
      }
      const freed = store.listBundles().filter(digest => !named.has(digest));
      for (const digest of freed) store.deleteBundle(digest);
      return harden(freed);
    },
    makeResource: (name, binding = undefined) =>
      records.provideResource(name, canonicalBinding(binding)),
    retireResource: (name, binding = undefined) =>
      records.retireResource(name, canonicalBinding(binding)),
    // Persist a swissnum locator for this held capability. Remote bootstrap
    // fetch(secret) obtains it; withdrawing the locator leaves existing refs valid.
    publish: (value, secret = randomHex128()) => {
      const position = importPositions.get(value);
      if (position === undefined) {
        throw Fail`publish: value is not an import held by the daemon endpoint`;
      }
      hub.publishHeld(secret, { session: ENDPOINT_SESSION, position });
      return secret;
    },
    unpublish: secret => hub.unpublish(secret),
    lookup,
    openTransientClient: async () => {
      if (stopping) throw Error('Daemon is stopping');
      const opening = makeTransientHubClient(random, {
        codec,
        hub,
        sessionKey: `transient:${randomHex128()}`,
      });
      const client = await openingTransientClients.track(opening);
      const wrapped = harden({
        lookup: client.lookup,
        close: () => {
          client.close();
          transientClients.delete(wrapped);
        },
      });
      transientClients.add(wrapped);
      if (stopping) {
        wrapped.close();
        throw Error('Daemon is stopping');
      }
      return wrapped;
    },
    // Reuse the canonical peer session, including one established by a gift.
    // connect is idempotent for an attached/in-flight route; this sends fetch
    // through that session instead of starting another handshake on its socket.
    importReference: (remoteLocation, secret) => {
      const { sessionKey: key, location: dialLocation } =
        hub.prepareRemoteSession(remoteLocation);
      const position = hub.introduce(ENDPOINT_SESSION, {
        session: key,
        position: 0n,
      });
      handoffDialRef.connect(dialLocation, key);
      const bootstrap = endpointResumed.provideImport({ type: 'o', position });
      return E(bootstrap).fetch(encodeSwissnum(secret));
    },
    inspectReachability,
    collectVats: async ({ keep = [] } = {}) => {
      // A kept vat its owner retires meanwhile is no longer a vat to keep.
      const live = () => keep.filter(workerId => workers.has(workerId));
      const candidates = inspectReachability({ keep: live() }).collectible;
      const swept = [];
      for (const workerId of candidates) {
        // Retirement yields: a new root or message may have appeared since the
        // previous victim. Recheck instead of sweeping a stale candidate list.
        if (
          inspectReachability({ keep: live() }).collectible.includes(workerId)
        ) {
          // eslint-disable-next-line no-await-in-loop
          await retireWorkerNow(workerId);
          swept.push(workerId);
        }
      }
      return harden(swept.sort());
    },
    shutdown: async () => {
      // Exit notices stop first: one delivered while vats are put to sleep
      // would wake a vat just put to sleep.
      nativeAdapters.quiesce();
      try {
        for (const [workerId, entry] of workers) {
          // An ephemeral worker's heap is discarded at the next startup, so
          // a parting image would be I/O for something nobody restores; it
          // is terminated with the rest instead of put to sleep.
          const { ephemeral } = store.provideWorkerStore(workerId).getMeta();
          if (ephemeral !== true) {
            // eslint-disable-next-line no-await-in-loop
            await entry.transport.sleep();
          }
        }
      } finally {
        // A later vat can reopen one put to sleep earlier, and a failed sleep must
        // still stop intake before terminating every remaining incarnation.
        await stopDaemon();
      }
    },
    crash: stopDaemon,
  };
  return harden(daemon);
};
/**
 * Acquire engine ownership before reading or restoring daemon state.
 * @param {object} powers
 * @param {TimerPowers} powers.timers
 * @param {RandomPowers} powers.random
 * @param {Logger} powers.logging
 * @param {Parameters<typeof buildDaemon>[1] & { validateState?: () => void | Promise<void> }} options
 *   `validateState` runs under the store lease before any worker is
 *   restored; throw from it to refuse startup
 */
export const makeThixotropeDaemon = async (powers, options) => {
  const release = await options.engine.acquireStore?.(options.store.statePath);
  try {
    // The embedder's own state (a workspace's metadata version, say) is
    // checked under the lease and before any worker is restored, so a state
    // directory this build cannot serve is refused without touching it.
    if (options.validateState !== undefined) await options.validateState();
    /** @param {any} record @returns {any} */
    const guard = record =>
      harden(
        Object.fromEntries(
          Object.entries(record).map(([key, value]) => [
            key,
            typeof value !== 'function'
              ? value
              : (...args) => {
                  options.engine.assertStoreOwnership?.();
                  const result = Reflect.apply(value, record, args);
                  return key === 'provideWorkerStore' ||
                    key === 'provideSessionStore'
                    ? guard(result)
                    : result;
                },
          ]),
        ),
      );
    const daemon = await buildDaemon(powers, {
      ...options,
      store: guard(options.store),
    });
    /** @type {Promise<void> | undefined} */
    let closing;
    /** @param {() => Promise<void>} stop */
    const close = stop => {
      closing ??= (async () => {
        try {
          await stop();
        } finally {
          await release?.();
        }
      })();
      return closing;
    };
    return harden({
      ...daemon,
      shutdown: () => close(daemon.shutdown),
      crash: () => close(daemon.crash),
      inspectWorkers: () =>
        harden(
          daemon.listWorkerIds().map(workerId => {
            const workerStore = options.store.provideWorkerStore(workerId);
            // Meta carries two keys that must not leave the daemon: the
            // start-notice publication secret and the allocation key.
            const {
              startNotify,
              allocationKey: _allocationKey,
              ...meta
            } = workerStore.getMeta();
            return harden({
              workerId,
              ...meta,
              startNotice: startNotify !== undefined,
              journalLength: workerStore.journalLength(),
              awake: daemon.getWorker(workerId).isAwake(),
            });
          }),
        ),
    });
  } catch (error) {
    await release?.();
    throw error;
  }
};
harden(makeThixotropeDaemon);
