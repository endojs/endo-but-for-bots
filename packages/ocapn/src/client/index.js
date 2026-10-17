// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { OcapnPublicKey } from '../cryptography.js'
 * @import { OcapnCodec } from '../codec-interface.js'
 * @import { SturdyRef } from './sturdyrefs.js'
 * @import { AdoptableSession, AdoptedSession, Client, Connection, InternalSession, LocationId, Logger, NetLayer, NetworkSession, NonceLocator, OcapnNetwork, Session, SessionHandlers, SessionId, SessionManager } from './types.js'
 */

import harden from '@endo/harden';
import { writeOcapnHandshakeMessage } from '../codecs/operations.js';
import { makeCryptography } from '../cryptography.js';
import { makeGrantTracker } from './grant-tracker.js';
import { makeSturdyRefTracker, enlivenSturdyRef } from './sturdyrefs.js';
import { locationToLocationId, toHex } from './util.js';
import { makeSession } from './session.js';
import { makeOcapn as makeOcapnCore } from './ocapn.js';

/**
 * @returns {SessionManager}
 */
const makeSessionManager = () => {
  /** @type {Map<LocationId, InternalSession>} */
  const activeSessions = new Map();
  /** @type {Map<string, OcapnPublicKey>} */
  const sessionIdToPeerPublicKey = new Map();

  /** @type {SessionManager} */
  return harden({
    getActiveSession: locationId => activeSessions.get(locationId),
    resolveSession: (locationId, session) => {
      if (activeSessions.has(locationId)) {
        throw Error(
          `Unable to resolve session for ${locationId}. Active session already exists.`,
        );
      }
      activeSessions.set(locationId, session);
      sessionIdToPeerPublicKey.set(toHex(session.id), session.peer.publicKey);
    },
    endSession: session => {
      const locationId = locationToLocationId(session.peer.location);
      if (activeSessions.get(locationId) === session) {
        activeSessions.delete(locationId);
      }
    },
    getPeerPublicKeyForSessionId: sessionId => {
      return sessionIdToPeerPublicKey.get(toHex(sessionId));
    },
  });
};

/**
 * @typedef {NetLayer | OcapnNetwork} AnyNetwork
 * @typedef {((handlers: SessionHandlers, logger: Logger) => AnyNetwork | Promise<AnyNetwork>)} NetworkFactory
 */

/**
 * @typedef {object} MakeOcapnAsyncResult
 * @property {Client} ocapn
 * @property {AnyNetwork} network
 */

/**
 * Construct an OCapN session manager against a chosen codec and a
 * single network. Both are pluggable (so you can experiment with
 * different codecs and networks, and compare them across dimensions
 * like performance), but fixed for the life of this instance: OCapN
 * makes no attempt to negotiate either on the wire, and session
 * identity is computed against canonical codec bytes.
 *
 * The `locator` is the caller-owned table of locally-held
 * capabilities. A plain `Map` works; anything with a
 * `get(secret) → value | Promise<value> | undefined` does too. When a
 * peer asks for a local capability via `bootstrap.fetch(secret)`, the
 * client calls `locator.get(secret)` and hands the result (or an
 * error, if `undefined`) back to the peer.
 *
 * `network` may be either a pre-built network object or a factory
 * `(sessionHandlers, logger) => network`. Core runs no handshake: every
 * session is authenticated by its network, either pulled through
 * `provideSession`/`inboundSessions` (the Noise `np` network) or pushed
 * through `sessionHandlers.adoptSession`. Connect-style netlayers that
 * speak `op:start-session` compose `makeStartSessionNetwork` from
 * `@endo/ocapn/netlayer/start-session`.
 *
 * @param {object} options
 * @param {OcapnCodec} options.codec
 * @param {AnyNetwork | NetworkFactory} options.network
 * @param {NonceLocator} [options.locator]
 * @param {string} [options.debugLabel]
 * @param {boolean} [options.verbose]
 * @param {Map<string, any>} [options.giftTable]
 * @param {never} [options.captpVersion] - Moved to `makeStartSessionNetwork`; passing it throws.
 * @param {boolean} [options.enableImportCollection] - If true, imports are tracked with WeakRefs and GC'd when unreachable. Default: true.
 * @param {boolean} [options.debugMode] - **EXPERIMENTAL**: If true, exposes `_debug` object on Ocapn instances with internal APIs for testing. Default: false.
 * @param {import('./types.js').SessionHooks} [options.sessionHooks] - Optional
 *   observation hooks for durable-session embedders: e.g. `onExport`
 *   fires whenever a session assigns a local export slot. Netlayers
 *   that do not provide durability are unaffected.
 * @param {Logger} [options.logger] - If provided, overrides the default console-based logger. When omitted, defaults to a console-based logger labelled with `debugLabel`; `info` is suppressed unless `verbose` is true.
 * @returns {Promise<Client>}
 */
