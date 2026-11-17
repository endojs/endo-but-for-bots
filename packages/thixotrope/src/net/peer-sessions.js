// @ts-check
/** @import { Logger } from '../platform/logging.js' */
/** @import { ThixotropeStore } from '../store/store.js' */
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';
import { makeSessionId } from '@endo/ocapn/cryptography';
import {
  readOcapnHandshakeMessage,
  writeOcapnHandshakeMessage,
} from '@endo/ocapn/operations';

import { isSessionToken } from '../store/store-validators.js';

// A durable peer session's record; version 1 recorded receipts only.
const SESSION_RECORD_VERSION = 2;

/**
 * Peer sessions on the hub: every connection the netlayer makes or accepts
 * becomes one hub session, through the OCapN handshake on an incoming
 * connection, a dial for a gift's exporter, or a resume of a durable
 * session from its record. The record is the session's own: its frames,
 * watermarks, handshake and identity, kept by the store under the
 * netlayer's resumption token and read back by the netlayer through the
 * `resumption` power.
 *
 * @param {object} powers
 * @param {any} powers.hub
 * @param {ThixotropeStore} powers.store
 * @param {any} powers.cryptography
 * @param {any} powers.codec
 * @param {{ netlayer?: any }} powers.netlayerRef the netlayer, once the
 *   daemon has made it
 * @param {() => string} powers.randomHex128
 * @param {Logger} powers.log
 * @param {() => boolean} powers.isStopped
 */
export const makePeerSessions = ({
  hub,
  store,
  cryptography,
  codec,
  netlayerRef,
  randomHex128,
  log,
  isStopped,
}) => {
  /** @type {Map<object, { deliver: any, detach: any, key: string } | undefined>} */
  const connectionSessions = new Map();

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
    // A connection without a resume token is a transient session: the
    // peer cannot come back to it, and a start forgets any a crash left.
    // The key must be unique forever: a counter would reset in a
    // successor process and inherit the persisted hub tables of a
    // previous process's connection.
    return `transient:${randomHex128()}`;
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
  const connect = (location, sessionKey) => {
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
      log.error('handoff dial failed:', error);
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
      if (isStopped()) return;
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
          log.error('handoff handshake failed:', error);
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
        log.error('handshake failed:', error);
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
      if (isStopped()) return;
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
      if (bound.key.startsWith('transient:')) {
        // A transient peer never comes back: retire its rows (holders
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
        version: SESSION_RECORD_VERSION,
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
      if (meta.version !== SESSION_RECORD_VERSION) return undefined;
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

  return harden({
    hubHandlers,
    resumption,
    /** The hub's `handoffs.connect` power. */
    connect,
    /** The hub session keys of the connections bound at the moment. */
    connectedSessionKeys: () =>
      [...connectionSessions.values()].flatMap(bound =>
        bound ? [bound.key] : [],
      ),
  });
};
harden(makePeerSessions);
