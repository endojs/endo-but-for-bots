// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { OcapnPublicKey, Cryptography } from '../cryptography.js'
 * @import { OcapnCodec } from '../codec-interface.js'
 * @import { SturdyRef } from './sturdyrefs.js'
 * @import { Client, Connection, InternalSession, LocationId, Logger, NetLayer, NetlayerHandlers, PendingSession, SelfIdentity, Session, SessionManager, SocketOperations, SwissNum } from './types.js'
 */

import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';
import { writeOcapnHandshakeMessage } from '../codecs/operations.js';
import { makeCryptography } from '../cryptography.js';
import { makeGrantTracker } from './grant-tracker.js';
import { makeSturdyRefTracker, enlivenSturdyRef } from './sturdyrefs.js';
import { locationToLocationId, toHex } from './util.js';
import { handleHandshakeMessageData, sendHandshake } from './handshake.js';
import { makeOcapn } from './ocapn.js';

/**
 * @param {Logger} logger
 * @param {SessionManager} sessionManager
 * @param {Connection} connection
 * @param {InternalSession} session
 * @param {Uint8Array} data
 * @param {(connection: Connection, reason?: string) => void} sendAbortAndClose
 */
const handleActiveSessionMessageData = (
  logger,
  sessionManager,
  connection,
  session,
  data,
  sendAbortAndClose,
) => {
  try {
    session.ocapn.dispatchMessageData(data);
  } catch (err) {
    logger.error(
      `Unexpected error while processing active session message:`,
      err,
    );
    sendAbortAndClose(connection, 'internal error');
    sessionManager.endSession(session);
  }
};

/**
 * @returns {SessionManager}
 */
const makeSessionManager = () => {
  /** @type {Map<LocationId, InternalSession>} */
  const activeSessions = new Map();
  /** @type {Map<LocationId, PendingSession>} */
  const pendingSessions = new Map();
  /** @type {Map<Connection, InternalSession>} */
  const connectionToSession = new Map();
  /** @type {Map<string, OcapnPublicKey>} */
  const sessionIdToPeerPublicKey = new Map();

  /** @type {SessionManager} */
  return harden({
    getActiveSession: locationId => activeSessions.get(locationId),
    getOutgoingConnection: locationId => {
      const pendingSession = pendingSessions.get(locationId);
      if (pendingSession === undefined) {
        return undefined;
      }
      return pendingSession.outgoingConnection;
    },
    getSessionForConnection: connection => {
      return connectionToSession.get(connection);
    },
    deleteConnection: connection => {
      connectionToSession.delete(connection);
    },
    getPendingSessionPromise: locationId => {
      const pendingSession = pendingSessions.get(locationId);
      if (pendingSession === undefined) {
        return undefined;
      }
      return pendingSession.promise;
    },
    resolveSession: (locationId, connection, session) => {
      if (activeSessions.has(locationId)) {
        throw Error(
          `Unable to resolve session for ${locationId}. Active session already exists.`,
        );
      }
      activeSessions.set(locationId, session);
      connectionToSession.set(connection, session);
      sessionIdToPeerPublicKey.set(toHex(session.id), session.peer.publicKey);
      const pendingSession = pendingSessions.get(locationId);
      if (pendingSession !== undefined) {
        pendingSession.resolve(session);
        pendingSessions.delete(locationId);
      }
    },
    endSession: session => {
      const locationId = locationToLocationId(session.peer.location);
      const pendingSession = pendingSessions.get(locationId);
      if (pendingSession !== undefined) {
        pendingSession.reject(Error('Session ended.'));
        pendingSessions.delete(locationId);
      }
      activeSessions.delete(locationId);
      connectionToSession.delete(session.connection);
    },
    rejectPendingSessionForConnection: connection => {
      // Find and reject any pending session that matches this outgoing connection
      for (const [locationId, pendingSession] of pendingSessions.entries()) {
        if (pendingSession.outgoingConnection === connection) {
          pendingSession.reject(Error('Connection closed during handshake.'));
          pendingSessions.delete(locationId);
          return true;
        }
      }
      return false;
    },
    makePendingSession: (locationId, outgoingConnection) => {
      if (activeSessions.has(locationId)) {
        throw Error(
          `Active session for location already exists: ${locationId}`,
        );
      }
      if (pendingSessions.has(locationId)) {
        throw Error(
          `Pending session for location already exists: ${locationId}`,
        );
      }
      const { promise, resolve, reject } = makePromiseKit();
      /** @type {PendingSession} */
      const pendingSession = harden({
        outgoingConnection,
        promise,
        resolve,
        reject,
      });
      pendingSessions.set(locationId, pendingSession);
      return pendingSession;
    },
    getPeerPublicKeyForSessionId: sessionId => {
      return sessionIdToPeerPublicKey.get(toHex(sessionId));
    },
  });
};

