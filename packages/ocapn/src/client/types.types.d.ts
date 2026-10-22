// spell-out-exempt: SwissNum and argument abbreviations come from the OCapN API.
import type { ERef, FarRef } from '@endo/eventual-send';
import type { ParcelObject, RemotableObject } from '@endo/pass-style';

import type { OcapnLocation, OcapnSignature } from '../codecs/components.js';
import type { HandoffReceiveSigEnvelope } from '../codecs/descriptors.js';
import type { OcapnKeyPair, OcapnPublicKey } from '../cryptography.js';
import type { GrantTracker } from './grant-tracker.js';
import type { Ocapn } from './ocapn.js';
import type { ParcelTracker } from './parcels.js';

/**
 * A string used for referencing, such as keys in Maps. Not part of OCapN spec.
 */
export type LocationId = string & {
  _brand: 'LocationId';
};
/**
 * From OCapN spec. Id for a session between two peers.
 */
export type SessionId = Uint8Array & {
  _brand: 'SessionId';
};
/**
 * From OCapN spec. Used for resolving Parcels.
 */
export type SwissNum = Uint8Array & {
  _brand: 'SwissNum';
};
/**
 * From OCapN spec. Identifier for a public key (double SHA-256 hash of key descriptor).
 */
export type PublicKeyId = Uint8Array & {
  _brand: 'PublicKeyId';
};
/**
 * The OCapN-specified bootstrap interface implemented by each client.
 *
 * The protocol fixes the bootstrap's own shape, but says nothing about
 * what a swissnum designates: that is an agreement between the peer
 * that published the capability and the caller that knows the secret.
 * `fetch` is therefore generic over the interface the caller expects,
 * which the caller supplies from the contextual type of the receiving
 * declaration. Left to infer, `T` is `unknown`, so a caller that names
 * nothing is no worse off than before.
 *
 * It returns `Promise<T>` rather than `ERef<T>` because `E()` preserves
 * a method's type parameters only when the declared return type is
 * already a promise; see `ECallable` in `@endo/eventual-send`. With
 * `ERef<T>` the signature survives as far as the interface declaration
 * and is then flattened to `Promise<unknown>` at every `E(bootstrap)
 * .fetch(…)` call, which is exactly where the caller needs it.
 */
export type OcapnBootstrap = {
  fetch: <T = unknown>(swissnum: SwissNum) => Promise<T>;
  'deposit-gift': (
    giftId: ArrayBufferLike,
    gift: RemotableObject,
  ) => ERef<undefined>;
  'withdraw-gift': (
    signedHandoffReceive: HandoffReceiveSigEnvelope,
  ) => ERef<RemotableObject>;
};
/**
 * A remote object or promise imported during session resumption.
 */
export type RemoteImport = FarRef<object> | Promise<unknown>;
/**
 * Materialize (or find) a session's import at a peer export position —
 * the restore-time counterpart of receiving the reference in a
 * message, used to re-link references that cross sessions.
 *
 * The wire gives nothing but a slot, so the interface behind it is the
 * caller's to name: the two call signatures are keyed on the slot's
 * `type` discriminant, and each infers `T` from the contextual type of
 * the receiving declaration. Left to infer, the results are the two
 * arms of {@link RemoteImport}.
 */
export type ProvideImport = {
  <T = object>(slotInfo: { type: 'o'; position: bigint }): FarRef<T>;
  <T = unknown>(slotInfo: { type: 'p'; position: bigint }): Promise<T>;
};
export type NetLayer = {
  location: OcapnLocation;
  locationId: LocationId;
  connect: (location: OcapnLocation) => Connection | Promise<Connection>;
  shutdown: () => void;
  /**
   * Optional. Called during the `op:start-session` handshake, after the
   * peer's location signature validates, with the peer's claimed location.
   * A netlayer that authenticates the transport (e.g. iroh's QUIC-verified
   * EndpointId) should throw here unless the claimed `designator` matches
   * the transport-authenticated identity, binding the session's advertised
   * location to who the peer cryptographically is. Netlayers without
   * transport authentication omit it.
   */
  verifyPeerLocation?:
    ((connection: Connection, peerLocation: OcapnLocation) => void) | undefined;
};
/**
 * An OCapN Network is responsible for session establishment, authentication,
 * and encryption.  Each network defines its own handshake protocol and may
 * support multiple transports (WebSocket, TCP, etc.).
 *
 * This is the replacement for NetLayer as part of the network/transport
 * separation (see designs/ocapn-network-transport-separation.md).
 */
