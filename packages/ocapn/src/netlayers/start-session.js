// @ts-check

/**
 * The `op:start-session` handshake, as a network adapter.
 *
 * OCapN core accepts only sessions that a network has already
 * authenticated. This module is the network that authenticates
 * connect-style netlayers (`tcp-testing-only`, the WebSocket netlayer,
 * `@endo/ocapn-iroh`, the thixotrope durable netlayer) with the
 * `op:start-session` hello: version check, location-signature
 * verification, crossed-hello resolution, and pre-session `op:abort`.
 *
 * Its security is weak by itself. It does not encrypt, and the location
 * signature it checks has an empty channel binding, so it proves only
 * that the peer holds the session key it just minted. It suits tests,
 * interop, and transports that are authenticated underneath (iroh's QUIC
 * `verifyPeerLocation`, the durable netlayer's base transport). Use the
 * `np` network from `@endo/ocapn-noise` for an authenticated, encrypted
 * channel.
 */

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { OcapnPublicKey, Cryptography } from '../cryptography.js'
 * @import { OcapnCodec } from '../codec-interface.js'
 * @import { AdoptableSession, AdoptedSession, Connection, LocationId, Logger, NetLayer, NetlayerHandlers, OcapnNetwork, SelfIdentity, SessionHandlers, SessionResumption, SocketOperations } from '../client/types.js'
 * @import { PromiseKit } from '@endo/promise-kit'
 */

import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';
import {
  readOcapnHandshakeMessage,
  writeOcapnHandshakeMessage,
} from '../codecs/operations.js';
import { makeCryptography, makeSessionId } from '../cryptography.js';
import { compareImmutableArrayBuffers } from '../bytewise-compare.js';
import { locationToLocationId } from '../client/util.js';

/**
 * The adapter's own bookkeeping, keyed by peer `LocationId`. It replaces
 * the connection-keyed half of core's old session manager.
 *
 * @typedef {object} SessionTable
 * @property {(locationId: LocationId) => AdoptableSession | undefined} getActiveSession
 * @property {(locationId: LocationId) => Connection | undefined} getOutgoingConnection
 * @property {(connection: Connection) => void} deleteConnection
 * @property {(locationId: LocationId, connection: Connection, session: Omit<AdoptableSession, 'write' | 'close' | 'hookKey'>) => AdoptedSession} resolveSession
 */

/**
 * @param {Connection} connection
 * @param {SelfIdentity} selfIdentity
 * @param {string} captpVersion
 * @param {OcapnCodec} codec
 */
const sendHandshake = (
  connection,
  selfIdentity,
  captpVersion,
  codec,
) => {
  const { keyPair, location, locationSignature } = selfIdentity;
  const opStartSession = {
    type: 'op:start-session',
    captpVersion,
    sessionPublicKey: keyPair.publicKey.descriptor,
    location,
    locationSignature,
  };
  const bytes = writeOcapnHandshakeMessage(opStartSession, codec);
  connection.write(bytes);
};

/**
 * @param {Connection} outgoingConnection
 * @param {Connection} incommingConnection
 * @param {OcapnPublicKey} incommingPublicKey
 * @param {(connection: Connection) => SelfIdentity} getSelfIdentityForConnection
 * @returns {{ preferredConnection: Connection, connectionToClose: Connection }}
 */
const compareSessionKeysForCrossedHellos = (
  outgoingConnection,
  incommingConnection,
  incommingPublicKey,
  getSelfIdentityForConnection,
) => {
  const outgoingPublicKey =
    getSelfIdentityForConnection(outgoingConnection).keyPair.publicKey;
  const outgoingId = outgoingPublicKey.id;
  const incommingId = incommingPublicKey.id;
  const result = compareImmutableArrayBuffers(outgoingId, incommingId);
  const [preferredConnection, connectionToClose] =
    result > 0
      ? [outgoingConnection, incommingConnection]
      : [incommingConnection, outgoingConnection];
  return { preferredConnection, connectionToClose };
};

/**
 * @param {Logger} logger
 * @param {SessionTable} sessionManager
 * @param {Connection} connection
 * @param {(connection: Connection) => SelfIdentity} getSelfIdentityForConnection
 * @param {(connection: Connection, reason: string) => void} sendAbortAndClose
 * @param {any} message
 * @param {string} captpVersion
 * @param {OcapnCodec} codec
 * @param {Cryptography} cryptography
 */