/**
 * @param {object} options
 * @param {OcapnCodec} options.codec - Wire codec (required). Import either
 *   `syrupCodec` from `@endo/ocapn/syrup` or `cborCodec` from
 *   `@endo/ocapn/cbor`. Both peers must share the same codec; there is no
 *   on-the-wire negotiation.
 * @param {string} [options.debugLabel]
 * @param {boolean} [options.verbose]
 * @param {Map<string, any>} [options.swissnumTable]
 * @param {Map<string, any>} [options.giftTable]
 * @param {string} [options.captpVersion] - For testing: override the CapTP version sent in handshakes
 * @param {boolean} [options.enableImportCollection] - If true, imports are tracked with WeakRefs and GC'd when unreachable. Default: true.
 * @param {boolean} [options.debugMode] - **EXPERIMENTAL**: If true, exposes `_debug` object on Ocapn instances with internal APIs for testing. Default: false.
 * @returns {Client}
 */
export const makeClient = ({
  codec,
  debugLabel = 'ocapn',
  verbose = false,
  swissnumTable = new Map(),
  giftTable = new Map(),
  captpVersion = '1.0',
  enableImportCollection = true,
  debugMode = false,
}) => {
  if (codec === undefined) {
    throw Error(
      'makeClient: "codec" option is required; import syrupCodec from "@endo/ocapn/syrup" or cborCodec from "@endo/ocapn/cbor"',
    );
  }
  const cryptography = makeCryptography(codec);

  /**
   * @param {OcapnLocation} myLocation
   * @returns {SelfIdentity}
   */
  const makeSelfIdentity = myLocation => {
    const keyPair = cryptography.makeOcapnKeyPair();
    const myLocationSig = cryptography.signLocation(myLocation, keyPair);
    return {
      keyPair,
      location: myLocation,
      locationSignature: myLocationSig,
    };
  };

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
  /** @type {Map<string, NetLayer>} */
  const networks = new Map();

  /** @type {Logger} */
  const logger = harden({
    log: (...args) => console.log(`${debugLabel} [${Date.now()}]:`, ...args),
    error: (...args) =>
      console.error(`${debugLabel} [${Date.now()}}:`, ...args),
    info: (...args) =>
      verbose && console.info(`${debugLabel} [${Date.now()}]:`, ...args),
  });

  const sessionManager = makeSessionManager();

  /** @type {WeakMap<Connection, SelfIdentity>} */
  const connectionSelfIdentityMap = new WeakMap();

  /**
   * Get the self identity for a connection.
   * @param {Connection} connection
   * @returns {SelfIdentity}
   */
  const getSelfIdentityForConnection = connection => {
    const selfIdentity = connectionSelfIdentityMap.get(connection);
    if (!selfIdentity) {
      throw Error('Connection not found in self identity map');
    }
    return selfIdentity;
  };

  /**
   * @param {OcapnLocation} location
   * @returns {Promise<InternalSession>}
   * Establishes a new session by initiating a connection.
   */
  const establishSession = location => {
    // Support both the new `network` field and the legacy `transport` field.
    const networkId = location.network ?? location.transport;
    const netlayer = networks.get(networkId);
    if (!netlayer) {
      throw Error(`Netlayer not registered for network: ${networkId}`);
    }
    const destinationLocationId = locationToLocationId(location);
    if (destinationLocationId === netlayer.locationId) {
      throw Error('Refusing to connect to self');
    }
    const connection = netlayer.connect(location);
    const selfIdentity = getSelfIdentityForConnection(connection);
    // Send handshake for outgoing connections.
    // If the network provides its own handshake, use it; otherwise
    // fall back to the default op:start-session handshake.
    if (netlayer.sendSessionHandshake) {
      netlayer.sendSessionHandshake(connection, captpVersion, selfIdentity);
    } else {
      sendHandshake(connection, selfIdentity, captpVersion, codec);
    }
    const pendingSession = sessionManager.makePendingSession(
      destinationLocationId,
      connection,
    );
    return pendingSession.promise;
  };

  const grantTracker = makeGrantTracker();
  const sturdyRefTracker = makeSturdyRefTracker(swissnumTable);
  /**
   * Check if a location matches one of our own networks (self-location)
   * @param {OcapnLocation} location
   * @returns {boolean}
   */
  const isSelfLocation = location => {
    const locationId = locationToLocationId(location);
    for (const netlayer of networks.values()) {
      if (netlayer.locationId === locationId) {
        return true;
      }
    }
    return false;
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
    // Get existing pending session.
    const pendingSession = sessionManager.getPendingSessionPromise(locationId);
    if (pendingSession) {
      logger.info(`provideInternalSession returning existing pending session`);
      return pendingSession;
    }
    // Connect and establish a new session.
    logger.info(
      `provideInternalSession connecting and establishing new session`,
    );
    const newSessionPromise = establishSession(location);
    return newSessionPromise;
  };

  const prepareOcapn = (connection, sessionId, peerLocation) => {
    return makeOcapn(
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
    );
  };

  /**
   * Internal handler for incoming message data from a connection.
   * @param {Connection} connection
   * @param {Uint8Array} data
   */
  const handleMessageData = (connection, data) => {
    logger.info(`handleMessageData called`);
    const session = sessionManager.getSessionForConnection(connection);
    if (session) {
      handleActiveSessionMessageData(
        logger,
        sessionManager,
        connection,
        session,
        data,
        sendAbortAndClose,
      );
    } else {
      handleHandshakeMessageData(
        logger,
        sessionManager,
        connection,
        getSelfIdentityForConnection,
        sendAbortAndClose,
        data,
        captpVersion,
        prepareOcapn,
        codec,
        cryptography,
      );
    }
  };

  /**
   * Internal handler for connection close events.
   * @param {Connection} connection
   * @param {Error} [reason]
   */
  const handleConnectionClose = (connection, reason) => {
    logger.info(`handleConnectionClose called`, { reason });
    const session = sessionManager.getSessionForConnection(connection);
    if (session) {
      const locationId = locationToLocationId(session.peer.location);
      logger.info(`handling connection close for ${locationId}`);
      session.ocapn.abort(reason);
      sessionManager.endSession(session);
    } else {
      // If no session exists, check if there's a pending session for this connection
      sessionManager.rejectPendingSessionForConnection(connection);
    }
    sessionManager.deleteConnection(connection);
  };

  /**
   * Creates a connection for the given netlayer and socket.
   * Does not send handshake - caller is responsible for initiating handshake when appropriate.
   * @param {NetLayer} netlayer
   * @param {boolean} isOutgoing
   * @param {SocketOperations} socket
   * @returns {Connection}
   */
  const makeConnection = (netlayer, isOutgoing, socket) => {
    let isDestroyed = false;
    const selfIdentity = makeSelfIdentity(netlayer.location);

    /** @type {Connection} */
    const connection = harden({
      netlayer,
      isOutgoing,
      get isDestroyed() {
        return isDestroyed;
      },
      write(bytes) {
        socket.write(bytes);
      },
      end() {
        if (isDestroyed) return;
        isDestroyed = true;
        socket.end();
      },
    });

    // Store self identity for this connection
    connectionSelfIdentityMap.set(connection, selfIdentity);

    return connection;
  };

  /** @type {NetlayerHandlers} */
  const netlayerHandlers = harden({
    makeConnection,
    handleMessageData,
    handleConnectionClose,
  });

  /** @type {Client} */
  const client = {
    /**
     * Registers a netlayer by calling the provided factory with handlers and logger.
     * @template {NetLayer} T
     * @param {(handlers: NetlayerHandlers, logger: Logger) => T | Promise<T>} makeNetlayer
     * @returns {Promise<T>}
     */
    async registerNetlayer(makeNetlayer) {
      const netlayer = await makeNetlayer(netlayerHandlers, logger);
      // Register under `network` if provided, falling back to `transport`.
      const networkId =
        netlayer.location.network ?? netlayer.location.transport;
      if (networks.has(networkId)) {
        throw Error(`Network already registered: ${networkId}`);
      }
      networks.set(networkId, netlayer);
      return netlayer;
    },
    /**
     * Registers an OCapN network by calling the provided factory.
     * The network manages its own session establishment, authentication,
     * and transport selection.  This is the successor to registerNetlayer
     * for the network/transport separation.
     *
     * @template {import('./types.js').OcapnNetwork} T
     * @param {(handlers: NetlayerHandlers, logger: Logger) => T | Promise<T>} makeNetwork
     * @returns {Promise<T>}
     */
    async registerNetwork(makeNetwork) {
      const network = await makeNetwork(netlayerHandlers, logger);
      const { networkId } = network;
      if (networks.has(networkId)) {
        throw Error(`Network already registered: ${networkId}`);
      }
      networks.set(networkId, network);
      return network;
    },
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
     * Create a SturdyRef object
     * @param {OcapnLocation} location
     * @param {SwissNum} swissNum
     * @returns {SturdyRef}
     */
    makeSturdyRef(location, swissNum) {
      return sturdyRefTracker.makeSturdyRef(location, swissNum);
    },
    /**
     * Enliven a SturdyRef by fetching the actual object
     * @param {SturdyRef} sturdyRef
     * @returns {Promise<any>}
     */
    enlivenSturdyRef(sturdyRef) {
      return enlivenSturdyRef(
        sturdyRef,
        provideInternalSession,
        isSelfLocation,
        swissnumTable,
      );
    },
    /**
     * Register an object with a swissnum string so it can be resolved via SturdyRef.
     * @param {string} swissStr
     * @param {any} object
     */
    registerSturdyRef(swissStr, object) {
      sturdyRefTracker.register(swissStr, object);
    },
    shutdown() {
      logger.info(`shutdown called`);
      for (const netlayer of networks.values()) {
        netlayer.shutdown();
      }
    },
  };

  if (debugMode) {
    // eslint-disable-next-line no-underscore-dangle
    client._debug = {
      logger,
      debugLabel,
      captpVersion,
      grantTracker,
      sessionManager,
      sturdyRefTracker,
      provideInternalSession,
    };
  }

  return harden(client);
};