export type OcapnNetwork = {
  /**
   * - Unique identifier for this network.
   */
  networkId: string;
  /**
   * -
   * Wire codec this network uses. If present, the client adopts it at
   * registration time; this lets `makeOcapn()` be constructed without
   * an explicit codec. Two registered networks must agree on the codec
   * (and a codec passed to `makeOcapn({ codec })` must match).
   */
  codec?: import('../codec-interface.js').OcapnCodec | undefined;
  /**
   * - Shut the network down, closing
   * outgoing and inbound state.
   */
  shutdown: () => void;
  /**
   * -
   * Establish a raw connection to a peer. Required unless the network
   * implements `provideSession`. May be synchronous or asynchronous;
   * the client always awaits the result.
   */
  connect?:
    ((location: OcapnLocation) => Connection | Promise<Connection>) | undefined;
  /**
   * -
   * Return a fully authenticated session; the client bypasses its own
   * handshake machinery. Required unless the network implements `connect`.
   * May resolve undefined to decline the location, in which case the
   * client falls back to the `connect` + handshake path (used by
   * routing networks that front several transports).
   */
  provideSession?:
    | ((location: OcapnLocation) => Promise<NetworkSession | undefined>)
    | undefined;
  /**
   * - A representative location of
   * this network, used for self-location checks. Networks that do not
   * have a single fixed location may omit this.
   */
  location?: OcapnLocation | undefined;
  /**
   * - Cached locationId for `location`.
   */
  locationId?: LocationId | undefined;
  /**
   * -
   * Optional custom handshake for outgoing connections. If present, the
   * network owns the handshake bytes for this connection instead of the
   * default `op:start-session`. `selfIdentity` is supplied by the client
   * for networks that share its identity layer; networks with their own
   * identity (e.g. Noise) can ignore it.
   */
  sendSessionHandshake?:
    | ((
        connection: Connection,
        captpVersion: string,
        selfIdentity: SelfIdentity,
        codec: import('../codec-interface.js').OcapnCodec,
      ) => void)
    | undefined;
  /**
   * -
   * Optional custom handler for incoming handshake bytes. Returns true
   * if the data was consumed as a network-level handshake message, or
   * false to let the client fall back to the default handler.
   */
  handleSessionHandshake?:
    | ((
        connection: Connection,
        data: Uint8Array,
        selfIdentity: SelfIdentity,
        captpVersion: string,
      ) => boolean)
    | undefined;
  /**
   * -
   * Async iterable yielding fully-authenticated `NetworkSession`s that
   * the network accepted without a corresponding `provideSession` call
   * (e.g. a peer-initiated Noise handshake). The client consumes this
   * on `registerNetwork` and wires each session into its session
   * manager. Networks that have no concept of inbound sessions omit
   * this field.
   */
  inboundSessions?: AsyncIterable<NetworkSession> | undefined;
};
/**
 * The handoff interface between a network and OCapN core.
 * After the network establishes and authenticates a session (via
 * op:start-session, Noise Protocol, or other handshake), it delivers
 * a NetworkSession to OCapN core, which runs CapTP over it.
 */
export type NetworkSession = {
  /**
   * - Unique session identifier.
   */
  sessionId: SessionId;
  /**
   * - Our identity for this session,
   * supplied by the network (which authenticated to the peer using this
   * keypair during handshake).
   */
  selfIdentity: SelfIdentity;
  /**
   * - Peer's raw public
   * key bytes (needed to construct OcapnPublicKey for session).
   */
  remotePublicKeyBytes: Uint8Array;
  /**
   * - Peer's location.
   */
  remoteLocation: OcapnLocation;
  /**
   * -
   * Peer's location signature as verified during session establishment.
   */
  remoteLocationSignature: import('../codecs/components.js').OcapnSignature;
  /**
   * - Stream
   * yielding plaintext OCapN frames as they arrive from the peer. The
   * network is responsible for framing, decryption, and anything else
   * between the wire and whole OCapN messages. The client pumps this
   * reader and dispatches each frame to CapTP.
   */
  reader: import('@endo/stream').Reader<Uint8Array>;
  /**
   * - Stream
   * accepting plaintext OCapN frames destined for the peer. One
   * `writer.next(bytes)` carries one OCapN message; the network frames,
   * encrypts, and delivers.
   */
  writer: import('@endo/stream').Writer<Uint8Array>;
  /**
   * - Terminate session.
   */
  close: () => void;
  /**
   * - Whether we initiated this session.
   */
  isInitiator: boolean;
};
export type IncomingConnectionHandler = {
  /**
   * -
   * Called when a new incoming connection is established.
   */
  onConnection: (connection: Connection) => void;
};
export type PendingSession = {
  outgoingConnection: Connection | undefined;
  promise: Promise<InternalSession>;
  resolve: (session: InternalSession) => void;
  reject: (reason?: Error) => void;
};
/**
 * Minimal public session interface.
 * For full session access (testing/debugging), use debug.provideInternalSession().
 */