const handleSessionHandshakeMessage = (
  logger,
  sessionManager,
  connection,
  getSelfIdentityForConnection,
  sendAbortAndClose,
  message,
  captpVersion,
  codec,
  cryptography,
) => {
  logger.info(`handling handshake message of type ${message.type}`);
  switch (message.type) {
    case 'op:start-session': {
      const {
        captpVersion: messageCaptpVersion,
        sessionPublicKey,
        location: peerLocation,
        locationSignature: peerLocationSig,
      } = message;
      if (messageCaptpVersion !== captpVersion) {
        logger.info('Abort during start-session message with invalid version', {
          received: messageCaptpVersion,
          expected: captpVersion,
        });
        sendAbortAndClose(connection, 'invalid-version');
        sessionManager.deleteConnection(connection);
        return;
      }
      const locationId = locationToLocationId(peerLocation);
      if (sessionManager.getActiveSession(locationId)) {
        throw Error(`Active session already exists for ${locationId}`);
      }

      const peerPublicKey = cryptography.makeOcapnPublicKey(sessionPublicKey.q);
      try {
        // tcp-testing-only does not have a Noise transcript hash to
        // bind against; pass an empty buffer so the signature payload
        // omits a session-bound binding.  The np netlayer threads the
        // Noise handshake hash through `exchangeIdentity` and binds to
        // it instead.
        cryptography.assertLocationSignatureValid(
          peerLocation,
          peerLocationSig,
          peerPublicKey,
          new ArrayBuffer(0),
        );
      } catch {
        logger.info('>> Server received NOT VALID location signature');
        sendAbortAndClose(connection, 'Invalid location signature');
        sessionManager.deleteConnection(connection);
        return;
      }
      logger.info('>> Server received VALID location signature');

      // Networks that authenticate the transport (e.g. an iroh
      // EndpointId, a Noise static key) can bind the peer's *claimed*
      // location to the transport-authenticated identity here, rejecting
      // a peer that presents someone else's designator. The location
      // signature above only proves the peer holds the fresh session key
      // it just minted — nothing ties that to who the transport says they
      // are. Connect-style netlayers expose this binding as an optional
      // `verifyPeerLocation` hook; networks without transport
      // authentication (e.g. tcp-testing-only) omit it and are trusted at
      // face value, exactly as before.
      const { netlayer } = connection;
      if (netlayer && typeof netlayer.verifyPeerLocation === 'function') {
        try {
          netlayer.verifyPeerLocation(connection, peerLocation);
        } catch (err) {
          logger.info('>> Peer location rejected by netlayer', err);
          sendAbortAndClose(connection, 'peer location not authorized');
          sessionManager.deleteConnection(connection);
          return;
        }
      }

      const outgoingConnection =
        sessionManager.getOutgoingConnection(locationId);
      if (
        outgoingConnection !== undefined &&
        outgoingConnection !== connection
      ) {
        const incommingConnection = connection;
        const { connectionToClose } = compareSessionKeysForCrossedHellos(
          outgoingConnection,
          incommingConnection,
          peerPublicKey,
          getSelfIdentityForConnection,
        );
        sendAbortAndClose(connectionToClose, 'Crossed hellos mitigated');
        sessionManager.deleteConnection(connectionToClose);

        if (incommingConnection === connectionToClose) {
          return;
        }
      }

      if (!connection.isOutgoing) {
        logger.info('Server sending op:start-session');
        const selfIdentity = getSelfIdentityForConnection(connection);
        sendHandshake(connection, selfIdentity, captpVersion, codec);
      }

      const selfIdentity = getSelfIdentityForConnection(connection);
      const sessionId = makeSessionId(
        selfIdentity.keyPair.publicKey.id,
        peerPublicKey.id,
      );

      logger.info(`session established for ${locationId}`);
      sessionManager.resolveSession(locationId, connection, {
        sessionId,
        selfIdentity,
        remotePublicKeyBytes: sessionPublicKey.q,
        remoteLocation: peerLocation,
        remoteLocationSignature: peerLocationSig,
        isInitiator: connection.isOutgoing,
      });

      break;
    }

    case 'op:abort': {
      logger.info('Server received op:abort', message.reason);
      connection.end();
      sessionManager.deleteConnection(connection);
      break;
    }

    default: {
      throw Error(`Unknown message type: ${message.type}`);
    }
  }
};

