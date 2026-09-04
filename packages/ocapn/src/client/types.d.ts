// spell-out-exempt: SwissNum spells the OCapN "Swiss number" domain term used package-wide.
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
 * From OCapN spec. Used for resolving SturdyRefs.
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
export type NetLayer = {
  location: OcapnLocation;
  locationId: LocationId;
  connect: (location: OcapnLocation) => Connection;
  shutdown: () => void;
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
export type Session = {
  /**
   * - Get the remote bootstrap object
   */
  getBootstrap: () => any;
  /**
   * - Abort the session
   */
  abort: (reason?: Error) => void;
};
/**
 * Full internal session with all properties for internal use and testing.
 */
export type InternalSession = {
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
  ocapn: Ocapn;
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
};
/**
 * Debug/testing interface exposing internal APIs.
 * Only available when client is created with `debugMode: true`.
 */
export type ClientDebug = {
  logger: Logger;
  debugLabel: string;
  captpVersion: string;
  grantTracker: GrantTracker;
  sessionManager: SessionManager;
  sturdyRefTracker: SturdyRefTracker;
  /**
   * Returns the full InternalSession object with all internal properties for debugging/testing.
   */
  provideInternalSession: (location: OcapnLocation) => Promise<InternalSession>;
};
export type Client = {
  registerNetlayer: <T extends NetLayer>(
    makeNetlayer: (
      handlers: NetlayerHandlers,
      logger: Logger,
    ) => T | Promise<T>,
  ) => Promise<T>;
  provideSession: (location: OcapnLocation) => Promise<Session>;
  makeSturdyRef: (location: OcapnLocation, swissNum: SwissNum) => SturdyRef;
  enlivenSturdyRef: (sturdyRef: SturdyRef) => Promise<any>;
  /**
   * Register an object with a swissnum string so it can be resolved via SturdyRef.
   */
  registerSturdyRef: (swissStr: string, object: any) => void;
  shutdown: () => void;
  /**
   * Only present when client is created with `debugMode: true`. Exposes internal APIs for testing.
   */
  _debug?: ClientDebug | undefined;
};
import type { OcapnLocation } from '../codecs/components.js';
import type { OcapnPublicKey } from '../cryptography.js';
import type { OcapnSignature } from '../codecs/components.js';
import type { OcapnKeyPair } from '../cryptography.js';
import type { Ocapn } from './ocapn.js';
import type { GrantTracker } from './grant-tracker.js';
import type { SturdyRefTracker } from './sturdyrefs.js';
import type { SturdyRef } from './sturdyrefs.js';
