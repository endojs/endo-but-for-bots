// @ts-check
/** @import { LogPowers } from '../platform/logging.js' */
/** @import { RandomPowers } from '../platform/random.js' */
/** @import { TimerPowers } from '../platform/timers.js' */
import harden from '@endo/harden';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { Fail, q } from '@endo/errors';
import { E, Far } from '@endo/far';
import { makeOcapn } from '@endo/ocapn';
import { encodeSwissnum, swissnumFromBytes } from '@endo/ocapn/client/util';
import { makeCryptography, makeSessionId } from '@endo/ocapn/cryptography';
import {
  readOcapnHandshakeMessage,
  writeOcapnHandshakeMessage,
} from '@endo/ocapn/operations';

import { makeOcapnHub } from '../net/hub.js';
import { makeDurableWorkerTransport } from './durable-worker-transport.js';
import { makeEphemeralHubClient } from '../net/ephemeral-hub-client.js';
import { derivePipeResumption } from '../net/pipe-network.js';
import { isSessionToken } from '../store/store-validators.js';
import { inspectVatReachability } from './vat-reachability.js';
import { WorkerHaltError } from './worker-engine.js';
import { makeWorkerSessionRecords } from './worker-session-records.js';

/**
 * @import {ERef, FarRef} from '@endo/eventual-send'
 * @import {Connection, OcapnBootstrap} from '@endo/ocapn/client/types'
 * @import {WorkerEngine} from './worker-engine.js'
 * @import {ThixotropeStore} from '../store/store-fs.js'
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
 * @typedef {object} ThixotropeWorkerFacade
 * @property {string} workerId
 * @property {string | undefined} debugLabel
 * @property {(source: string, endowments?: Record<string, unknown>) => Promise<any>} evaluate
 * @property {() => boolean} isAwake
 * @property {() => Promise<void>} wake
 * @property {() => Promise<void>} sleep
 * @property {() => Promise<void>} retire
 *
 * @typedef {object} ThixotropeDaemon
 * @property {any} location this daemon's OCapN location; combine with a
 *   publication's swissnum to mint a sturdy ref on any peer
 * @property {(secret: string) => { location: any, secret: string }} makeSturdyRefDetails
 * @property {(source: string, endowments?: Record<string, unknown>) => Promise<any>} eval
 *   evaluate in a fresh implicitly-created worker and return the
 *   result; the worker persists like any other (find it via
 *   `listWorkerIds`, retire it via `getWorker(id).retire()`)
 * @property {(options?: { debugLabel?: string }) => Promise<ThixotropeWorkerFacade>} createWorker
 * @property {(workerId: string) => ThixotropeWorkerFacade} getWorker
 * @property {() => Array<string>} listWorkerIds
 * @property {(name: string, description?: unknown) => object} makeResource
 * @property {(value: object, secret?: string) => string} publish
 * @property {(secret: string) => void} unpublish
 * @property {(location: any, secret: string) => Promise<any>} importReference fetch a remote publication through the durable hub session
 * @property {() => Promise<Awaited<ReturnType<typeof makeEphemeralHubClient>>>} openEphemeralClient open disposable host request/observer session
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
// descriptions, pending answers) live in this worker store.
const ENDPOINT_ID = 'e'.repeat(32);
const ENDPOINT_SESSION = 'endpoint';

/**
 * @param {object} powers
 * @param {TimerPowers} powers.timers
 * @param {RandomPowers} powers.random
 * @param {LogPowers} powers.logging
 * @param {object} options
 * @param {ThixotropeStore} options.store
 * @param {WorkerEngine} options.engine
 * @param {any} options.codec an OCapN codec, e.g. `syrupCodec`
 * @param {(powers: { handlers: any, logger: any, resumption: any }) => Promise<any> | any} options.makeNetlayer
 * @param {Record<string, (description?: unknown) => object>} [options.resources]
 * @param {number} [options.idleSleepMs] park a worker after this long
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
    idleSleepMs = undefined,
    verbose = false,
  },
) => {
  // 128 random bits as lowercase hex: worker ids and default swissnums.
  const randomHex128 = () => {
    const bytes = random.randomBytes(16);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  };

  const logError = verbose
    ? (...args) => logging.error('thixotrope daemon:', ...args)
    : () => {};

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

  // Records scoped to the endpoint: resource descriptions per export
  // slot, and at-most-once answer obligations. Links and forwarders
  // no longer arise — the hub carries all cross-session references.
  const resourceMakers = /** @type {Record<string, any>} */ ({});
  const records = makeWorkerSessionRecords({
    store,
    resources: resourceMakers,
    reportError: error => logging.error('thixotrope worker sessions:', error),
  });

  /**
   * Endpoint import presence -> hub-facing position, for `publish`.
   * Weak, so the map does not itself pin every import the endpoint
   * ever saw.
   *
   * @type {WeakMap<object, bigint>}
   */
  const importPositions = new WeakMap();

  /** @type {any} */
  let endpointSink;
  /** @type {any} */
  let endpointHandlers;
  const endpointResumption = derivePipeResumption({
    codec,
    workerId: ENDPOINT_ID,
    role: 'worker',
  });
  // These are outgoing answer positions, not restored incoming resolver obligations.
  // Settled cached answers and imports do not independently pin their vats.
  const pendingEndpointAnswers = new Set();
  const endpointClient = await makeOcapn({
    logger: harden({ log: logError, error: logError, info: () => {} }),
    randomBytes: length => random.randomBytes(length),
    codec,
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
    network: (/** @type {any} */ h) => {
      endpointHandlers = h;
      return harden({
        networkId: 'thixotrope-endpoint',
        codec,
        location: harden({
          type: /** @type {const} */ ('ocapn-peer'),
          network: 'thixotrope-endpoint',
          transport: 'thixotrope-endpoint',
          designator: 'endpoint',
          hints: /** @type {const} */ (false),
        }),
        shutdown: () => {},
      });
    },
  });
  // The endpoint's session with the hub: established through the
  // resumeSession seam (handshake-free, restorable exports), frames
  // flowing directly between the hub duct and the client's message
  // handler.
  let stopped = false;
  let stopping = false;
  /** @type {Set<Awaited<ReturnType<typeof makeEphemeralHubClient>>>} */
  const transientClients = new Set();
  /** @type {Set<Promise<Awaited<ReturnType<typeof makeEphemeralHubClient>>>>} */
  const openingTransientClients = new Set();
  /** @type {Uint8Array[]} */
  const endpointOutbound = [];
  const endpointConnection = harden({
    netlayer: harden({ location: endpointResumption.peerLocation }),
    isOutgoing: true,
    get isDestroyed() {
      return stopped;
    },
    write: (/** @type {Uint8Array} */ bytes) => {
      if (stopped) return;
      if (endpointSink === undefined) endpointOutbound.push(bytes);
      else endpointSink.deliver(bytes);
    },
    end: () => {},
  });
  records.registerWorkerConnection(endpointConnection, ENDPOINT_ID);
  const endpointResumed = endpointHandlers.resumeSession(
    endpointConnection,
    endpointResumption,
  );
  records.registerResumedSession(ENDPOINT_ID, endpointResumed);

  // --- remote peers: netlayer sessions on the hub ---

  /** @type {Map<object, { deliver: any, detach: any, key: string } | undefined>} */
  const connectionSessions = new Map();

  /** @type {any} */
  const netlayerRef = {};

  /**
   * @param {any} connection
   * @param {string} sessionKey
   * @param {{ sessionId: any, peerPublicKeyQ: any, selfPrivateKeyBytes?: any }} [identity]
   *   the wire identity from the handshake; omitted on resume
   */
  const bindConnectionToHub = (
    connection,
    sessionKey,
    identity = undefined,
  ) => {
    const sink = hub.attachSession(sessionKey, {
      send: (
        /** @type {Uint8Array} */ bytes,
        /** @type {string | undefined} */ sequence = undefined,
      ) => connection.write(bytes, sequence),
      // Resumable peers and outbound exporter sessions are durable:
      // frames toward them queue across a disconnect. An ephemeral
      // peer that is gone is gone.
      durable:
        sessionKey.startsWith('peer:') || sessionKey.startsWith('handoff:'),
      requireAcceptance:
        connection.netlayer.getResumeToken?.(connection) !== undefined,
      // A bad frame from beyond the process boundary aborts the
      // session and drops the connection.
      remote: true,
      onAbort: () => connection.end(),
      // The wire identity from the handshake, against which the hub
      // verifies gift handoff signatures. On resume (no handshake)
      // the persisted identity carries over.
      identity,
    });
    connectionSessions.set(connection, {
      deliver: sink.deliver,
      detach: sink.detach,
      key: sessionKey,
    });
    return sink;
  };

  /** @param {any} connection */
  const sessionKeyForConnection = connection => {
    const { netlayer } = netlayerRef;
    const token =
      netlayer !== undefined && netlayer.getResumeToken !== undefined
        ? netlayer.getResumeToken(connection)
        : undefined;
    if (token !== undefined && isSessionToken(token)) {
      return `peer:${token}`;
    }
    // Ephemeral keys must be globally unique forever: a counter would
    // reset in a successor process and inherit the persisted hub
    // tables of a previous process's connection.
    return `conn:${randomHex128()}`;
  };

  /**
   * @param {any} connection
   * @param {Record<string, any>} update
   */
  const saveHandshake = (connection, update) => {
    const token = netlayerRef.netlayer?.getResumeToken?.(connection);
    if (token === undefined) return;
    const sessionStore = store.provideSessionStore(token);
    sessionStore.setMeta({ ...sessionStore.getMeta(), ...update });
  };

  /**
   * @param {any} connection
   * @param {string} sessionKey
   * @param {any} identity
   * @param {Record<string, any>} [extra]
   */
  const saveIdentity = (connection, sessionKey, identity, extra = {}) => {
    saveHandshake(connection, {
      ...extra,
      hubSessionKey: sessionKey,
      hubEpoch: hub.getSessionEpoch(sessionKey),
      identity: {
        sessionIdB64: encodeBase64(identity.sessionId),
        peerPublicKeyQB64: encodeBase64(identity.peerPublicKeyQ),
        selfPrivateKeyB64: encodeBase64(identity.selfPrivateKeyBytes),
      },
    });
  };

  const captpVersion = '1.0';

  // --- outbound exporter sessions for hub gift redemption ---

  /**
   * Outgoing connections whose op:start-session reply is pending:
   * connection -> the dial in progress.
   *
   * @type {Map<object, { sessionKey: string, keyPair: any, privateKeyBytes: Uint8Array }>}
   */
  const pendingOutbound = new Map();
  /** @type {Set<string>} handoff session keys currently connected/dialing */
  const dialingSessions = new Set();

  /**
   * The hub's `handoffs.connect` power: dial an exporter, perform the
   * client side of the op:start-session handshake, and attach the
   * connection to the hub under the given session key. Idempotent per
   * key while a dial or connection is live.
   *
   * @param {any} location
   * @param {string} sessionKey
   */
  handoffDialRef.connect = (location, sessionKey) => {
    if (dialingSessions.has(sessionKey)) {
      return;
    }
    dialingSessions.add(sessionKey);
    try {
      const connection = netlayerRef.netlayer.connect(location);
      const { keyPair, privateKeyBytes } =
        cryptography.makeOcapnKeyPairWithPrivateBytes();
      pendingOutbound.set(connection, { sessionKey, keyPair, privateKeyBytes });
      const { location: myLocation } = netlayerRef.netlayer;
      const locationSignature = cryptography.signLocation(
        myLocation,
        keyPair,
        new ArrayBuffer(0),
      );
      const request = writeOcapnHandshakeMessage(
        {
          type: 'op:start-session',
          captpVersion,
          sessionPublicKey: keyPair.publicKey.descriptor,
          location: myLocation,
          locationSignature,
        },
        codec,
      );
      saveHandshake(connection, {
        hubSessionKey: sessionKey,
        hubEpoch: hub.getSessionEpoch(sessionKey),
        pendingPrivateKeyB64: encodeBase64(privateKeyBytes),
        handshakeRequest: encodeBase64(request),
      });
      connection.write(request);
    } catch (error) {
      dialingSessions.delete(sessionKey);
      logError('handoff dial failed:', error);
      // A committed withdrawal remains an obligation. Local admission or
      // storage failure does not prove that its destination is retired.
      throw error;
    }
  };

  /** @type {any} */
  const hubHandlers = harden({
    makeConnection: (
      /** @type {any} */ netlayer,
      /** @type {boolean} */ isOutgoing,
      /** @type {any} */ socket,
    ) => {
      let destroyed = false;
      /** @type {any} */
      const connection = harden({
        netlayer,
        isOutgoing,
        get isDestroyed() {
          return destroyed;
        },
        write: (
          /** @type {Uint8Array} */ bytes,
          /** @type {string | undefined} */ sequence = undefined,
        ) => socket.write(bytes, sequence),
        end: () => {
          if (!destroyed) {
            destroyed = true;
            socket.end();
          }
        },
      });
      connectionSessions.set(connection, undefined);
      return connection;
    },
    handleMessageData: (
      /** @type {any} */ connection,
      /** @type {Uint8Array} */ data,
      /** @type {number | bigint | undefined} */ sequenceNumber = undefined,
    ) => {
      if (stopped) return;
      const bound = connectionSessions.get(connection);
      if (bound !== undefined) {
        // The first frame is the handshake, whose intent and identity were
        // persisted before its effects. Inbox replay must not decode it as
        // an ordinary OCapN message after restoration already bound the hub.
        if (sequenceNumber !== undefined && BigInt(sequenceNumber) === 1n)
          return;
        bound.deliver(data, sequenceNumber);
        return;
      }
      const resumeToken = netlayerRef.netlayer?.getResumeToken?.(connection);
      if (resumeToken !== undefined) {
        const saved = store.provideSessionStore(resumeToken).getMeta();
        if (saved.identity !== undefined) {
          // Resume a handoff interrupted by an I/O error in this process.
          // Do not generate a different key after the peer saw our response.
          resumption.restoreSession(hubHandlers, connection, resumeToken);
          if (sequenceNumber !== undefined && BigInt(sequenceNumber) === 1n)
            return;
          connectionSessions.get(connection)?.deliver(data, sequenceNumber);
          return;
        }
      }
      const dial = pendingOutbound.get(connection);
      if (dial !== undefined) {
        // The exporter's reply to our outbound handshake.
        let verified = false;
        try {
          const reader = codec.makeReader(data);
          const message = readOcapnHandshakeMessage(reader);
          message.type === 'op:start-session' ||
            Fail`expected op:start-session, got ${q(message.type)}`;
          message.captpVersion === captpVersion ||
            Fail`invalid captp version ${q(message.captpVersion)}`;
          const peerPublicKey = cryptography.makeOcapnPublicKey(
            message.sessionPublicKey.q,
          );
          cryptography.assertLocationSignatureValid(
            message.location,
            message.locationSignature,
            peerPublicKey,
            new ArrayBuffer(0),
          );
          verified = true;
          const sessionId = makeSessionId(
            dial.keyPair.publicKey.id,
            peerPublicKey.id,
          );
          const identity = {
            sessionId,
            peerPublicKeyQ: message.sessionPublicKey.q,
            selfPrivateKeyBytes: dial.privateKeyBytes,
          };
          saveIdentity(connection, dial.sessionKey, identity);
          bindConnectionToHub(connection, dial.sessionKey, identity);
          pendingOutbound.delete(connection);
        } catch (error) {
          if (verified) throw error;
          pendingOutbound.delete(connection);
          logError('handoff handshake failed:', error);
          dialingSessions.delete(dial.sessionKey);
          hub.retireSession(dial.sessionKey);
          connection.end();
        }
        return;
      }
      // Handshake: answer op:start-session with a per-connection
      // identity, then bind the connection to a hub session.
      let verified = false;
      try {
        const reader = codec.makeReader(data);
        const message = readOcapnHandshakeMessage(reader);
        message.type === 'op:start-session' ||
          Fail`expected op:start-session, got ${q(message.type)}`;
        message.captpVersion === captpVersion ||
          Fail`invalid captp version ${q(message.captpVersion)}`;
        const peerPublicKey = cryptography.makeOcapnPublicKey(
          message.sessionPublicKey.q,
        );
        cryptography.assertLocationSignatureValid(
          message.location,
          message.locationSignature,
          peerPublicKey,
          new ArrayBuffer(0),
        );
        verified = true;
        const { keyPair, privateKeyBytes } =
          cryptography.makeOcapnKeyPairWithPrivateBytes();
        const { location } = netlayerRef.netlayer;
        const locationSignature = cryptography.signLocation(
          location,
          keyPair,
          new ArrayBuffer(0),
        );
        const sessionId = makeSessionId(keyPair.publicKey.id, peerPublicKey.id);
        const response = writeOcapnHandshakeMessage(
          {
            type: 'op:start-session',
            captpVersion,
            sessionPublicKey: keyPair.publicKey.descriptor,
            location,
            locationSignature,
          },
          codec,
        );
        const sessionKey = sessionKeyForConnection(connection);
        const identity = {
          sessionId,
          peerPublicKeyQ: message.sessionPublicKey.q,
          selfPrivateKeyBytes: privateKeyBytes,
        };
        // One document records the response and identity before either can
        // become observable. A successor completes an interrupted handshake.
        saveIdentity(connection, sessionKey, identity, {
          handshakeResponse: encodeBase64(response),
        });
        connection.write(response);
        bindConnectionToHub(connection, sessionKey, identity);
      } catch (error) {
        if (verified) throw error;
        logError('handshake failed:', error);
        connection.write(
          writeOcapnHandshakeMessage(
            { type: 'op:abort', reason: 'invalid handshake' },
            codec,
          ),
        );
        connection.end();
      }
    },
    handleConnectionClose: (/** @type {any} */ connection) => {
      if (stopped) return;
      const dial = pendingOutbound.get(connection);
      if (dial !== undefined) {
        // The dial died before its handshake: the gift withdrawal can
        // never happen; retire the session so its rows break loudly.
        pendingOutbound.delete(connection);
        dialingSessions.delete(dial.sessionKey);
        hub.retireSession(dial.sessionKey);
      }
      const bound = connectionSessions.get(connection);
      connectionSessions.delete(connection);
      if (bound === undefined) {
        return;
      }
      if (bound.key.startsWith('conn:')) {
        // An ephemeral peer never comes back: retire its rows (holders
        // break loudly) and drop its table entry — the key is never
        // reused.
        hub.forgetSession(bound.key);
      } else {
        // A resumable peer (or exporter) may return: detach so hub
        // frames queue; a future gift toward the exporter redials.
        bound.detach();
        if (bound.key.startsWith('handoff:')) {
          dialingSessions.delete(bound.key);
        }
      }
    },
    resumeSession: () => {
      throw Error('thixotrope hub daemon: client resumeSession seam unused');
    },
  });

  /**
   * Each session document atomically owns its incoming and outgoing frames,
   * watermarks, incarnation, and handshake recovery state. The filesystem
   * store publishes this document with fsync + rename + directory fsync.
   */
  const resumption = harden({
    isDurableToken: (/** @type {string} */ token) => isSessionToken(token),
    listSessions: () => store.listSessionTokens(),
    isRetired: (/** @type {string} */ token) =>
      store.listSessionTokens().includes(token) &&
      Boolean(store.provideSessionStore(token).getMeta().retired),
    recordRetirementConfirmed: (/** @type {string} */ token) => {
      const sessionStore = store.provideSessionStore(token);
      const meta = sessionStore.getMeta();
      meta.retired || Fail`cannot confirm retirement of a live session`;
      sessionStore.setMeta({ ...meta, retirementConfirmed: true });
    },
    recordPeerDurability: (
      /** @type {string} */ token,
      /** @type {'restart' | 'process'} */ scope,
    ) => {
      const sessionStore = store.provideSessionStore(token);
      const meta = sessionStore.getMeta();
      meta.peerDurability === undefined ||
        meta.peerDurability === scope ||
        Fail`peer durability changed within a session`;
      sessionStore.setMeta({ ...meta, peerDurability: scope });
    },
    onHello: (
      /** @type {string} */ token,
      /** @type {any} */ location = undefined,
    ) => {
      !store.listSessionTokens().includes(token) ||
        Fail`durable session token has already been used`;
      store.provideSessionStore(token).setMeta({
        version: 2,
        isOriginator: location !== undefined,
        ...(location === undefined ? {} : { location }),
        recvSeq: '0',
        sendSeq: '0',
        ackSeq: '0',
        processedSeq: '0',
        hubDelivery: '0',
        frames: [],
        inbox: [],
      });
    },
    loadForResume: (/** @type {string} */ token) => {
      if (!store.listSessionTokens().includes(token)) return undefined;
      const meta = store.provideSessionStore(token).getMeta();
      // Receipt-only v1 records cannot establish durable acceptance.
      if (meta.version !== 2) return undefined;
      return {
        recvSeq: meta.recvSeq,
        sendSeq: meta.sendSeq,
        ackSeq: meta.ackSeq,
        hubDelivery: meta.hubDelivery,
        isOriginator: meta.isOriginator,
        location: meta.location,
        peerDurability: meta.peerDurability,
        retired: Boolean(meta.retired),
        retirementConfirmed: Boolean(meta.retirementConfirmed),
        frames: meta.frames.map((/** @type {any} */ frame) => ({
          n: frame.n,
          bytes: decodeBase64(frame.b64),
        })),
        inbox: meta.inbox.map((/** @type {any} */ frame) => ({
          n: frame.n,
          bytes: decodeBase64(frame.b64),
        })),
      };
    },
    restoreSession: (
      /** @type {any} */ _handlers,
      /** @type {any} */ connection,
      /** @type {string} */ token,
    ) => {
      const meta = store.provideSessionStore(token).getMeta();
      if (meta.retired) return;
      // A crash can occur after recording the handshake intent but before
      // the transport accepts its first outgoing frame.
      const firstFrame = meta.handshakeResponse ?? meta.handshakeRequest;
      if (meta.sendSeq === '0' && firstFrame !== undefined) {
        connection.write(decodeBase64(firstFrame));
      }
      if (meta.identity !== undefined) {
        bindConnectionToHub(connection, meta.hubSessionKey, {
          sessionId: decodeBase64(meta.identity.sessionIdB64),
          peerPublicKeyQ: decodeBase64(meta.identity.peerPublicKeyQB64),
          selfPrivateKeyBytes: decodeBase64(meta.identity.selfPrivateKeyB64),
        });
        if (meta.hubSessionKey.startsWith('handoff:'))
          dialingSessions.add(meta.hubSessionKey);
      } else if (meta.pendingPrivateKeyB64 !== undefined) {
        const privateKeyBytes = decodeBase64(meta.pendingPrivateKeyB64);
        pendingOutbound.set(connection, {
          sessionKey: meta.hubSessionKey,
          privateKeyBytes,
          keyPair: cryptography.makeOcapnKeyPairFromPrivateKey(privateKeyBytes),
        });
        dialingSessions.add(meta.hubSessionKey);
      }
    },
    recordOutbound: (
      /** @type {string} */ token,
      /** @type {bigint} */ n,
      /** @type {Uint8Array} */ bytes,
      /** @type {string | undefined} */ hubSequence = undefined,
    ) => {
      const sessionStore = store.provideSessionStore(token);
      const meta = sessionStore.getMeta();
      !meta.retired || Fail`durable session is retired`;
      n === BigInt(meta.sendSeq) + 1n || Fail`outbound sequence gap`;
      sessionStore.setMeta({
        ...meta,
        sendSeq: String(n),
        ...(hubSequence === undefined ? {} : { hubDelivery: hubSequence }),
        frames: [...meta.frames, { n: String(n), b64: encodeBase64(bytes) }],
      });
    },
    recordAck: (/** @type {string} */ token, /** @type {bigint} */ n) => {
      const sessionStore = store.provideSessionStore(token);
      const meta = sessionStore.getMeta();
      n <= BigInt(meta.sendSeq) ||
        Fail`acknowledgement exceeds issued sequence`;
      if (n <= BigInt(meta.ackSeq)) return;
      sessionStore.setMeta({
        ...meta,
        ackSeq: String(n),
        frames: meta.frames.filter(
          (/** @type {any} */ frame) => BigInt(frame.n) > n,
        ),
      });
    },
    recordInbound: (
      /** @type {string} */ token,
      /** @type {bigint} */ n,
      /** @type {Uint8Array} */ bytes,
    ) => {
      const sessionStore = store.provideSessionStore(token);
      const meta = sessionStore.getMeta();
      !meta.retired || Fail`durable session is retired`;
      if (n <= BigInt(meta.recvSeq)) return;
      n === BigInt(meta.recvSeq) + 1n || Fail`inbound sequence gap`;
      sessionStore.setMeta({
        ...meta,
        recvSeq: String(n),
        inbox: [...meta.inbox, { n: String(n), b64: encodeBase64(bytes) }],
      });
    },
    recordProcessed: (/** @type {string} */ token, /** @type {bigint} */ n) => {
      const sessionStore = store.provideSessionStore(token);
      const meta = sessionStore.getMeta();
      if (meta.retired || n <= BigInt(meta.processedSeq)) return;
      n === BigInt(meta.processedSeq) + 1n || Fail`processed sequence gap`;
      n <= BigInt(meta.recvSeq) || Fail`processing unaccepted frame`;
      sessionStore.setMeta({
        ...meta,
        processedSeq: String(n),
        inbox: meta.inbox.filter(
          (/** @type {any} */ frame) => BigInt(frame.n) > n,
        ),
      });
    },
    onEnd: (/** @type {string} */ token) => {
      const sessionStore = store.provideSessionStore(token);
      const meta = sessionStore.getMeta();
      // Never reuse a retired incarnation after releasing its dedup state.
      sessionStore.setMeta({ ...meta, retired: true, frames: [], inbox: [] });
      hub.retireSession(meta.hubSessionKey ?? `peer:${token}`, meta.hubEpoch);
    },
  });

  // --- the embedder API, through the endpoint ---

  const endpointSessionP = endpointClient.provideSession(
    endpointResumption.peerLocation,
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

  /** @param {string} workerId */
  const retireWorkerNow = async workerId => {
    const entry = workers.get(workerId);
    if (entry !== undefined) {
      workers.delete(workerId);
      await entry.transport.retire();
      entry.sink.detach();
    }
    // Worker ids are random and never reused: drop the session's
    // table entry along with its rows.
    hub.forgetSession(workerId);
    store.deleteWorker(workerId);
  };

  /**
   * @param {string} workerId
   * @returns {ThixotropeWorkerFacade}
   */
  const makeAdminFacade = workerId => {
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
      evaluate: async (source, endowments = {}) => {
        const shell = await provideShell(workerId);
        // Implicit harden: callers pass plain records; the copy makes
        // the wire's frozen-argument requirement invisible to them.
        return E(shell).evaluate(source, harden({ ...endowments }));
      },
      isAwake: () => entryOf().transport.isAwake(),
      wake: async () => entryOf().transport.wake(),
      sleep: async () => entryOf().transport.sleep(),
      retire: async () => retireWorkerNow(workerId),
    });
  };

  // Built-in resources: live in the endpoint like any resource.
  const makeWorkerFacadeResource = (/** @type {any} */ description) => {
    const { workerId } = /** @type {{ workerId: string }} */ (description);
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
      evaluate: async (source, endowments = {}) => {
        const shell = await provideShell(workerId);
        return E(shell).evaluate(source, harden({ ...endowments }));
      },
      retire: async () => retireWorkerNow(workerId),
    });
  };
  const makeWorkerControllerResource = () =>
    Far('ThixotropeWorkerController', {
      help: () =>
        'ThixotropeWorkerController: createWorker(debugLabel?) creates a new worker and returns its facade.',
      /** @param {string} [debugLabel] */
      createWorker: async debugLabel => {
        debugLabel === undefined ||
          typeof debugLabel === 'string' ||
          Fail`debugLabel must be a string`;
        const workerId = randomHex128();
        if (debugLabel !== undefined) {
          const workerStore = store.provideWorkerStore(workerId);
          workerStore.setMeta({ ...workerStore.getMeta(), debugLabel });
        }
        provideWorkerSession(workerId);
        return records.provideResource('worker-facade', { workerId });
      },
    });
  Object.assign(resourceMakers, resources, {
    'worker-facade': makeWorkerFacadeResource,
    'worker-controller': makeWorkerControllerResource,
  });

  // Seat the endpoint's recorded exports before accepting any retained hub
  // output. Startup writes toward the hub wait until its sink is attached.
  records.restoreWorker(ENDPOINT_ID);
  endpointSink = hub.attachSession(ENDPOINT_SESSION, {
    send: (/** @type {Uint8Array} */ bytes) =>
      endpointHandlers.handleMessageData(endpointConnection, bytes),
  });
  for (const bytes of endpointOutbound.splice(0)) endpointSink.deliver(bytes);

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
    logger: harden({
      log: logError,
      error: logError,
      info: logError,
    }),
    resumption,
  });
  for (const token of store.listSessionTokens()) {
    const meta = store.provideSessionStore(token).getMeta();
    if (meta.retired)
      hub.retireSession(meta.hubSessionKey ?? `peer:${token}`, meta.hubEpoch);
  }
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
    // A client still being constructed must finish before releasing the lease.
    await Promise.allSettled([...openingTransientClients]);
    /** @type {unknown} */
    let transientFailure;
    for (const client of transientClients) {
      try {
        client.close();
      } catch (error) {
        transientFailure ??= error;
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
      if (transientFailure !== undefined) throw transientFailure;
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
    // HTTP sockets and other transient host observers do not survive a process.
    // Cleanup is inside the startup failure guard: persistence refusal must
    // still stop all transports before releasing exclusive store ownership.
    for (const key of Object.keys(store.getHubState()?.sessions ?? {})) {
      if (key.startsWith('transient:')) hub.forgetSession(key);
    }
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
  } catch (error) {
    await stopDaemon();
    throw error;
  }

  /** @param {{keep?: string[]}} [options] */
  const inspectReachability = ({ keep = [] } = {}) =>
    inspectVatReachability({
      workers: [...workers].map(([workerId, entry]) => ({
        workerId,
        awake: entry.transport.isAwake(),
        debugLabel: store.provideWorkerStore(workerId).getMeta().debugLabel,
      })),
      hubState: store.getHubState(),
      endpointExports: store.provideWorkerStore(ENDPOINT_ID).getTablesRecord()
        ?.exports,
      endpointPendingAnswers: [...pendingEndpointAnswers],
      connectedSessions: [...connectionSessions.values()].flatMap(binding =>
        binding ? [binding.key] : [],
      ),
      keep,
    });

  /** @type {ThixotropeDaemon} */
  const daemon = {
    location,
    makeSturdyRefDetails: secret => harden({ location, secret }),
    eval: async (source, endowments = {}) => {
      // The lambda-shaped entry point: evaluation implies a worker.
      const workerId = randomHex128();
      provideWorkerSession(workerId);
      return makeAdminFacade(workerId).evaluate(source, endowments);
    },
    createWorker: async ({ debugLabel } = {}) => {
      debugLabel === undefined ||
        typeof debugLabel === 'string' ||
        Fail`debugLabel must be a string`;
      const workerId = randomHex128();
      if (debugLabel !== undefined) {
        const workerStore = store.provideWorkerStore(workerId);
        workerStore.setMeta({ ...workerStore.getMeta(), debugLabel });
      }
      provideWorkerSession(workerId);
      return makeAdminFacade(workerId);
    },
    getWorker: workerId => {
      workers.has(workerId) || Fail`unknown worker ${q(workerId)}`;
      return makeAdminFacade(workerId);
    },
    listWorkerIds: () => [...workers.keys()].sort(),
    makeResource: (name, description = null) =>
      records.provideResource(name, description),
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
    openEphemeralClient: async () => {
      if (stopping) throw Error('Daemon is stopping');
      const opening = makeEphemeralHubClient(random, {
        codec,
        hub,
        sessionKey: `transient:${randomHex128()}`,
      });
      openingTransientClients.add(opening);
      let client;
      try {
        client = await opening;
      } finally {
        openingTransientClients.delete(opening);
      }
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
      const candidates = inspectReachability({ keep }).collectible;
      const swept = [];
      for (const workerId of candidates) {
        // Retirement yields: a new root or message may have appeared since the
        // previous victim. Recheck instead of sweeping a stale candidate list.
        if (inspectReachability({ keep }).collectible.includes(workerId)) {
          // eslint-disable-next-line no-await-in-loop
          await retireWorkerNow(workerId);
          swept.push(workerId);
        }
      }
      return harden(swept.sort());
    },
    shutdown: async () => {
      try {
        for (const entry of workers.values()) {
          // eslint-disable-next-line no-await-in-loop
          await entry.transport.sleep();
        }
      } finally {
        // A later vat can reopen one parked earlier, and a failed sleep must
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
 * @param {LogPowers} powers.logging
 * @param {Parameters<typeof buildDaemon>[1]} options
 */
export const makeThixotropeDaemon = async (powers, options) => {
  const release = await options.engine.acquireStore?.(options.store.statePath);
  try {
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
            return harden({
              workerId,
              ...workerStore.getMeta(),
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