/**
 * @param {Logger} logger
 * @param {SessionTable} sessionManager
 * @param {Connection} connection
 * @param {(connection: Connection) => SelfIdentity} getSelfIdentityForConnection
 * @param {(connection: Connection, reason: string) => void} sendAbortAndClose
 * @param {Uint8Array} data
 * @param {string} captpVersion
 * @param {OcapnCodec} codec
 * @param {Cryptography} cryptography
 */
const handleHandshakeMessageData = (
  logger,
  sessionManager,
  connection,
  getSelfIdentityForConnection,
  sendAbortAndClose,
  data,
  captpVersion,
  codec,
  cryptography,
) => {
  try {
    const reader = codec.makeReader(data);
    while (reader.index < data.length) {
      const start = reader.index;
      let message;
      try {
        message = readOcapnHandshakeMessage(reader);
      } catch (err) {
        // Best-effort diagnostic: try to render the bytes as generic syrup
        // for the log. If they can't even be decoded as syrup (e.g. junk
        // bytes), don't let the diagnostic itself mask the original error.
        const problematicBytes = data.slice(start);
        logger.error(
          `Message decode error:`,
          err,
          'while reading',
          codec.diagnose(problematicBytes),
        );
        throw err;
      }
      if (!connection.isDestroyed) {
        handleSessionHandshakeMessage(
          logger,
          sessionManager,
          connection,
          getSelfIdentityForConnection,
          sendAbortAndClose,
          message,
          captpVersion,
          codec,
          cryptography,
        );
      } else {
        logger.info(
          'Server received message after connection was destroyed',
          message,
        );
      }
    }
  } catch (err) {
    logger.error(`Unexpected error while processing handshake message:`, err);
    sendAbortAndClose(connection, 'internal error');
    sessionManager.deleteConnection(connection);
  }
};

/**
 * Rebuild a session's self identity from persisted private key bytes, or
 * mint a fresh one. The location signature carries an empty channel
 * binding, because this handshake has no transcript hash to bind to.
 *
 * @param {Cryptography} cryptography
 * @param {OcapnLocation} myLocation
 * @param {Uint8Array} [privateKeyBytes]
 * @returns {{ selfIdentity: SelfIdentity, privateKeyBytes: Uint8Array }}
 */
const makeSelfIdentity = (cryptography, myLocation, privateKeyBytes) => {
  const { keyPair, privateKeyBytes: keyBytes } =
    privateKeyBytes === undefined
      ? cryptography.makeOcapnKeyPairWithPrivateBytes()
      : {
          keyPair: cryptography.makeOcapnKeyPairFromPrivateKey(privateKeyBytes),
          privateKeyBytes,
        };
  const myLocationSig = cryptography.signLocation(
    myLocation,
    keyPair,
    new ArrayBuffer(0),
  );
  return {
    selfIdentity: harden({
      keyPair,
      location: myLocation,
      locationSignature: myLocationSig,
    }),
    privateKeyBytes: keyBytes,
  };
};

/**
 * Rebuild the self identity of a resumed start-session session from its
 * persisted private key.
 *
 * @param {OcapnCodec} codec
 * @param {OcapnLocation} myLocation
 * @param {Uint8Array} privateKeyBytes
 * @returns {SelfIdentity}
 */
export const makeSelfIdentityFromPrivateKey = (
  codec,
  myLocation,
  privateKeyBytes,
) =>
  makeSelfIdentity(makeCryptography(codec), myLocation, privateKeyBytes)
    .selfIdentity;
harden(makeSelfIdentityFromPrivateKey);

/**
 * Wrap a connect-style netlayer in the `op:start-session` handshake,
 * producing a network factory for `makeOcapn({ network })`.
 *
 * The netlayer receives `NetlayerHandlers` (`makeConnection`,
 * `handleMessageData`, `handleConnectionClose`, `resumeSession`) and
 * returns a `NetLayer`. The adapter runs the hello on each connection and
 * hands every validated session to core's `adoptSession`.
 *
 * @param {(handlers: NetlayerHandlers, logger: Logger) => NetLayer | Promise<NetLayer>} makeNetlayer
 * @param {object} options
 * @param {OcapnCodec} options.codec
 * @param {string} [options.captpVersion] - The CapTP version sent and
 *   required in hellos. Tests override it to exercise version mismatch.
 * @returns {(sessionHandlers: SessionHandlers, logger: Logger) => Promise<OcapnNetwork>}
 */