export type Session<Bootstrap = OcapnBootstrap> = {
  /**
   * - Get the remote bootstrap object
   */
  getBootstrap: () => FarRef<Bootstrap>;
  /**
   * - Abort the session
   */
  abort: (reason?: Error) => void;
};
/**
 * Full internal session with all properties for internal use and testing.
 */
export type InternalSession<Bootstrap = OcapnBootstrap> = {
  id: SessionId;
  peer: {
    publicKey: OcapnPublicKey;
    location: OcapnLocation;
    locationSignature: OcapnSignature;
  };
  self: {
    keyPair: OcapnKeyPair;
    location: OcapnLocation;
    locationSignature: OcapnSignature;
  };
  ocapn: Ocapn<Bootstrap>;
  connection: Connection;
  /**
   * Returns the current handoff count for this session as Receiver.
   * Does not increment the internal counter.
   */
  getHandoffCount: () => bigint;
  /**
   * Returns the next unique handoff count for this session as Receiver.
   * Increments the internal counter for subsequent calls.
   */
  takeNextHandoffCount: () => bigint;
};
export type SelfIdentity = {
  location: OcapnLocation;
  keyPair: OcapnKeyPair;
  locationSignature: OcapnSignature;
};
/**
 * Minimal public connection interface exposed to netlayer consumers.
 */
export type Connection = {
  /**
   * - Type brand to prevent structural compatibility
   */
  __brand?: 'Connection' | undefined;
  netlayer: NetLayer;
  isOutgoing: boolean;
  write: (bytes: Uint8Array) => void;
  end: () => void;
  isDestroyed: boolean;
};
export type Logger = {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
  info: (...args: any[]) => void;
};
export type SessionManager = {
  getActiveSession: (location: LocationId) => InternalSession | undefined;
  getOutgoingConnection: (location: LocationId) => Connection | undefined;
  getPendingSessionPromise: (
    location: LocationId,
  ) => Promise<InternalSession> | undefined;
  getSessionForConnection: (
    connection: Connection,
  ) => InternalSession | undefined;
  makePendingSession: (
    location: LocationId,
    connection: Connection,
  ) => PendingSession;
  resolveSession: (
    location: LocationId,
    connection: Connection,
    session: InternalSession,
  ) => void;
  /**
   * When a connection is no longer relevant to establishing a session.
   * Does not close the connection. Does not close or delete the session.
   */
  deleteConnection: (connection: Connection) => void;
  /**
   * When a session has ended (eg connection closed).
   * Does not close the connection. Does not delete the session.
   * Does not communicate with the peer.
   */
  endSession: (session: InternalSession) => void;
  /**
   * Finds and rejects any pending session associated with the given connection.
   * Returns true if a pending session was found and rejected, false otherwise.
   */
  rejectPendingSessionForConnection: (connection: Connection) => boolean;
  getPeerPublicKeyForSessionId: (
    sessionId: SessionId,
  ) => OcapnPublicKey | undefined;
};
/**
 * Socket operations provided by netlayer for a connection.
 */
export type SocketOperations = {
  /**
   * - Write bytes to the socket
   */
  write: (bytes: Uint8Array) => void;
  /**
   * - Close the socket
   */
  end: () => void;
};
/**
 * Handlers returned by registerNetlayer for the netlayer to call.
 */
export type NetlayerHandlers = {
  /**
   * Creates a connection wrapper. Client internally handles identity creation.
   * Caller is responsible for initiating handshake if needed (client does this in establishSession).
   */
  makeConnection: (
    netlayer: NetLayer,
    isOutgoing: boolean,
    socket: SocketOperations,
  ) => Connection;
  handleMessageData: (connection: Connection, data: Uint8Array) => void;
  handleConnectionClose: (connection: Connection, reason?: Error) => void;
  /**
   * Resume a previously established session on a fresh connection without an
   * op:start-session handshake. For durable netlayers only: the netlayer is
   * responsible for having authenticated the resumption (e.g. an unguessable
   * resume token), and the embedder supplies the session's durable identity.
   */
  resumeSession: (
    connection: Connection,
    resumption: SessionResumption,
  ) => ResumedSession;
};
/**
 * The deliberately narrow surface handed back from `resumeSession`,
 * just enough for the embedder to re-seat the session's exports.
 */