export const makeOcapn = async ({
  codec,
  network: networkArg,
  locator = new Map(),
  debugLabel = 'ocapn',
  verbose = false,
  giftTable = new Map(),
  captpVersion: movedCaptpVersion,
  enableImportCollection = true,
  debugMode = false,
  sessionHooks = undefined,
  logger: providedLogger,
}) => {
  if (!codec) {
    throw Error(
      'makeOcapn: `codec` is required (import one of `cborCodec` from `@endo/ocapn/cbor` or `syrupCodec` from `@endo/ocapn/syrup`)',
    );
  }
  if (!networkArg) {
    throw Error(
      'makeOcapn: `network` is required (pass an `OcapnNoiseNetwork` from `@endo/ocapn-noise`, or a legacy `NetLayer`)',
    );
  }
  if (movedCaptpVersion !== undefined) {
    throw Error(
      'makeOcapn: `captpVersion` moved to `makeStartSessionNetwork` from `@endo/ocapn/netlayer/start-session`',
    );
  }
  const cryptography = makeCryptography(codec);

  /**
   * @param {Connection} connection
   * @param {string} [reason]
   */
  const sendAbortAndClose = (connection, reason = 'unknown reason') => {
    const opAbort = { type: 'op:abort', reason };
    const bytes = writeOcapnHandshakeMessage(opAbort, codec);
    connection.write(bytes);
    connection.end();
  };

  /** @type {Logger} */
  const logger =
    providedLogger ||
    harden({
      log: (...args) => console.log(`${debugLabel} [${Date.now()}]:`, ...args),
      error: (...args) =>
        console.error(`${debugLabel} [${Date.now()}]:`, ...args),
      info: (...args) =>
        verbose && console.info(`${debugLabel} [${Date.now()}]:`, ...args),
    });

  const sessionManager = makeSessionManager();

  /**
   * In-flight session establishments, keyed by destination locationId.
   * A network whose `connect`/`provideSession` is asynchronous registers
   * its pending session only after an `await`, so two synchronous callers
   * in the same turn would both miss `getActiveSession`/`getPendingSession`
   * and each start a redundant establishment. This map collapses
   * concurrent callers onto one establishment promise for the window
   * before a pending session is registered.
   * @type {Map<LocationId, Promise<InternalSession>>}
   */
  const establishingSessions = new Map();

  /**
   * The resolved network. Assigned exactly once, after any factory is
   * called with `sessionHandlers` and the logger. All closures below
   * reference this `let` binding; no method on the returned `Client`
   * runs before assignment, so use-before-assign is not observable.
   * @type {AnyNetwork}
   */
  let network;

  /**
   * Create an InternalSession from a network-provided NetworkSession.
   *
   * This bridges the OcapnNetwork.provideSession() path to the
   * existing session infrastructure.  The network has already
   * authenticated the peer; we wrap its write/close into a
   * synthetic Connection and set up CapTP over it.
   *
   * @param {NetworkSession} networkSession
   * @param {NetLayer | OcapnNetwork} netlayer
   * @returns {InternalSession}
   */
  const makeInternalSessionFromNetwork = (networkSession, netlayer) => {
    let isDestroyed = false;
    const netlayerForConnection = /** @type {NetLayer} */ (netlayer);
    /** @type {Connection} */
    const connection = harden({
      netlayer: netlayerForConnection,
      isOutgoing: networkSession.isInitiator,
      get isDestroyed() {
        return isDestroyed;
      },
      write(bytes) {
        // Fire-and-forget: the network's writer returns a promise but
        // the Connection.write contract is synchronous. Errors are
        // handled by the reader pump below (end-of-stream → endSession).
        Promise.resolve(networkSession.writer.next(bytes)).catch(() => {});
      },
      end() {
        if (isDestroyed) return;
        isDestroyed = true;
        networkSession.close();
      },
    });

    const { selfIdentity } = networkSession;

    const peerPublicKey = cryptography.makeOcapnPublicKey(
      networkSession.remotePublicKeyBytes,
    );
    const peerLocation = networkSession.remoteLocation;
    const peerLocationSig = networkSession.remoteLocationSignature;

    const ocapn = prepareOcapn(
      connection,
      networkSession.sessionId,
      peerLocation,
    );

    const internalSession = makeSession({
      id: networkSession.sessionId,
      selfIdentity,
      peerLocation,
      peerPublicKey,
      peerLocationSig,
      ocapn,
      connection,
    });

    // Pump the network's plaintext reader into the CapTP dispatcher.
    // Each `reader.next()` yields one whole OCapN frame that the
    // network has already framed/decrypted.
    const runPump = async () => {
      await null;
      /** @type {Error | undefined} */
      let pumpError;
      try {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const result = await networkSession.reader.next(undefined);
          if (result.done) break;
          if (isDestroyed) break;
          try {
            ocapn.dispatchMessageData(result.value);
          } catch (err) {
            logger.error(`CapTP dispatch failed`, err);
            // Mirror handleActiveSessionMessageData: notify the peer
            // with op:abort before tearing the session down, instead
            // of letting them stare at a quiet half-closed socket.
            try {
              sendAbortAndClose(connection, 'internal error');
            } catch (_e) {
              // ignore secondary failures during teardown
            }
            pumpError = /** @type {Error} */ (err);
            break;
          }
        }
      } catch (err) {
        pumpError = /** @type {Error} */ (err);
      } finally {
        if (!isDestroyed) {
          isDestroyed = true;
          // Tear down the OCapN client first so every pending
          // `op:deliver` answer rejects with a disconnect error,
          // not just sits forever on the answer table; then drop
          // the session from the session manager so subsequent
          // `provideSession` calls open a new one instead of
          // resurrecting this dead one. The legacy NetLayer path
          // does the same dance in `handleConnectionClose`; the
          // OcapnNetwork path needs to mirror it because the
          // network's session lifecycle (transport shutdown, EOF
          // on the reader, peer crash, …) all funnel through this
          // `runPump` finally rather than through
          // `handleConnectionClose`.
          internalSession.ocapn.abort(
            pumpError ?? Error('OCapN session ended'),
          );
          sessionManager.endSession(internalSession);
        }
      }
    };
    runPump();

    return internalSession;
  };

  /**
   * Every session object a network handed core, adopted (push) or
   * provided (pull), mapped to the `InternalSession` built for it. A
   * network may adopt a session and also resolve the same object from
   * `provideSession`; core then returns the existing session instead of
   * building a second one.
   * @type {WeakMap<object, InternalSession>}
   */
  const networkSessions = new WeakMap();

  /**
   * @param {OcapnLocation} location
   * @returns {Promise<InternalSession>}
   */
  const establishSession = async location => {
    const destinationLocationId = locationToLocationId(location);
    if (destinationLocationId === network.locationId) {
      throw Error('Refusing to connect to self');
    }
    const asNetwork = /** @type {OcapnNetwork} */ (network);
    if (typeof asNetwork.provideSession !== 'function') {
      throw Error(
        `ocapn: no network accepts location ${destinationLocationId}`,
      );
    }
    const networkSession = await asNetwork.provideSession(location);
    if (networkSession === undefined) {
      throw Error(
        `ocapn: no network accepts location ${destinationLocationId}`,
      );
    }
    const known = networkSessions.get(networkSession);
    if (known !== undefined) {
      return known;
    }
    if (!('reader' in networkSession)) {
      throw Error(
        'ocapn: provideSession resolved a session that was neither adopted nor readable',
      );
    }
    const session = makeInternalSessionFromNetwork(networkSession, network);
    networkSessions.set(networkSession, session);
    sessionManager.resolveSession(destinationLocationId, session);
    return session;
  };

  const grantTracker = makeGrantTracker();
  const sturdyRefTracker = makeSturdyRefTracker(locator);

  /**
   * Check whether a location refers to this instance (as opposed to
   * another peer).
   *
   * @param {OcapnLocation} location
   * @returns {boolean}
   */
  const isSelfLocation = location => {
    const locationId = locationToLocationId(location);
    return network.locationId === locationId;
  };

  /**
   * Internal function to provide full session (used internally and for debug).
   * @param {OcapnLocation} location
   * @returns {Promise<InternalSession>}
   */
  const provideInternalSession = location => {
    logger.info(`provideInternalSession called with`, { location });
    const locationId = locationToLocationId(location);
    // Get existing session.
    const activeSession = sessionManager.getActiveSession(locationId);
    if (activeSession) {
      logger.info(`provideInternalSession returning existing session`);
      return Promise.resolve(activeSession);
    }
    // Dedupe an establishment already in flight but not yet far enough to
    // have registered a pending session (the window across an async
    // `connect`). Without this, concurrent callers each dial and each send
    // a hello; the peer aborts the session on the second, unexpected
    // `op:start-session`.
    const inFlight = establishingSessions.get(locationId);
    if (inFlight) {
      logger.info(`provideInternalSession returning in-flight establishment`);
      return inFlight;
    }
    // Connect and establish a new session.
    logger.info(
      `provideInternalSession connecting and establishing new session`,
    );
    const newSessionPromise = establishSession(location);
    establishingSessions.set(locationId, newSessionPromise);
    const forget = () => {
      if (establishingSessions.get(locationId) === newSessionPromise) {
        establishingSessions.delete(locationId);
      }
    };
    newSessionPromise.then(forget, forget);
    return newSessionPromise;
  };

  /**
   * @param {Connection} connection
   * @param {SessionId} sessionId
   * @param {OcapnLocation} peerLocation
   * @param {any} [hookKey] identity passed to `sessionHooks` callbacks
   */
  const prepareOcapn = (
    connection,
    sessionId,
    peerLocation,
    hookKey = connection,
  ) => {
    return makeOcapnCore(
      logger,
      connection,
      sessionId,
      peerLocation,
      provideInternalSession,
      sessionManager.getActiveSession,
      sessionManager.getPeerPublicKeyForSessionId,
      () => {
        const activeSession = sessionManager.getActiveSession(
          locationToLocationId(peerLocation),
        );
        if (activeSession) {
          sessionManager.endSession(activeSession);
        }
      },
      grantTracker,
      giftTable,
      sturdyRefTracker,
      codec,
      cryptography,
      debugLabel,
      enableImportCollection,
      debugMode,
      sessionHooks
        ? {
            onExport:
              sessionHooks.onExport &&
              ((slot, value) =>
                /** @type {NonNullable<import('./types.js').SessionHooks['onExport']>} */ (
                  sessionHooks.onExport
                )(hookKey, slot, value)),
            onImport:
              sessionHooks.onImport &&
              ((slot, value) =>
                /** @type {NonNullable<import('./types.js').SessionHooks['onImport']>} */ (
                  sessionHooks.onImport
                )(hookKey, slot, value)),
            onPendingResolver:
              sessionHooks.onPendingResolver &&
              ((resolverSlot, target) =>
                /** @type {NonNullable<import('./types.js').SessionHooks['onPendingResolver']>} */ (
                  sessionHooks.onPendingResolver
                )(hookKey, resolverSlot, target)),
            onResolverSettled:
              sessionHooks.onResolverSettled &&
              (resolverSlot =>
                /** @type {NonNullable<import('./types.js').SessionHooks['onResolverSettled']>} */ (
                  sessionHooks.onResolverSettled
                )(hookKey, resolverSlot)),
          }
        : undefined,
    );
  };

  /**
   * Wire an authenticated session, pushed by its network, into the
   * session manager. Delivery through the returned `dispatch` is
   * synchronous, so a frame dispatched in the turn the network
   * authenticates the peer reaches CapTP in that same turn.
   *
   * @param {AdoptableSession} adoptable
   * @returns {AdoptedSession}
   */
  const adoptSession = adoptable => {
    if (networkSessions.has(adoptable)) {
      throw Error('ocapn: session already adopted');
    }
    const { sessionId, selfIdentity, remoteLocation } = adoptable;
    let isDestroyed = false;
    /** @type {Connection} */
    const connection = harden({
      netlayer: /** @type {NetLayer} */ (network),
      isOutgoing: adoptable.isInitiator,
      get isDestroyed() {
        return isDestroyed;
      },
      write(bytes) {
        adoptable.write(bytes);
      },
      end() {
        if (isDestroyed) return;
        isDestroyed = true;
        adoptable.close();
      },
    });
    const ocapn = prepareOcapn(
      connection,
      sessionId,
      remoteLocation,
      adoptable.hookKey ?? connection,
    );
    const session = makeSession({
      id: sessionId,
      selfIdentity,
      peerLocation: remoteLocation,
      peerPublicKey: cryptography.makeOcapnPublicKey(
        adoptable.remotePublicKeyBytes,
      ),
      peerLocationSig: adoptable.remoteLocationSignature,
      ocapn,
      connection,
    });
    sessionManager.resolveSession(
      locationToLocationId(remoteLocation),
      session,
    );
    networkSessions.set(adoptable, session);
    return harden({
      dispatch: bytes => {
        try {
          ocapn.dispatchMessageData(bytes);
        } catch (err) {
          logger.error(
            `Unexpected error while processing active session message:`,
            err,
          );
          sendAbortAndClose(connection, 'internal error');
          sessionManager.endSession(session);
        }
      },
      end: reason => {
        logger.info(`handling session end`, { reason });
        ocapn.abort(reason);
        sessionManager.endSession(session);
      },
      restoreExport: (position, value) => ocapn.restoreExport(position, value),
      restorePendingResolver: record => ocapn.restorePendingResolver(record),
      // Delegated by reference rather than wrapped: a wrapper arrow
      // would have to pick one of `provideImport`'s two call
      // signatures, collapsing the caller's choice of interface.
      provideImport: ocapn.provideImport,
      advanceAnswerPosition: minimum => ocapn.advanceAnswerPosition(minimum),
    });
  };

  /** @type {SessionHandlers} */
  const sessionHandlers = harden({ adoptSession });

  // Resolve the network: either use the object directly, or invoke the
  // factory now that `sessionHandlers` is ready.
  network =
    typeof networkArg === 'function'
      ? await /** @type {NetworkFactory} */ (networkArg)(
          sessionHandlers,
          logger,
        )
      : /** @type {AnyNetwork} */ (networkArg);

  // A network with `connect` but no `provideSession` was written against
  // the handlers core used to give netlayers. Fail at construction rather
  // than with a TypeError on the first inbound connection.
  if (
    typeof (/** @type {NetLayer} */ (network).connect) === 'function' &&
    typeof (/** @type {OcapnNetwork} */ (network).provideSession) !== 'function'
  ) {
    network.shutdown();
    throw Error(
      'makeOcapn: network implements connect without provideSession; wrap it with makeStartSessionNetwork from @endo/ocapn/netlayer/start-session',
    );
  }

  // Belt-and-suspenders: if the network declares its codec, ensure
  // agreement. Catches "wrong codec paired with wrong network" at
  // construction instead of mid-handshake.
  const networkCodec = /** @type {OcapnNetwork} */ (network).codec;
  if (networkCodec && networkCodec !== codec) {
    throw Error(
      'makeOcapn: `network.codec` does not match `codec`; both peers must use the same wire codec',
    );
  }

  // Consume peer-initiated sessions (if any) as they land. Each yields
  // a fully-authenticated session that we wire into the session
  // manager; `provideSession` below returns them from its cache.
  const asOcapnNetwork = /** @type {OcapnNetwork} */ (network);
  if (asOcapnNetwork.inboundSessions) {
    const inboundSessions = asOcapnNetwork.inboundSessions;
    const runConsumer = async () => {
      await null;
      try {
        for await (const networkSession of inboundSessions) {
          const locationId = locationToLocationId(
            networkSession.remoteLocation,
          );
          // Race avoidance: a `provideSession` call concurrent with
          // an inbound handshake may already have promoted (or seen)
          // the noise network's active session for this peer. The
          // network may then ALSO publish the same session here.
          // Discard the duplicate idempotently rather than building
          // an InternalSession we'd immediately have to abort.
          // Aborting would tear down the underlying networkSession
          // that the active path now owns.
          if (
            !networkSessions.has(networkSession) &&
            !sessionManager.getActiveSession(locationId)
          ) {
            const internalSession = makeInternalSessionFromNetwork(
              networkSession,
              network,
            );
            networkSessions.set(networkSession, internalSession);
            try {
              sessionManager.resolveSession(locationId, internalSession);
            } catch (err) {
              logger.info(
                `inbound session for ${locationId} collided with existing; discarding new`,
                err,
              );
              // Tear down only the InternalSession bookkeeping;
              // calling `ocapn.abort` here would close the shared
              // underlying networkSession out from under the
              // already-resolved peer.
              sessionManager.endSession(internalSession);
            }
          }
        }
      } catch (err) {
        logger.error('inboundSessions consumer failed', err);
      }
    };
    runConsumer();
  }

  /** @type {Client} */
  const client = {
    /**
     * @param {OcapnLocation} location
     * @returns {Promise<Session>}
     */
    async provideSession(location) {
      const internalSession = await provideInternalSession(location);
      /** @type {Session} */
      const session = harden({
        getBootstrap: () => internalSession.ocapn.getRemoteBootstrap(),
        abort: reason => internalSession.ocapn.abort(reason),
      });
      return session;
    },
    /**
     * Mint a capability reference addressed to `(location, secret)`.
     * The peer resolves the secret against its own locator.
     *
     * @param {OcapnLocation} location
     * @param {string | Uint8Array} secret
     * @returns {SturdyRef}
     */
    makeSturdyRef(location, secret) {
      return sturdyRefTracker.makeSturdyRef(location, secret);
    },
    /**
     * Resolve a `SturdyRef` to a live capability. Local SturdyRefs flow
     * through the injected locator; remote SturdyRefs fetch from the
     * peer's bootstrap.
     *
     * @param {SturdyRef} sturdyRef
     * @returns {Promise<any>}
     */
    enlivenSturdyRef(sturdyRef) {
      return enlivenSturdyRef(
        sturdyRef,
        provideInternalSession,
        isSelfLocation,
        locator,
      );
    },
    shutdown() {
      logger.info(`shutdown called`);
      network.shutdown();
    },
  };

  if (debugMode) {
    // eslint-disable-next-line no-underscore-dangle
    client._debug = {
      logger,
      debugLabel,
      grantTracker,
      sessionManager,
      sturdyRefTracker,
      provideInternalSession,
      getEstablishingSession: locationId =>
        establishingSessions.get(locationId),
    };
  }

  return harden(client);
};