export const makeStartSessionNetwork = (
  makeNetlayer,
  { codec, captpVersion = '1.0' },
) => {
  if (!codec) {
    throw Error('makeStartSessionNetwork: `codec` is required');
  }
  const cryptography = makeCryptography(codec);

  return async (sessionHandlers, logger) => {
    /** @type {NetLayer | undefined} */
    let netlayer;

    /**
     * @typedef {object} AdapterSession
     * @property {AdoptableSession} adoptable
     * @property {AdoptedSession} adopted
     * @property {Connection} connection
     */
    /** @type {Map<LocationId, AdapterSession>} */
    const activeSessions = new Map();
    /** @type {Map<Connection, AdapterSession>} */
    const connectionToSession = new Map();
    /**
     * @type {Map<LocationId, {
     *   outgoingConnection: Connection,
     *   promise: Promise<AdoptableSession>,
     *   resolve: (session: AdoptableSession) => void,
     *   reject: (reason: Error) => void,
     * }>}
     */
    const pendingSessions = new Map();

    /**
     * The location each connection presents as its own, recorded eagerly
     * so the session keypair can be minted lazily.
     * @type {WeakMap<Connection, OcapnLocation>}
     */
    const connectionLocationMap = new WeakMap();
    /** @type {WeakMap<Connection, SelfIdentity>} */
    const connectionSelfIdentityMap = new WeakMap();

    /**
     * Get the self identity for a connection, minting it on first use.
     *
     * Deferring the keypair until the identity is actually needed (our
     * first outbound hello, or our reply to a *validated* inbound hello)
     * means an unauthenticated inbound connection that never sends a
     * valid `op:start-session` never costs us an Ed25519 keypair. This
     * bounds the work a flood of junk inbound connections can pin.
     *
     * @param {Connection} connection
     * @returns {SelfIdentity}
     */
    const getSelfIdentityForConnection = connection => {
      const existing = connectionSelfIdentityMap.get(connection);
      if (existing) {
        return existing;
      }
      const location = connectionLocationMap.get(connection);
      if (!location) {
        throw Error('Connection not found in self identity map');
      }
      const { selfIdentity } = makeSelfIdentity(cryptography, location);
      connectionSelfIdentityMap.set(connection, selfIdentity);
      return selfIdentity;
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

    /** @param {Connection} connection */
    const forgetConnection = connection => {
      const entry = connectionToSession.get(connection);
      if (entry === undefined) return;
      connectionToSession.delete(connection);
      const locationId = locationToLocationId(entry.adoptable.remoteLocation);
      if (activeSessions.get(locationId) === entry) {
        activeSessions.delete(locationId);
      }
    };

    /** @type {SessionTable} */
    const sessionTable = harden({
      getActiveSession: locationId => activeSessions.get(locationId)?.adoptable,
      getOutgoingConnection: locationId =>
        pendingSessions.get(locationId)?.outgoingConnection,
      deleteConnection: connection => {
        connectionToSession.delete(connection);
      },
      resolveSession: (locationId, connection, session) => {
        if (activeSessions.has(locationId)) {
          throw Error(
            `Unable to resolve session for ${locationId}. Active session already exists.`,
          );
        }
        /** @type {AdoptableSession} */
        const adoptable = harden({
          ...session,
          write: bytes => connection.write(bytes),
          close: () => {
            forgetConnection(connection);
            connection.end();
          },
          hookKey: connection,
        });
        const adopted = sessionHandlers.adoptSession(adoptable);
        const entry = harden({ adoptable, adopted, connection });
        activeSessions.set(locationId, entry);
        connectionToSession.set(connection, entry);
        const pendingSession = pendingSessions.get(locationId);
        if (pendingSession !== undefined) {
          pendingSessions.delete(locationId);
          pendingSession.resolve(adoptable);
        }
        return adopted;
      },
    });

    /** @type {NetlayerHandlers} */
    const netlayerHandlers = harden({
      /**
       * @param {NetLayer} layer
       * @param {boolean} isOutgoing
       * @param {SocketOperations} socket
       * @returns {Connection}
       */
      makeConnection: (layer, isOutgoing, socket) => {
        let isDestroyed = false;
        /** @type {Connection} */
        const connection = harden({
          netlayer: layer,
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
        connectionLocationMap.set(connection, layer.location);
        return connection;
      },
      handleMessageData: (connection, data) => {
        const entry = connectionToSession.get(connection);
        if (entry) {
          entry.adopted.dispatch(data);
          return;
        }
        handleHandshakeMessageData(
          logger,
          sessionTable,
          connection,
          getSelfIdentityForConnection,
          sendAbortAndClose,
          data,
          captpVersion,
          codec,
          cryptography,
        );
      },
      handleConnectionClose: (connection, reason) => {
        // The socket is gone however we got here, so mark the connection
        // destroyed even if the netlayer fired close without an end().
        connection.end();
        const entry = connectionToSession.get(connection);
        if (entry) {
          forgetConnection(connection);
          entry.adopted.end(reason);
          return;
        }
        for (const [locationId, pending] of pendingSessions.entries()) {
          if (pending.outgoingConnection === connection) {
            pendingSessions.delete(locationId);
            pending.reject(Error('Connection closed during handshake.'));
            return;
          }
        }
      },
      /**
       * Resume a previously established session on a fresh connection
       * without a hello: the durable netlayer has authenticated the
       * resumption (its resume token), and the embedder supplies the
       * session's durable identity, including its private key when
       * persisted, so handoff signatures made before a restart keep
       * verifying after it.
       *
       * @param {Connection} connection
       * @param {SessionResumption} resumption
       */
      resumeSession: (connection, resumption) => {
        if (resumption.selfPrivateKeyBytes !== undefined) {
          const location =
            connectionLocationMap.get(connection) ??
            /** @type {NetLayer} */ (netlayer).location;
          connectionSelfIdentityMap.set(
            connection,
            makeSelfIdentity(
              cryptography,
              location,
              resumption.selfPrivateKeyBytes,
            ).selfIdentity,
          );
        }
        const selfIdentity = getSelfIdentityForConnection(connection);
        return sessionTable.resolveSession(
          locationToLocationId(resumption.peerLocation),
          connection,
          {
            sessionId: resumption.sessionId,
            selfIdentity,
            remotePublicKeyBytes: resumption.peerPublicKeyBytes,
            remoteLocation: resumption.peerLocation,
            remoteLocationSignature: resumption.peerLocationSignature,
            isInitiator: connection.isOutgoing,
          },
        );
      },
    });

    netlayer = await makeNetlayer(netlayerHandlers, logger);
    const inner = netlayer;

    /**
     * @param {OcapnLocation} location
     * @returns {Promise<AdoptableSession>}
     */
    const provideSession = async location => {
      const locationId = locationToLocationId(location);
      const active = activeSessions.get(locationId);
      if (active) return active.adoptable;
      const pending = pendingSessions.get(locationId);
      if (pending) return pending.promise;
      // `connect` may be asynchronous. Only `await` when it is, so the
      // synchronous path registers its pending session without an
      // intervening turn.
      const connectResult = inner.connect(location);
      const connection =
        connectResult instanceof Promise ? await connectResult : connectResult;
      // While an asynchronous `connect` was dialing, an inbound hello (a
      // crossed hello) may have established a session for this location.
      // Adopt it and discard the redundant outbound connection rather
      // than sending a second hello, which the peer would reject as an
      // unexpected `op:start-session` and which would abort the session
      // it just established.
      const raced = activeSessions.get(locationId);
      if (raced) {
        connection.end();
        return raced.adoptable;
      }
      const racedPending = pendingSessions.get(locationId);
      if (racedPending) {
        connection.end();
        return racedPending.promise;
      }
      const selfIdentity = getSelfIdentityForConnection(connection);
      sendHandshake(connection, selfIdentity, captpVersion, codec);
      /** @type {PromiseKit<AdoptableSession>} */
      const { promise, resolve, reject } = makePromiseKit();
      pendingSessions.set(locationId, {
        outgoingConnection: connection,
        promise,
        resolve,
        reject,
      });
      return promise;
    };

    /** @type {OcapnNetwork} */
    const network = harden({
      networkId: /** @type {any} */ (inner).networkId ?? 'start-session',
      codec,
      location: inner.location,
      locationId: inner.locationId,
      provideSession,
      shutdown: () => inner.shutdown(),
    });
    return network;
  };
};
harden(makeStartSessionNetwork);