export type ResumedSession = {
  restoreExport: (position: bigint, value: object) => void;
  restorePendingResolver: (record: {
    resolverPosition: bigint;
    target: {
      kind: 'promise' | 'answer';
      position: bigint;
    };
  }) => void;
  /**
   * Materialize (or find) this session's import at a peer export
   * position — the restore-time counterpart of receiving the reference
   * in a message, used to re-link references that cross sessions.
   */
  provideImport: ProvideImport;
  /**
   * Skip the question counter past every answer position a previous
   * process could have used (the peer still holds those registrations),
   * e.g. by partitioning the position space by process epoch.
   */
  advanceAnswerPosition: (minimum: bigint) => void;
};
/**
 * The durable identity of a session, sufficient to resume it in a new
 * process — supplied by the embedder (persisted, or derived
 * deterministically as thixotrope's pipe sessions do) and replayed via
 * `NetlayerHandlers.resumeSession`.
 */
export type SessionResumption = {
  sessionId: SessionId;
  peerLocation: OcapnLocation;
  peerLocationSignature: OcapnSignature;
  peerPublicKeyBytes: Uint8Array;
  /**
   * resume with the same
   * session keys the previous process used, so cross-restart handoff
   * signatures keep verifying; omitted, fresh keys are minted
   */
  selfPrivateKeyBytes?: Uint8Array<ArrayBufferLike> | undefined;
};
/**
 * Optional observation hooks for durable-session embedders. Netlayers
 * and embedders that do not provide durability never see them.
 */
export type SessionHooks = {
  onExport?:
    | ((
        connection: Connection,
        slot: import('../captp/types.js').Slot,
        value: object,
      ) => void)
    | undefined;
  onImport?:
    | ((
        connection: Connection,
        slot: import('../captp/types.js').Slot,
        value: FarRef<object>,
      ) => void)
    | undefined;
  onPendingResolver?:
    | ((
        connection: Connection,
        resolverSlot: import('../captp/types.js').Slot,
        target: {
          kind: 'promise' | 'answer';
          position: bigint;
        },
      ) => void)
    | undefined;
  onResolverSettled?:
    | ((
        connection: Connection,
        resolverSlot: import('../captp/types.js').Slot,
      ) => void)
    | undefined;
};
/**
 * Debug/testing interface exposing internal APIs.
 * Only available when client is created with `debugMode: true`.
 */
export type ClientDebug<Bootstrap = OcapnBootstrap> = {
  logger: Logger;
  debugLabel: string;
  captpVersion: string;
  grantTracker: GrantTracker;
  sessionManager: SessionManager;
  parcelTracker: ParcelTracker;
  /**
   * Returns the full InternalSession object with all internal properties for debugging/testing.
   */
  provideInternalSession: (
    location: OcapnLocation,
  ) => Promise<InternalSession<Bootstrap>>;
};
/**
 * The caller-owned table `makeOcapn` consults when a peer asks for a
 * local capability (via `bootstrap.fetch(secret)`) or when resolving a
 * self-local `ParcelObject`. Any object with a `get(secret)` that returns a
 * capability, `undefined`, or a promise of either works; a plain `Map`
 * is a valid `NonceLocator`.
 *
 * The name parallels the `NonceLocator` term of art in E and Spritely
 * Goblins for a registry that resolves nonces (here, swissnums or
 * other secrets) to local capabilities. It also avoids the existing
 * `formatLocator`/`parseLocator` URI helpers in `@endo/daemon`, which
 * use the word `Locator` for the addressable URI form.
 */
export type NonceLocator = {
  get: (secret: string) => unknown | Promise<unknown>;
};
/**
 * The session-manager instance returned by `makeOcapn`.
 */
export type Client<Bootstrap = OcapnBootstrap> = {
  /**
   *   Open (or reuse) a CapTP session to the peer at `location`.
   */
  provideSession: (location: OcapnLocation) => Promise<Session<Bootstrap>>;
  /**
   *   Mint a ParcelObject: an addressable, passable `(location, secret)`
   *   pair. The secret may be a printable-ASCII string (the friendly
   *   form for locators keyed by name) or raw bytes for arbitrary-byte
   *   parcels (e.g. the 24-byte randoms Spritely Goblins mints).
   *   Peers resolve the secret against their own `NonceLocator`.
   */
  makeParcel: (
    location: OcapnLocation,
    secret: string | Uint8Array,
  ) => ParcelObject;
  /**
   *   Resolve a ParcelObject to a live capability: local Parcels go
   *   through the injected locator; remote Parcels fetch from the
   *   peer's bootstrap.
   */
  openParcel: (parcel: ParcelObject) => Promise<any>;
  shutdown: () => void;
  /**
   * Only present when the client was constructed with `debugMode:
   * true`. Exposes internal APIs for testing.
   */
  _debug?: ClientDebug<OcapnBootstrap> | undefined;
};
