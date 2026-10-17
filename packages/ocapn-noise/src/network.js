// @ts-check
/* global setTimeout, clearTimeout, setInterval, clearInterval */

/** @import { HeartbeatOptions, ReconnectOptions } from './types.js' */

/**
 * @typedef {import('./types.js').ByteStream} ByteStream
 * @typedef {import('./types.js').KeyIdHex} KeyIdHex
 * @typedef {import('./types.js').OcapnNoiseNetwork} OcapnNoiseNetwork
 * @typedef {import('./types.js').OcapnNoiseSession} OcapnNoiseSession
 * @typedef {import('./types.js').OcapnNoiseTransport} OcapnNoiseTransport
 * @typedef {import('./types.js').SigningKeys} SigningKeys
 * @typedef {import('./types.js').TransportListener} TransportListener
 * @typedef {import('@endo/ocapn/codec-interface').OcapnCodec} OcapnCodec
 * @typedef {import('@endo/ocapn/components').OcapnLocation} OcapnLocation
 * @typedef {import('@endo/ocapn/components').OcapnSignature} OcapnSignature
 */
/**
 * @template T
 * @typedef {import('@endo/stream').Reader<T>} Reader
 */
/**
 * @template T
 * @typedef {import('@endo/stream').Writer<T>} Writer
 */
/**
 * @template T
 * @typedef {import('@endo/stream').AsyncQueue<T>} AsyncQueue
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import { makeQueue } from '@endo/stream';
import { makeCryptography, makeSessionId } from '@endo/ocapn/cryptography';
import {
  readOcapnHandshakeMessage,
  readOcapnHeartbeatMessage,
  readOcapnSessionControlMessage,
  writeOcapnHandshakeMessage,
  writeOcapnHeartbeatMessage,
  writeOcapnSessionControlMessage,
} from '@endo/ocapn/operations';

// Resolved through the package's own `./platform` subpath so that
// bundlers and runtimes pick the right WASM adapter: Node reads the
// bytes synchronously from disk; browsers fetch and compile. A self
// import by package name lets the conditional `exports` map fire
// instead of locking us to the Node-only path.
// eslint-disable-next-line import/no-unresolved
import { wasmModule, getRandomValues } from '@endo/ocapn-noise/platform';
import {
  makeOcapnSessionCryptography,
  PREFIXED_SYN_LENGTH,
  SYNACK_LENGTH,
} from './bindings.js';
import { compareUint8Arrays } from './bytewise-compare.js';
import { initiatesOnCrossedHellos } from './crossed-hellos.js';

const CAPTP_VERSION = '1.0';

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const toHex = bytes => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
};

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
const hexToBytes = hex => {
  if (hex.length % 2 !== 0) throw Error('invalid hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * Assert that a peer key (an `np` designator / peer keyId) is canonical
 * lowercase hex for a 32-byte Ed25519 key. `hexToBytes` maps any non-hex
 * character to a zero byte, so a length-only check would let
 * `'z'.repeat(64)` through as 32 zero bytes (a small-order key); and the
 * raw string keys the `active`, `inProgress`, and `waiters` maps, so a
 * non-canonical spelling of a peer already held would split into a
 * distinct, duplicate entry. Every entry point that keys those maps by a
 * caller-supplied peer key runs this first.
 *
 * @param {string} keyId
 * @returns {KeyIdHex}
 */
const assertCanonicalKeyId = keyId => {
  if (typeof keyId !== 'string' || !/^[0-9a-f]{64}$/.test(keyId)) {
    throw makeError(
      X`ocapn-noise: peer designator must be 64 lowercase hex chars (a 32-byte Ed25519 key), got ${q(keyId)}`,
    );
  }
  return /** @type {KeyIdHex} */ (keyId);
};

/**
 * Return a genuine, integer-indexable `Uint8Array` covering the contents
 * of `buf`.
 *
 * The `byteArray` pass style is a frozen `Uint8Array` backed by an
 * immutable `ArrayBuffer`. In an engine without native immutable
 * ArrayBuffers the shim emulates it with a plain object that answers
 * `instanceof Uint8Array` and iterates correctly but has no
 * integer-indexed exotic slots, so `emulated[i]` reads `undefined`.
 * `ArrayBuffer.isView` — not `instanceof` — is the reliable test for a
 * genuine view (matching `@endo/immutable-arraybuffer`' `thawedBytes`): genuine
 * views (including those over immutable buffers, which permit indexed
 * reads) are returned as-is, while an emulated
 * `@endo/immutable-arraybuffer` wrapper (which reports
 * `ArrayBuffer.isView === false`) is copied into a fresh, genuine
 * `Uint8Array`.
 *
 * @param {Uint8Array} buf
 * @returns {Uint8Array}
 */
const asUint8 = buf =>
  ArrayBuffer.isView(buf)
    ? /** @type {Uint8Array} */ (buf)
    : new Uint8Array(/** @type {Uint8Array} */ (buf).slice());

/**
 * Pull one whole message from a message-framed `Reader<Uint8Array>`
 * (the transport applies its own framing: netstring for TCP, WebSocket
 * frames for WS, atomic puts for mock). Any message arriving on a byte
 * stream with no framing is a bug in the transport, not something we
 * paper over here.
 *
 * @param {Reader<Uint8Array>} reader
 * @returns {Promise<Uint8Array>}
 */
const readFrame = async reader => {
  const result = await reader.next(undefined);
  if (result.done) throw Error('stream closed before expected');
  return result.value;
};

/**
 * Assert that a framed message came in at the expected length. Useful
 * for the Noise handshake, where every message has a well-known size.
 *
 * @param {Uint8Array} bytes
 * @param {number} expected
 * @param {string} label
 */
const expectFrameLength = (bytes, expected, label) => {
  if (bytes.length !== expected) {
    throw Error(
      `ocapn-noise: expected ${label} of length ${expected}, got ${bytes.length}`,
    );
  }
};

/** Default per-phase handshake timeout, in milliseconds. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Cap on how many inbound handshakes can be mid-flight for one of our
 * local identities before the peer has proven itself. Combined with the
 * handshake timeout, this bounds the WASM instances and Diffie-Hellman
 * work a flood against a single one of our identities can pin. When the
 * cap is full, the oldest unproven handshake is evicted to admit the new
 * one, so a flood cannot hold every slot for a whole handshake timeout:
 * a genuine peer, which proves itself within about one round trip, is
 * only displaced by an attacker sustaining a full cap's worth of new
 * handshakes per round trip.
 *
 * This is deliberately keyed on the responder's own identity, not on
 * the claimed peer: IK message 1 is replayable (Noise §7.7 destination
 * property 2) and its payload is attacker-chosen, so a pre-auth cap
 * keyed on the claimed peer would let a replay of one genuine peer's
 * SYN exhaust that peer's budget and lock the peer out.
 */
const DEFAULT_MAX_IN_PROGRESS_PER_LOCAL_KEY = 256;

/** Default `HEARTBEAT_INTERVAL`, per designs/ocapn-noise-session-reconnect.md § 5. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

/**
 * The default `SESSION_TIMEOUT` is this multiple of the heartbeat
 * interval: 30 s for the default 5 s interval.
 */
const DEFAULT_SESSION_TIMEOUT_INTERVALS = 6;

/** The design's floor: `SESSION_TIMEOUT >= 3 * HEARTBEAT_INTERVAL`. */
const MIN_SESSION_TIMEOUT_INTERVALS = 3;

/**
 * @param {HeartbeatOptions | undefined} heartbeat
 * @returns {{ intervalMs: number, sessionTimeoutMs: number } | undefined}
 */
const normalizeHeartbeatOptions = heartbeat => {
  if (heartbeat === undefined) return undefined;
  const { intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS } = heartbeat;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw makeError(
      X`ocapn-noise: heartbeat.intervalMs must be a positive number, got ${q(intervalMs)}`,
    );
  }
  const { sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_INTERVALS * intervalMs } =
    heartbeat;
  if (
    !Number.isFinite(sessionTimeoutMs) ||
    sessionTimeoutMs < MIN_SESSION_TIMEOUT_INTERVALS * intervalMs
  ) {
    throw makeError(
      X`ocapn-noise: heartbeat.sessionTimeoutMs must be at least ${q(MIN_SESSION_TIMEOUT_INTERVALS)} times heartbeat.intervalMs, got ${q(sessionTimeoutMs)}`,
    );
  }
  return harden({ intervalMs, sessionTimeoutMs });
};

/** `op:session-hello` feature bit: the sender runs the heartbeat. */
const FEATURE_HEARTBEAT = 1n;
/** `op:session-hello` feature bit: the sender resumes lost sessions. */
const FEATURE_RECONNECT = 2n;

/**
 * @param {bigint} features
 * @param {bigint} bit
 */
const hasFeature = (features, bit) => (features / bit) % 2n === 1n;

/** Defaults per designs/ocapn-noise-session-reconnect.md § 5. */
const DEFAULT_RECONNECT_BACKOFF_INITIAL_MS = 250;
const DEFAULT_RECONNECT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_SESSION_HARD_TIMEOUT_MS = 10 * 60_000;

/**
 * @param {ReconnectOptions | boolean | undefined} reconnect
 * @param {{ intervalMs: number, sessionTimeoutMs: number } | undefined} heartbeatSettings
 * @returns {{ backoffInitialMs: number, backoffMaxMs: number, hardTimeoutMs: number } | undefined}
 */
const normalizeReconnectOptions = (reconnect, heartbeatSettings) => {
  if (reconnect === undefined || reconnect === false) return undefined;
  if (heartbeatSettings === undefined) {
    throw makeError(
      X`ocapn-noise: reconnect requires heartbeat, which detects the loss it recovers from`,
    );
  }
  const {
    backoffInitialMs = DEFAULT_RECONNECT_BACKOFF_INITIAL_MS,
    hardTimeoutMs = DEFAULT_SESSION_HARD_TIMEOUT_MS,
  } = reconnect === true ? {} : reconnect;
  const {
    backoffMaxMs = Math.min(DEFAULT_RECONNECT_BACKOFF_MAX_MS, hardTimeoutMs),
  } = reconnect === true ? {} : reconnect;
  for (const [name, value] of /** @type {const} */ ([
    ['backoffInitialMs', backoffInitialMs],
    ['backoffMaxMs', backoffMaxMs],
    ['hardTimeoutMs', hardTimeoutMs],
  ])) {
    if (!(value > 0)) {
      throw makeError(
        X`ocapn-noise: reconnect.${q(name)} must be a positive number of milliseconds, got ${q(value)}`,
      );
    }
  }
  if (backoffMaxMs < backoffInitialMs || backoffMaxMs > hardTimeoutMs) {
    throw makeError(
      X`ocapn-noise: reconnect.backoffMaxMs must lie between backoffInitialMs and hardTimeoutMs, got ${q(backoffMaxMs)}`,
    );
  }
  return harden({ backoffInitialMs, backoffMaxMs, hardTimeoutMs });
};

/**
 * Count the transport-phase messages the receiving Noise CipherState
 * has accepted. Each successful `decrypt` consumes exactly one nonce,
 * so the count minus one is the highest receive nonce, which `op:pong`
 * acknowledges.
 *
 * @param {(bytes: Uint8Array) => Uint8Array} decrypt
 */
const countReceivedNonces = decrypt => {
  let receivedCount = 0n;
  return harden({
    /** @param {Uint8Array} bytes */
    decrypt: bytes => {
      const plainText = decrypt(bytes);
      receivedCount += 1n;
      return plainText;
    },
    getReceivedCount: () => receivedCount,
  });
};

/** Maximum number of unconsumed peer-initiated sessions to buffer. */
const MAX_PENDING_INBOUND_SESSIONS = 256;

/**
 * Race a promise against a `setTimeout` firing after `ms`. Returns the
 * promise's value if it settles first; otherwise rejects with a
 * `label`-tagged `Error` and closes the supplied stream so the inner
 * `reader.next()` doesn't keep pulling bytes into a now-dead handshake.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label - Used in the timeout error message; pick a
 *   noun phrase like `'SYN'` or `'post-handshake greeting'`.
 * @param {ByteStream} [stream] - If provided, its reader and writer are
 *   closed when the timer fires so the abandoned read no longer holds
 *   the byteStream alive.
 * @returns {Promise<T>}
 */
const withTimeout = (promise, ms, label, stream) => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeoutPromise = /** @type {Promise<T>} */ (
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        if (stream) {
          // Close both halves so the abandoned `reader.next()` settles.
          // Errors are intentionally swallowed: at this point the
          // transport may already be torn down by the peer.
          Promise.resolve(stream.writer.return(undefined)).catch(() => {});
          Promise.resolve(stream.reader.return(undefined)).catch(() => {});
        }
        reject(Error(`ocapn-noise: ${label} timed out after ${ms}ms`));
      }, ms);
    })
  );
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

/**
 * Create an OCapN-Noise network. The network starts empty: add signing
 * keys and transports at any point with `addSigningKeys` and
 * `addTransport`.
 *
 * The network loads its own Noise WASM module internally (via the
 * `./wasm/node.js` platform adapter) and hard-codes the one CapTP
 * version currently defined.
 *
 * @param {{
 *   codec: OcapnCodec,
 *   handshakeTimeoutMs?: number,
 *   maxInProgressPerLocalKey?: number,
 *   heartbeat?: HeartbeatOptions,
 *   reconnect?: ReconnectOptions | boolean,
 * }} options
 * @returns {OcapnNoiseNetwork}
 */
export const makeOcapnNoiseNetwork = ({
  codec,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  maxInProgressPerLocalKey = DEFAULT_MAX_IN_PROGRESS_PER_LOCAL_KEY,
  heartbeat,
  reconnect,
}) => {
  const cryptography = makeCryptography(codec);
  const heartbeatSettings = normalizeHeartbeatOptions(heartbeat);
  const localReconnectSettings = normalizeReconnectOptions(
    reconnect,
    heartbeatSettings,
  );
  const localFeatures =
    (heartbeatSettings === undefined ? 0n : FEATURE_HEARTBEAT) +
    (localReconnectSettings === undefined ? 0n : FEATURE_RECONNECT);

  /**
   * One concrete transport connection under a session, with the Noise
   * CipherStates of the handshake that opened it.
   *
   * @typedef {{
   *   stream: ByteStream,
   *   encrypt: (bytes: Uint8Array) => Uint8Array,
   *   decrypt: (bytes: Uint8Array) => Uint8Array,
   *   getReceivedCount: () => bigint,
   *   sentCount: bigint,
   * }} Instance
   */
  /**
   * A frame waiting for the transport. Session frames carry their
   * position in the session's frame stream; heartbeats carry none.
   *
   * @typedef {{ index: bigint | undefined, render: () => Uint8Array }} OutboundFrame
   */
  /**
   * The network's handle on a session that resumes after loss.
   *
   * @typedef {{
   *   sessionToken: Uint8Array,
   *   getEpoch: () => bigint,
   *   isAttached: () => boolean,
   *   prefersOwnDial: () => boolean,
   *   getReceivedFrames: () => bigint,
   *   attach: (instance: Instance, epoch: bigint, peerReceived: bigint) => void,
   *   abort: (error: Error) => void,
   *   dial: (epoch: bigint, received: bigint) => Promise<{ instance: Instance, peerHello: SessionHello }>,
   * }} Reconnector
   */
  /**
   * @typedef {{
   *   type: 'op:session-hello',
   *   features: bigint,
   *   epoch: bigint,
   *   session: Uint8Array,
   *   received: bigint,
   * }} SessionHello
   */
  /**
   * Sessions that resume after loss, by peer key, so an inbound
   * reconnect handshake finds the session it continues.
   *
   * @type {Map<KeyIdHex, Reconnector>}
   */
  const reconnectors = new Map();

  /**
   * @typedef {{
   *   keyId: KeyIdHex,
   *   privateKey: Uint8Array,
   *   publicKey: Uint8Array,
   *   keyPair: ReturnType<typeof cryptography.makeOcapnKeyPairFromPrivateKey>,
   * }} RegisteredKey
   */

  /** @type {Map<KeyIdHex, RegisteredKey>} */
  const registeredKeys = new Map();
  /** @type {Set<OcapnNoiseTransport>} */
  const registeredTransports = new Set();
  /** @type {Map<OcapnNoiseTransport, TransportListener>} */
  const listenersByTransport = new Map();

  /**
   * Crossed-hello state. A pair of peers may independently dial each
   * other and complete two separate Noise handshakes; to keep the rest
   * of the system seeing exactly one session per peer, we compare the
   * two initiators' ephemeral x25519 public keys bytewise and keep the
   * session whose initiator picked the lesser key. Both peers make the
   * same comparison against the same bytes and arrive at the same
   * winner, so no protocol-level coordination is needed.
   *
   * The `inProgress` count gates graduation: a candidate sits in
   * `candidates` until no more handshakes to the same peer are in
   * flight; at that point we compare tiebreakers, close the losers,
   * promote the winner to `active`, and release callers waiting on
   * `waiters`.
   *
   * @typedef {{ session: OcapnNoiseSession, tiebreaker: Uint8Array, reconnector?: Reconnector, close: () => void }} Candidate
   */
  /** @type {Map<KeyIdHex, Candidate>} */
  const active = new Map();
  /** @type {Map<KeyIdHex, Candidate[]>} */
  const candidates = new Map();
  /** @type {Map<KeyIdHex, number>} */
  const inProgress = new Map();
  /**
   * Unproven inbound handshakes, keyed on our own local identity (the
   * SYN's intended responder), not on the claimed peer, oldest first.
   * Each entry aborts its handshake. Bounds the work an inbound flood can
   * pin before `exchangeIdentity` proves the peer. Admitted before the
   * Noise SYN-decrypt and released when the handshake attempt concludes,
   * in `handleIncoming`'s `finally`.
   * @type {Map<KeyIdHex, Set<() => void>>}
   */
  const inFlightByLocalKey = new Map();
  /** @type {Map<KeyIdHex, { resolve: (s: OcapnNoiseSession) => void, reject: (e: Error) => void }[]>} */
  const waiters = new Map();
  /** @type {Map<KeyIdHex, string[]>} */
  const recentErrors = new Map();

  /**
   * Queue of graduated sessions that nobody asked for via
   * `provideSession` (i.e. peer-initiated handshakes). Drained by any
   * consumer iterating `inboundSessions`.
   *
   * @type {import('@endo/stream').AsyncQueue<IteratorResult<OcapnNoiseSession, undefined>>}
   */
  const inboundQueue = makeQueue();
  let inboundClosed = false;

  /**
   * Set true by `shutdown()`. Used by `recordCandidate` and
   * `decrementAndSettle` to avoid promoting a late-arriving candidate
   * into the now-emptied `active` map (where nothing would ever close
   * it again, leaking the underlying socket and WASM cipher state).
   */
  let isShutdown = false;

  /** @param {KeyIdHex} peerId */
  const bumpInProgress = peerId => {
    inProgress.set(peerId, (inProgress.get(peerId) ?? 0) + 1);
  };

  /**
   * Admit an inbound handshake against `localKeyId`'s budget, evicting
   * the oldest unproven handshake if the budget is full. Returns the
   * release function for `handleIncoming`'s `finally`.
   *
   * @param {KeyIdHex} localKeyId
   * @param {() => void} abort
   * @returns {() => void}
   */
  const admitInbound = (localKeyId, abort) => {
    let admitted = inFlightByLocalKey.get(localKeyId);
    if (!admitted) {
      admitted = new Set();
      inFlightByLocalKey.set(localKeyId, admitted);
    }
    if (admitted.size >= maxInProgressPerLocalKey) {
      const [oldest] = admitted;
      if (oldest) {
        admitted.delete(oldest);
        oldest();
      }
    }
    admitted.add(abort);
    const set = admitted;
    return () => {
      set.delete(abort);
      if (set.size === 0 && inFlightByLocalKey.get(localKeyId) === set) {
        inFlightByLocalKey.delete(localKeyId);
      }
    };
  };

  /**
   * @param {KeyIdHex} peerId
   * @param {Candidate} candidate
   */
  const recordCandidate = (peerId, candidate) => {
    if (isShutdown) {
      // Network is shutting down. The candidate's underlying socket
      // and WASM cipher state would otherwise become unreachable
      // through the post-shutdown empty `active` map. Close it now.
      candidate.close();
      return;
    }
    const list = candidates.get(peerId) ?? [];
    list.push(candidate);
    candidates.set(peerId, list);
  };

  /**
   * Cap on how many outstanding errors we keep per peer. A
   * pathological retry loop against one designator would otherwise
   * grow `recentErrors` without bound between successful settlements.
   */
  const MAX_RECENT_ERRORS_PER_PEER = 4;

  /**
   * Record an error against `peerId`. Stores `err.message` strings, not
   * `Error` instances, so a failure path that later surfaces to a
   * waiter does not propagate stack traces (which may include WASM
   * memory views) across security domains.
   *
   * @param {KeyIdHex} peerId
   * @param {Error} err
   */
  const recordError = (peerId, err) => {
    const list = recentErrors.get(peerId) ?? [];
    list.push(err && err.message ? err.message : String(err));
    while (list.length > MAX_RECENT_ERRORS_PER_PEER) list.shift();
    recentErrors.set(peerId, list);
  };

  /**
   * Tracks peer-initiated sessions that are queued for the
   * `inboundSessions` iterable but have not yet been consumed. Bounded
   * by `MAX_PENDING_INBOUND_SESSIONS`; if the embedder never iterates,
   * we close the oldest sessions rather than pinning their transport
   * sockets and WASM cipher state in memory.
   *
   * @type {OcapnNoiseSession[]}
   */
  const pendingInbound = [];

  /**
   * Local outbound dials (`runInitiator`) in flight per peer. Only we
   * can start them, and their handshake steps carry their own timeouts
   * (the transport's `connect` does not), so a settlement deadline never
   * cuts one short.
   *
   * @type {Map<KeyIdHex, number>}
   */
  const outboundInFlight = new Map();

  /**
   * Per-peer settlement deadline. Settlement normally waits for every
   * in-flight handshake to the peer (so crossed hellos run the tiebreaker
   * over both), but each inbound SYN, including a replayed one, adds to
   * that set. Once no local dial to the peer is in flight and something
   * is waiting on the outcome (a proven candidate, or a caller), the
   * deadline settles over whatever has been proven within one more
   * `handshakeTimeoutMs`. A stream of replays therefore delays a dial by
   * at most that much, and a failed outbound dial still rejects its
   * waiters. A genuine crossed hello whose second direction takes longer
   * than that to prove can still be settled without it.
   *
   * @type {Map<KeyIdHex, ReturnType<typeof setTimeout>>}
   */
  const settleDeadlines = new Map();

  /** @param {KeyIdHex} peerId */
  const shouldSettleEarly = peerId =>
    !outboundInFlight.has(peerId) &&
    (candidates.has(peerId) || waiters.has(peerId));

  /** @param {KeyIdHex} peerId */
  const settle = peerId => {
    const deadline = settleDeadlines.get(peerId);
    if (deadline !== undefined) {
      clearTimeout(deadline);
      settleDeadlines.delete(peerId);
    }

    const fresh = candidates.get(peerId) ?? [];
    candidates.delete(peerId);
    const existing = active.get(peerId);

    // Crossed-hellos dedup applies only to concurrent initial
    // handshakes. Once a session is already `active`, we do NOT
    // re-evaluate the tiebreaker: any new candidates that arrive later
    // are dropped so the live session is never silently closed out
    // from under the CapTP layer. Waiters that queued while `active`
    // was already set must still be resolved with the live session.
    if (existing) {
      for (const c of fresh) c.close();
      recentErrors.delete(peerId);
      const queue = waiters.get(peerId) ?? [];
      waiters.delete(peerId);
      for (const { resolve } of queue) resolve(existing.session);
      return;
    }

    if (fresh.length === 0) {
      // Every handshake failed. Reject callers with the most recent
      // error message; collapse any earlier ones into AggregateError
      // when there is more than one so callers see them all.
      const errs = recentErrors.get(peerId) ?? [];
      recentErrors.delete(peerId);
      const queue = waiters.get(peerId) ?? [];
      waiters.delete(peerId);
      let reason;
      if (errs.length === 0) {
        reason = Error(`ocapn-noise: handshake failed for ${peerId}`);
      } else if (errs.length === 1) {
        reason = Error(`ocapn-noise: ${errs[0]}`);
      } else {
        reason = Error(
          `ocapn-noise: handshake failed for ${peerId}: ${errs[errs.length - 1]} (after ${errs.length - 1} earlier failure${errs.length > 2 ? 's' : ''})`,
        );
      }
      for (const { reject } of queue) reject(reason);
      return;
    }

    // Pick the candidate whose initiator's ephemeral is lesser.
    let winner = fresh[0];
    for (let i = 1; i < fresh.length; i += 1) {
      if (compareUint8Arrays(fresh[i].tiebreaker, winner.tiebreaker) < 0) {
        winner = fresh[i];
      }
    }
    for (const c of fresh) if (c !== winner) c.close();

    active.set(peerId, winner);
    if (winner.reconnector) reconnectors.set(peerId, winner.reconnector);
    recentErrors.delete(peerId);

    const queue = waiters.get(peerId) ?? [];
    waiters.delete(peerId);
    if (queue.length > 0) {
      for (const { resolve } of queue) resolve(winner.session);
    } else if (!inboundClosed && !winner.session.isInitiator) {
      // Nobody is waiting on provideSession for this peer; this is a
      // peer-initiated session. Hand it off to the inboundSessions
      // iterable for the embedding client to wire up. If the queue
      // would exceed `MAX_PENDING_INBOUND_SESSIONS`, drop the oldest
      // entry to bound memory under attack.
      if (pendingInbound.length >= MAX_PENDING_INBOUND_SESSIONS) {
        const dropped = pendingInbound.shift();
        if (dropped) dropped.close();
      }
      pendingInbound.push(winner.session);
      inboundQueue.put(harden({ done: false, value: winner.session }));
    }
  };

  /** @param {KeyIdHex} peerId */
  const decrementAndSettle = peerId => {
    if (isShutdown) {
      // `shutdown()` already cleared `inProgress`, `candidates`,
      // `active`, and `waiters`, and closed every candidate it knew
      // about. A late-arriving handshake whose own `recordCandidate`
      // call now sees `isShutdown === true` will close itself; nothing
      // here is safe to touch.
      return;
    }
    const next = (inProgress.get(peerId) ?? 0) - 1;
    if (next > 0) {
      inProgress.set(peerId, next);
      if (!settleDeadlines.has(peerId) && shouldSettleEarly(peerId)) {
        // Handshakes still in flight keep their own count; when they
        // finish they settle again, and a late candidate then meets the
        // `existing` branch of `settle` (or becomes a fresh session if
        // this settlement found none).
        settleDeadlines.set(
          peerId,
          setTimeout(() => {
            settleDeadlines.delete(peerId);
            // A local dial started since arming will settle when it
            // finishes; do not reject its caller out from under it.
            if (isShutdown || !shouldSettleEarly(peerId)) return;
            try {
              settle(peerId);
            } catch (_err) {
              // Only a candidate's best-effort teardown can throw here.
            }
          }, handshakeTimeoutMs),
        );
      }
      return;
    }
    inProgress.delete(peerId);
    settle(peerId);
  };

  /**
   * Forget the active entry for `peerId` if (and only if) it still
   * matches the supplied candidate. Wired into `buildSession.close` so
   * a closed session does not linger as a "live" cache entry that
   * future `provideSession` calls would resurrect.
   *
   * @param {KeyIdHex} peerId
   * @param {Candidate} candidate
   */
  const forgetActive = (peerId, candidate) => {
    if (active.get(peerId) === candidate) {
      active.delete(peerId);
    }
    // A candidate that closes while still awaiting settlement (its peer
    // hung up, or re-dialed, before a straggler finished) must not be
    // picked as the winner.
    const pending = candidates.get(peerId);
    const index = pending ? pending.indexOf(candidate) : -1;
    if (pending && index !== -1) {
      pending.splice(index, 1);
      if (pending.length === 0) candidates.delete(peerId);
    }
    // Drop any stale recent-error trail; if the peer reconnects, a
    // fresh failure history is more useful than the previous one.
    recentErrors.delete(peerId);
  };

  /**
   * Resolve when an active session for `peerId` is available, or
   * reject when the in-flight handshakes all fail. Used by both
   * `provideSession` (after kicking off `runInitiator`) and
   * `waitForInboundSession`.
   *
   * @param {KeyIdHex} peerId
   */
  const awaitActiveSession = peerId =>
    new Promise((resolve, reject) => {
      const existing = active.get(peerId);
      if (existing && !inProgress.has(peerId)) {
        resolve(existing.session);
        return;
      }
      const list = waiters.get(peerId) ?? [];
      list.push({ resolve, reject });
      waiters.set(peerId, list);
    });

  /**
   * Aggregate the hints from all currently-listening transports into
   * one hints table, prefixed by each transport's scheme.
   *
   * @returns {Record<string, string>}
   */
  const aggregatedHints = () => {
    /** @type {Record<string, string>} */
    const hints = {};
    for (const [transport, listener] of listenersByTransport) {
      for (const [k, v] of Object.entries(listener.hints)) {
        hints[`${transport.scheme}:${k}`] = v;
      }
    }
    return hints;
  };

  /**
   * @param {RegisteredKey} rk
   * @returns {OcapnLocation}
   */
  const buildLocationFor = rk => {
    const hints = aggregatedHints();
    return harden({
      type: /** @type {'ocapn-peer'} */ ('ocapn-peer'),
      network: 'np',
      transport: 'np',
      designator: rk.keyId,
      hints: Object.keys(hints).length > 0 ? { ...hints } : false,
    });
  };

  /**
   * Select a transport for reaching `location` by matching hint prefixes.
   *
   * @param {OcapnLocation} location
   * @returns {{ transport: OcapnNoiseTransport, hints: Record<string, string> }}
   */
  const selectOutgoingTransport = location => {
    const { hints } = location;
    if (!hints || typeof hints !== 'object') {
      throw makeError(
        X`ocapn-noise: location ${q(location.designator)} has no hints`,
      );
    }
    for (const transport of registeredTransports) {
      const prefix = `${transport.scheme}:`;
      /** @type {Record<string, string>} */
      const matching = {};
      for (const [key, value] of Object.entries(hints)) {
        if (key.startsWith(prefix) && typeof value === 'string') {
          matching[key.slice(prefix.length)] = value;
        }
      }
      if (Object.keys(matching).length > 0) {
        return { transport, hints: matching };
      }
    }
    throw makeError(
      X`ocapn-noise: no registered transport matches hints ${q(hints)}`,
    );
  };

  /**
   * Post-handshake `op:start-session` exchange over the encrypted
   * tunnel. Establishes the peer's verified OCapN location signature
   * (needed by three-party handoffs) and binds the peer's ed25519 key
   * to the key Noise authenticated.
   *
   * @param {RegisteredKey} localKey
   * @param {Reader<Uint8Array>} reader
   * @param {Writer<Uint8Array>} writer
   * @param {(bytes: Uint8Array) => Uint8Array} encrypt
   * @param {(bytes: Uint8Array) => Uint8Array} decrypt
   * @param {Uint8Array} peerEd25519
   * @param {Uint8Array} handshakeHash - 32-byte Noise transcript hash
   *   used as the channel-binding value for the location signature so
   *   it cannot be replayed across sessions.
   */
  const exchangeIdentity = async (
    localKey,
    reader,
    writer,
    encrypt,
    decrypt,
    peerEd25519,
    handshakeHash,
  ) => {
    await null;
    const location = buildLocationFor(localKey);
    const locationSignature = cryptography.signLocation(
      location,
      localKey.keyPair,
      handshakeHash.buffer,
    );
    const greeting = writeOcapnHandshakeMessage(
      {
        type: 'op:start-session',
        captpVersion: CAPTP_VERSION,
        sessionPublicKey: localKey.keyPair.publicKey.descriptor,
        location,
        locationSignature,
      },
      codec,
    );
    await writer.next(encrypt(greeting));

    const cipher = await readFrame(reader);
    const plain = decrypt(cipher);
    const msgReader = codec.makeReader(plain);
    const message = readOcapnHandshakeMessage(msgReader);
    if (message.type !== 'op:start-session') {
      throw makeError(
        X`ocapn-noise: expected op:start-session, got ${q(message.type)}`,
      );
    }
    if (message.captpVersion !== CAPTP_VERSION) {
      throw makeError(
        X`ocapn-noise: captp version mismatch ${q(message.captpVersion)} vs ${q(CAPTP_VERSION)}`,
      );
    }
    const peerPublicKey = cryptography.publicKeyDescriptorToPublicKey(
      message.sessionPublicKey,
    );
    const peerBytes = asUint8(peerPublicKey.bytes);
    if (peerBytes.length !== peerEd25519.length) {
      throw makeError(X`ocapn-noise: peer public key length mismatch`);
    }
    // Non-constant-time comparison is safe: both operands are the
    // peer's public key (one from the authenticated Noise handshake,
    // the other from an encrypted `op:start-session` we just
    // received). Neither is a secret; there is nothing for a timing
    // oracle to extract.
    for (let i = 0; i < peerBytes.length; i += 1) {
      if (peerBytes[i] !== peerEd25519[i]) {
        throw makeError(X`ocapn-noise: peer key mismatch with Noise identity`);
      }
    }
    // Bind the peer's advertised location signature to our verified
    // knowledge of their key AND to the Noise handshake transcript so
    // a captured signature cannot be replayed into another session.
    cryptography.assertLocationSignatureValid(
      message.location,
      message.locationSignature,
      peerPublicKey,
      handshakeHash.buffer,
    );
    const advertised = /** @type {OcapnLocation} */ (message.location);
    if (advertised.designator !== toHex(peerEd25519)) {
      throw makeError(
        X`ocapn-noise: advertised designator ${q(advertised.designator)} does not match Noise identity ${q(toHex(peerEd25519))}`,
      );
    }
    return {
      peerLocation: advertised,
      peerLocationSignature: /** @type {OcapnSignature} */ (
        message.locationSignature
      ),
      peerPublicKey,
      location,
      locationSignature,
    };
  };

  /**
   * Send this side's `op:session-hello` on a transport instance whose
   * identity exchange just finished.
   *
   * @param {Writer<Uint8Array>} writer
   * @param {(bytes: Uint8Array) => Uint8Array} encrypt
   * @param {{ epoch: bigint, session: Uint8Array, received: bigint }} hello
   */
  const writeSessionHello = async (writer, encrypt, hello) => {
    await null;
    const bytes = writeOcapnSessionControlMessage(
      { type: 'op:session-hello', features: localFeatures, ...hello },
      codec,
    );
    await writer.next(encrypt(bytes));
  };

  /**
   * Read the peer's `op:session-hello`.
   *
   * @param {Reader<Uint8Array>} reader
   * @param {(bytes: Uint8Array) => Uint8Array} decrypt
   * @returns {Promise<SessionHello>}
   */
  const readSessionHello = async (reader, decrypt) => {
    await null;
    const plain = decrypt(await readFrame(reader));
    const message = readOcapnSessionControlMessage(codec.makeReader(plain));
    if (message.type !== 'op:session-hello') {
      throw makeError(
        X`ocapn-noise: expected op:session-hello, got ${q(message.type)}`,
      );
    }
    return harden({ ...message, session: asUint8(message.session) });
  };

  /**
   * Whether a hello opens a session (epoch 0) on the handshake it was
   * read from: the session it names must be that handshake's.
   *
   * @param {SessionHello} hello
   * @param {Uint8Array} handshakeHash
   */
  const opensSession = (hello, handshakeHash) =>
    hello.epoch === 0n &&
    compareUint8Arrays(hello.session, asUint8(handshakeHash)) === 0;

  /**
   * Build the streaming `NetworkSession` returned from `provideSession`.
   * Each inbound transport frame is one encrypted OCapN message; the
   * session reader decrypts and yields plaintext. The session writer
   * encrypts each outbound message and hands it to the transport as
   * one frame.
   *
   * With heartbeats, the session outlives the transport instance it
   * was built on. With reconnect negotiated as well, losing that
   * instance does not end the session: the dialing side runs a fresh
   * Noise IK handshake (Rekey) on a new transport instance, the session
   * epoch advances, and the frames the old instance did not deliver are
   * replayed on the new one exactly once.
   *
   * @param {object} params
   * @param {RegisteredKey} params.localKey
   * @param {OcapnLocation} params.location
   * @param {OcapnSignature} params.locationSignature
   * @param {OcapnLocation} params.peerLocation
   * @param {OcapnSignature} params.peerLocationSignature
   * @param {Uint8Array} params.peerEd25519
   * @param {boolean} params.isInitiator
   * @param {Instance} params.instance - The handshake's transport
   *   instance, epoch 0.
   * @param {Uint8Array} params.sessionToken - The Noise transcript hash
   *   of the handshake that opened the session, which names it in a
   *   reconnect's `op:session-hello`.
   * @param {Uint8Array} params.localEphemeral - This side's x25519
   *   ephemeral from the handshake that opened the session.
   * @param {Uint8Array} params.peerEphemeral - The peer's x25519
   *   ephemeral from that handshake. The two are the crossed-hellos
   *   tiebreaker on reconnect (designs/ocapn-noise-session-reconnect.md
   *   § 3).
   * @param {bigint} params.peerFeatures - The `features` bitset of the
   *   peer's `op:session-hello`.
   * @param {() => void} params.onClose - Called when the session closes
   *   (peer disconnect, local `close()`, or stream end). Used by the
   *   network to forget the entry from `active` so a future
   *   `provideSession` does not resurrect a dead session.
   * @returns {{ session: OcapnNoiseSession, reconnector: Reconnector | undefined }}
   */
  const buildSession = ({
    localKey,
    location,
    locationSignature,
    peerLocation,
    peerLocationSignature,
    peerEd25519,
    isInitiator,
    instance: firstInstance,
    sessionToken,
    localEphemeral,
    peerEphemeral,
    peerFeatures,
    onClose,
  }) => {
    let closed = false;
    const winsCrossedHellos = initiatesOnCrossedHellos(
      localEphemeral,
      peerEphemeral,
      isInitiator,
    );
    // Redials in flight. Each counts from its start until the turn in
    // which its result is attached or discarded, with no await in
    // between, so no peer dial is accepted after ours lands but before it
    // attaches.
    let dialing = 0;
    const reconnectSettings =
      heartbeatSettings !== undefined &&
      hasFeature(peerFeatures, FEATURE_RECONNECT)
        ? localReconnectSettings
        : undefined;

    // The session epoch numbers transport instances: 0 for the
    // handshake's, advancing by one on each reconnect.
    let epoch = 0n;
    /** @type {Instance | undefined} */
    let current = firstInstance;
    let pingSequence = 0n;
    let pongSequence = 0n;
    /** @type {bigint | undefined} */
    let peerAckedRecvNonce;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let heartbeatTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let livenessTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let writeStallTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let hardTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let redialTimer;
    /** @type {number | undefined} */
    let reconnectingSince;

    // The session-level outbound queue: frames the session has accepted
    // but the current transport instance has not. A frame is rendered
    // and encrypted only when it reaches the transport, so the queue can
    // outlive the transport instance it was filled for. Session frames
    // (not heartbeats) carry their position in the session's frame
    // stream, which a reconnect uses to replay each exactly once.
    /** @type {Array<OutboundFrame>} */
    let outbound = [];
    let queuedHeartbeatFrames = 0;
    // Session frames handed to the current instance that the peer has
    // not yet acknowledged by `op:pong`, kept for replay on reconnect.
    /** @type {Array<{ frame: OutboundFrame, nonce: bigint }>} */
    let unacked = [];
    let nextFrameIndex = 0n;
    // Session frames delivered to our reader, over every instance.
    let receivedFrames = 0n;
    /** @type {Instance | undefined} */
    let drainingFor;
    /** @type {Array<() => void>} */
    let drainWaiters = [];

    /** @type {() => void} */
    let resolveClosed = () => {};
    /** @type {Promise<void>} */
    const closedPromise = new Promise(resolve => {
      resolveClosed = resolve;
    });

    const stopTimers = () => {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      if (livenessTimer !== undefined) clearTimeout(livenessTimer);
      if (writeStallTimer !== undefined) clearTimeout(writeStallTimer);
      heartbeatTimer = undefined;
      livenessTimer = undefined;
      writeStallTimer = undefined;
    };

    const stopReconnecting = () => {
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      if (redialTimer !== undefined) clearTimeout(redialTimer);
      hardTimer = undefined;
      redialTimer = undefined;
      reconnectingSince = undefined;
    };

    const fireOnClose = () => {
      stopTimers();
      stopReconnecting();
      resolveClosed();
      for (const resolve of drainWaiters) resolve();
      drainWaiters = [];
      try {
        onClose();
      } catch (_e) {
        // never throw out of teardown
      }
    };

    /** @param {Instance} instance */
    const closeInstance = instance => {
      Promise.resolve(instance.stream.writer.return(undefined)).catch(() => {});
      Promise.resolve(instance.stream.reader.return(undefined)).catch(() => {});
    };

    /**
     * Tell a reconnect-capable peer that this end is deliberate, so it
     * does not take the closing stream for a lost transport instance.
     */
    /**
     * @param {Instance} instance
     * @returns {Promise<unknown>}
     */
    const sendSessionEnd = instance => {
      if (reconnectSettings === undefined) return Promise.resolve();
      try {
        const end = writeOcapnSessionControlMessage(
          { type: 'op:session-end', epoch },
          codec,
        );
        return Promise.resolve(
          instance.stream.writer.next(instance.encrypt(end)),
        ).catch(() => {});
      } catch (_e) {
        // best effort
        return Promise.resolve();
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      // Tear both directions down, after the end notice if the peer
      // expects one. We suppress any rejection here because a
      // transport's write half may have already closed.
      const instance = current;
      if (instance !== undefined) {
        void sendSessionEnd(instance).then(() => closeInstance(instance));
      }
      current = undefined;
      fireOnClose();
    };

    /** @type {Reader<Uint8Array>} */
    let reader;
    /** @type {(plainText: Uint8Array) => void} */
    let enqueueFrame = () => {};
    /** @type {Reconnector | undefined} */
    let reconnector;

    if (heartbeatSettings === undefined) {
      const { stream, decrypt } = firstInstance;
      reader = harden({
        next: async () => {
          await null;
          const result = await stream.reader.next(undefined);
          if (result.done) {
            if (!closed) {
              closed = true;
              fireOnClose();
            }
            return harden({ done: true, value: undefined });
          }
          return harden({ done: false, value: decrypt(result.value) });
        },
        return: async () => {
          await null;
          if (!closed) {
            closed = true;
            await stream.writer.return(undefined);
            fireOnClose();
          }
          return harden({ done: true, value: undefined });
        },
        throw: async err => {
          await null;
          if (!closed) {
            closed = true;
            await stream.writer.throw(err);
            fireOnClose();
          }
          throw err;
        },
        [Symbol.asyncIterator]() {
          return reader;
        },
      });
    } else {
      const { intervalMs, sessionTimeoutMs } = heartbeatSettings;

      /**
       * @typedef {{ done: true } | { done: false, value: Uint8Array } | { error: Error }} InboundItem
       */
      /** @type {AsyncQueue<InboundItem>} */
      const inbound = makeQueue();

      /**
       * End the session with an error that the reader surfaces.
       *
       * @param {Error} error
       */
      const fail = error => {
        if (closed) return;
        inbound.put(harden({ error }));
        close();
      };

      /** End the session as the peer asked, without an error. */
      const endGracefully = () => {
        if (closed) return;
        inbound.put(harden({ done: true }));
        closed = true;
        if (current !== undefined) closeInstance(current);
        current = undefined;
        fireOnClose();
      };

      /**
       * The current transport instance is gone. Without reconnect the
       * session goes with it; with reconnect the session keeps its queue
       * and waits for (or, on the dialing side, makes) a new instance.
       *
       * @param {Instance} instance
       * @param {Error | undefined} error - `undefined` when the
       *   transport ended without one.
       */
      const loseInstance = (instance, error) => {
        if (closed || instance !== current) return;
        if (reconnectSettings === undefined) {
          if (error === undefined) endGracefully();
          else fail(error);
          return;
        }
        detach(instance);
        if (reconnectingSince === undefined) {
          reconnectingSince = Date.now();
          const { hardTimeoutMs } = reconnectSettings;
          hardTimer = setTimeout(() => {
            fail(
              makeError(
                X`ocapn-noise: session aborted; not reconnected within ${q(hardTimeoutMs)}ms`,
              ),
            );
          }, hardTimeoutMs);
          backoffMs = reconnectSettings.backoffInitialMs;
        }
        // Either side redials; if both do, the crossed-hellos
        // tiebreaker keeps one of the two new transport instances.
        scheduleRedial(0);
      };

      /**
       * Drop the current instance, keeping every session frame it has
       * not been acknowledged to deliver for replay on the next one.
       *
       * @param {Instance} instance
       */
      const detach = instance => {
        current = undefined;
        stopTimers();
        closeInstance(instance);
        const pending = outbound.filter(frame => frame.index !== undefined);
        outbound = [...unacked.map(entry => entry.frame), ...pending];
        unacked = [];
        queuedHeartbeatFrames = 0;
        peerAckedRecvNonce = undefined;
      };

      let backoffMs = 0;

      /** @param {number} delayMs */
      const scheduleRedial = delayMs => {
        if (closed || redialTimer !== undefined) return;
        redialTimer = setTimeout(() => {
          redialTimer = undefined;
          void redial();
        }, delayMs);
      };

      const redial = async () => {
        await null;
        if (
          closed ||
          current !== undefined ||
          reconnectSettings === undefined
        ) {
          return;
        }
        const nextEpoch = epoch + 1n;
        /** @type {Awaited<ReturnType<Reconnector['dial']>>} */
        let dialed;
        dialing += 1;
        try {
          dialed = await /** @type {Reconnector} */ (reconnector).dial(
            nextEpoch,
            receivedFrames,
          );
        } catch (_error) {
          if (closed || current !== undefined) return;
          const delayMs = backoffMs;
          backoffMs = Math.min(backoffMs * 2, reconnectSettings.backoffMaxMs);
          scheduleRedial(delayMs);
          return;
        } finally {
          dialing -= 1;
        }
        const { instance, peerHello } = dialed;
        // The peer's dial won the crossed hellos, or the session moved past
        // this epoch while we dialed. In the second case, if that later
        // instance is gone too, dial again, backing off as after a failure
        // so that a peer that keeps overtaking us cannot spin the loop.
        if (closed || current !== undefined || epoch + 1n !== nextEpoch) {
          closeInstance(instance);
          if (!closed && current === undefined) {
            const delayMs = backoffMs;
            backoffMs = Math.min(backoffMs * 2, reconnectSettings.backoffMaxMs);
            scheduleRedial(delayMs);
          }
          return;
        }
        if (
          peerHello.epoch !== nextEpoch ||
          compareUint8Arrays(asUint8(peerHello.session), sessionToken) !== 0
        ) {
          // The peer no longer holds this session (it restarted, or gave
          // up on us): nothing on the other side can take the queue.
          closeInstance(instance);
          fail(
            makeError(
              X`ocapn-noise: session aborted; peer refused to resume epoch ${q(nextEpoch)}`,
            ),
          );
          return;
        }
        attach(instance, nextEpoch, peerHello.received);
      };

      /**
       * Continue the session on a fresh transport instance.
       *
       * @param {Instance} instance
       * @param {bigint} newEpoch
       * @param {bigint} peerReceived - Session frames the peer has
       *   delivered; queued frames before that position are dropped
       *   rather than replayed.
       */
      const attach = (instance, newEpoch, peerReceived) => {
        if (closed) {
          closeInstance(instance);
          return;
        }
        if (current !== undefined) detach(current);
        if (peerReceived > nextFrameIndex) {
          closeInstance(instance);
          fail(
            makeError(
              X`ocapn-noise: session aborted; peer claims ${q(peerReceived)} frames of ${q(nextFrameIndex)} sent`,
            ),
          );
          return;
        }
        stopReconnecting();
        outbound = outbound.filter(
          frame => frame.index !== undefined && frame.index >= peerReceived,
        );
        epoch = newEpoch;
        pingSequence = 0n;
        pongSequence = 0n;
        current = instance;
        startInstance(instance);
      };

      // Hand queued frames to the transport one at a time, in order.
      // Encrypting at hand-off keeps the Noise nonce order equal to the
      // transport order however long a frame waits in the queue.
      /** @param {Instance} instance */
      const drain = async instance => {
        await null;
        while (current === instance && outbound.length > 0) {
          const frame = outbound[0];
          // A transport write that does not complete within the session
          // timeout is loss, not a stall: the peer, hearing nothing from
          // us for as long, has given up on this transport instance too.
          writeStallTimer = setTimeout(
            () =>
              loseInstance(
                instance,
                makeError(
                  X`ocapn-noise: transport write stalled for ${q(sessionTimeoutMs)}ms; session lost`,
                ),
              ),
            sessionTimeoutMs,
          );
          const nonce = instance.sentCount;
          try {
            // eslint-disable-next-line no-await-in-loop
            await instance.stream.writer.next(instance.encrypt(frame.render()));
          } catch (error) {
            loseInstance(instance, /** @type {Error} */ (error));
            return;
          } finally {
            clearTimeout(writeStallTimer);
            writeStallTimer = undefined;
          }
          instance.sentCount += 1n;
          if (current !== instance) return;
          outbound.shift();
          if (frame.index === undefined) queuedHeartbeatFrames -= 1;
          else if (reconnectSettings !== undefined) {
            unacked.push({ frame, nonce });
          }
        }
        if (outbound.length === 0) {
          for (const resolve of drainWaiters) resolve();
          drainWaiters = [];
        }
      };

      const kickDrain = () => {
        if (current === undefined || drainingFor === current) return;
        const instance = current;
        drainingFor = instance;
        void drain(instance).finally(() => {
          if (drainingFor === instance) drainingFor = undefined;
          // Frames queued while a stale drain was unwinding.
          if (current !== undefined && outbound.length > 0) kickDrain();
        });
      };

      /** @param {OutboundFrame} frame */
      const enqueue = frame => {
        if (closed) return;
        outbound.push(frame);
        if (frame.index === undefined) queuedHeartbeatFrames += 1;
        kickDrain();
      };

      enqueueFrame = plainText => {
        // The caller may reuse its buffer once the write resolves, and
        // the frame can wait in the queue past that.
        const copy = plainText.slice();
        const index = nextFrameIndex;
        nextFrameIndex += 1n;
        enqueue({ index, render: () => copy });
      };

      const sendHeartbeat = () => {
        const instance = current;
        if (instance === undefined) return;
        // While the transport is stalled, heartbeats already waiting in
        // the queue carry all the liveness a fresh pair would, so do
        // not let a stall pile them up.
        if (queuedHeartbeatFrames > 0) return;
        const ping = pingSequence;
        pingSequence += 1n;
        const pingEpoch = epoch;
        enqueue({
          index: undefined,
          render: () =>
            writeOcapnHeartbeatMessage(
              { type: 'op:ping', epoch: pingEpoch, sequence: ping },
              codec,
            ),
        });
        const pong = pongSequence;
        pongSequence += 1n;
        enqueue({
          index: undefined,
          // Rendered at hand-off, so the acknowledgement is current
          // even when the frame waited out a stall.
          render: () =>
            writeOcapnHeartbeatMessage(
              {
                type: 'op:pong',
                epoch: pingEpoch,
                sequence: pong,
                lastAckedRecvNonce: instance.getReceivedCount() - 1n,
              },
              codec,
            ),
        });
      };

      /**
       * Absorb a heartbeat or session-control operation, reporting
       * whether the frame was one. Any other frame belongs to the
       * session above.
       *
       * @param {Uint8Array} plainText
       * @returns {boolean}
       */
      const absorbControl = plainText => {
        /** @type {{ type: string, epoch: bigint, lastAckedRecvNonce?: bigint }} */
        let message;
        try {
          const peekReader = codec.makeReader(plainText);
          if (peekReader.peekTypeHint() !== 'record') return false;
          peekReader.enterRecord();
          const label = peekReader.readRecordLabel();
          if (label.type === 'bytestring') return false;
          const messageReader = codec.makeReader(plainText);
          if (label.value === 'op:ping' || label.value === 'op:pong') {
            message = readOcapnHeartbeatMessage(messageReader);
          } else if (
            reconnectSettings !== undefined &&
            (label.value === 'op:session-end' ||
              label.value === 'op:session-hello')
          ) {
            message = readOcapnSessionControlMessage(messageReader);
          } else {
            return false;
          }
          if (messageReader.index !== plainText.length) return false;
        } catch (_error) {
          return false;
        }
        // A control frame from an earlier epoch is a straggler from an
        // obsolete transport instance: dropped without effect.
        if (message.epoch < epoch) return true;
        if (message.type === 'op:session-end') {
          endGracefully();
          return true;
        }
        const { lastAckedRecvNonce } = message;
        if (
          lastAckedRecvNonce !== undefined &&
          (peerAckedRecvNonce === undefined ||
            lastAckedRecvNonce > peerAckedRecvNonce)
        ) {
          peerAckedRecvNonce = lastAckedRecvNonce;
          // The peer has these session frames; they need no replay.
          const acked = lastAckedRecvNonce;
          unacked = unacked.filter(entry => entry.nonce > acked);
        }
        return true;
      };

      /** @param {Instance} instance */
      const resetLivenessTimer = instance => {
        if (closed || instance !== current) return;
        if (livenessTimer !== undefined) clearTimeout(livenessTimer);
        livenessTimer = setTimeout(
          () =>
            loseInstance(
              instance,
              makeError(
                X`ocapn-noise: no traffic from peer for ${q(sessionTimeoutMs)}ms; session lost`,
              ),
            ),
          sessionTimeoutMs,
        );
      };

      // Read the transport eagerly rather than at the consumer's pace,
      // so that a consumer that is slow to call `next` cannot starve
      // the liveness timer of the traffic that resets it.
      /** @param {Instance} instance */
      const pump = async instance => {
        await null;
        for (;;) {
          /** @type {IteratorResult<Uint8Array>} */
          let result;
          /** @type {Uint8Array} */
          let plainText;
          try {
            // eslint-disable-next-line no-await-in-loop
            result = await instance.stream.reader.next(undefined);
            // Frames that straggle in after the instance was given up
            // are not ours to deliver: the reconnect told the peer how
            // many we took, and it replays the rest.
            if (instance !== current) return;
            if (result.done) {
              loseInstance(instance, undefined);
              return;
            }
            plainText = instance.decrypt(result.value);
          } catch (error) {
            loseInstance(instance, /** @type {Error} */ (error));
            return;
          }
          resetLivenessTimer(instance);
          if (!absorbControl(plainText)) {
            receivedFrames += 1n;
            inbound.put(harden({ done: false, value: plainText }));
          }
        }
      };

      /** @param {Instance} instance */
      const startInstance = instance => {
        resetLivenessTimer(instance);
        heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
        void pump(instance);
        kickDrain();
      };

      reader = harden({
        next: async () => {
          await null;
          const item = await inbound.get();
          if ('error' in item || item.done) {
            // Leave the terminal state for any later or concurrent read.
            inbound.put(harden({ done: true }));
          }
          if ('error' in item) throw item.error;
          if (item.done) return harden({ done: true, value: undefined });
          return harden({ done: false, value: item.value });
        },
        return: async () => {
          await null;
          close();
          return harden({ done: true, value: undefined });
        },
        throw: async err => {
          await null;
          close();
          throw err;
        },
        [Symbol.asyncIterator]() {
          return reader;
        },
      });

      if (reconnectSettings !== undefined) {
        reconnector = {
          sessionToken,
          getEpoch: () => epoch,
          isAttached: () => current !== undefined,
          prefersOwnDial: () => dialing > 0 && winsCrossedHellos,
          getReceivedFrames: () => receivedFrames,
          attach,
          abort: fail,
          // Installed by the network once the session is registered.
          dial: async () => {
            throw makeError(X`ocapn-noise: reconnect dial not installed`);
          },
        };
      }

      startInstance(firstInstance);
    }

    /** @type {Writer<Uint8Array>} */
    const writer = harden({
      next: async value => {
        await null;
        if (closed) return harden({ done: true, value: undefined });
        if (heartbeatSettings !== undefined) {
          // Fail fast in the last stretch of the reconnect budget rather
          // than accept a frame that will only be rejected with the
          // session (designs/ocapn-noise-session-reconnect.md § 5).
          if (
            reconnectSettings !== undefined &&
            reconnectingSince !== undefined &&
            Date.now() - reconnectingSince >
              reconnectSettings.hardTimeoutMs - reconnectSettings.backoffMaxMs
          ) {
            throw makeError(
              X`ocapn-noise: session is about to abort; not reconnected`,
            );
          }
          // The session queue owns the frame from here; a transport
          // stall delays it but does not block the caller.
          enqueueFrame(value);
          return harden({ done: false, value: undefined });
        }
        await firstInstance.stream.writer.next(firstInstance.encrypt(value));
        return harden({ done: false, value: undefined });
      },
      return: async () => {
        await null;
        // Deliver what the session already accepted before ending the
        // stream, unless the session is lost first.
        if (heartbeatSettings !== undefined && outbound.length > 0) {
          await Promise.race([
            new Promise(resolve => drainWaiters.push(() => resolve(undefined))),
            closedPromise,
          ]);
        }
        close();
        return harden({ done: true, value: undefined });
      },
      throw: async err => {
        await null;
        close();
        throw err;
      },
      [Symbol.asyncIterator]() {
        return writer;
      },
    });

    const peerEd25519Buffer = peerEd25519.slice();
    const sessionId = makeSessionId(
      localKey.keyPair.publicKey.id,
      cryptography.makeOcapnPublicKey(peerEd25519Buffer).id,
    );

    const session = harden({
      sessionId,
      selfIdentity: {
        location,
        locationSignature,
        keyPair: localKey.keyPair,
        keyId: localKey.keyId,
      },
      remoteLocation: peerLocation,
      remoteLocationSignature: peerLocationSignature,
      remotePublicKeyBytes: peerEd25519Buffer,
      isInitiator,
      reader,
      writer,
      getLiveness: () =>
        harden({
          heartbeat: heartbeatSettings !== undefined,
          reconnect: reconnectSettings !== undefined,
          reconnecting: !closed && current === undefined,
          epoch,
          lastAckedRecvNonce:
            current === undefined ? undefined : current.getReceivedCount() - 1n,
          peerAckedRecvNonce,
          lastSentNonce:
            heartbeatSettings === undefined || current === undefined
              ? undefined
              : current.sentCount - 1n,
          queuedFrames: outbound.length,
          unackedFrames: unacked.length,
        }),
      close,
    });
    return { session, reconnector };
  };

  /**
   * Extract the initiator's x25519 ephemeral public key from the
   * prefixed SYN. Bytes 0-31 are the intended responder's long-term
   * Ed25519 key; bytes 32-63 are the initiator's per-session x25519
   * ephemeral. The ephemeral is the crossed-hello tiebreaker.
   *
   * @param {Uint8Array} prefixedSyn
   */
  const tiebreakerFromPrefixedSyn = prefixedSyn => prefixedSyn.slice(32, 64);

  /**
   * Run the initiator side of one Noise IK handshake, the identity
   * exchange, and the `op:session-hello` exchange on a fresh transport
   * instance. Used both to open a session and to reconnect one.
   *
   * @param {RegisteredKey} localKey
   * @param {OcapnLocation} location
   * @param {Uint8Array} peerEd25519
   * @param {(handshakeHash: Uint8Array) => { epoch: bigint, session: Uint8Array, received: bigint }} makeHello
   */
  const dialHandshake = async (localKey, location, peerEd25519, makeHello) => {
    const { transport, hints } = selectOutgoingTransport(location);

    // Build the SYN before dialing: `initiatorWriteSyn` rejects a weak or
    // malformed responder key, and a locator carrying one must not cause
    // an outbound connection to the hints it names.
    const noise = makeOcapnSessionCryptography({
      wasmModule,
      getRandomValues,
      signingKeys: {
        privateKey: localKey.privateKey,
        publicKey: localKey.publicKey,
      },
    });
    const asInit = noise.asInitiator();
    const prefixedSyn = new Uint8Array(PREFIXED_SYN_LENGTH);
    const { initiatorReadSynack } = asInit.initiatorWriteSyn(
      peerEd25519,
      prefixedSyn,
    );
    const tiebreaker = tiebreakerFromPrefixedSyn(prefixedSyn);

    const stream = await transport.connect(hints);
    try {
      await stream.writer.next(prefixedSyn);

      const synack = await withTimeout(
        readFrame(stream.reader),
        handshakeTimeoutMs,
        'SYNACK read',
        stream,
      );
      expectFrameLength(synack, SYNACK_LENGTH, 'SYNACK');
      // IK has no message 3 (ACK); reading the SYNACK finalizes the
      // handshake and exposes the transcript hash for channel binding.
      const { encrypt, handshakeHash, ...cipher } = initiatorReadSynack(synack);
      const nonces = countReceivedNonces(cipher.decrypt);
      const { decrypt } = nonces;

      const { identity, peerHello } = await withTimeout(
        (async () => {
          const exchanged = await exchangeIdentity(
            localKey,
            stream.reader,
            stream.writer,
            encrypt,
            decrypt,
            peerEd25519,
            handshakeHash,
          );
          await writeSessionHello(
            stream.writer,
            encrypt,
            makeHello(asUint8(handshakeHash)),
          );
          const hello = await readSessionHello(stream.reader, decrypt);
          return { identity: exchanged, peerHello: hello };
        })(),
        handshakeTimeoutMs,
        'post-handshake identity exchange',
        stream,
      );

      /** @type {Instance} */
      const instance = {
        stream,
        encrypt,
        decrypt,
        getReceivedCount: nonces.getReceivedCount,
        // The identity greeting and the session hello took send nonces
        // 0 and 1.
        sentCount: 2n,
      };
      return {
        instance,
        identity,
        peerHello,
        tiebreaker,
        localEphemeral: tiebreaker,
        // The SYNACK opens with the responder's x25519 ephemeral.
        peerEphemeral: synack.slice(0, 32),
        handshakeHash: asUint8(handshakeHash),
      };
    } catch (err) {
      // The handshake didn't graduate; close both halves of the
      // transport so the kernel doesn't sit on a half-open socket
      // until OS keepalive fires.
      try {
        await stream.writer.return(undefined);
      } catch (_e) {
        // ignore
      }
      try {
        await stream.reader.return(undefined);
      } catch (_e) {
        // ignore
      }
      throw err;
    }
  };

  /**
   * Build a session on an instance whose handshake just finished, and
   * register it for reconnect if both sides negotiated that.
   *
   * @param {object} params
   * @param {KeyIdHex} params.peerId
   * @param {RegisteredKey} params.localKey
   * @param {Uint8Array} params.peerEd25519
   * @param {boolean} params.isInitiator
   * @param {Instance} params.instance
   * @param {Awaited<ReturnType<typeof exchangeIdentity>>} params.identity
   * @param {SessionHello} params.peerHello
   * @param {Uint8Array} params.tiebreaker
   * @param {Uint8Array} params.localEphemeral
   * @param {Uint8Array} params.peerEphemeral
   * @param {Uint8Array} params.handshakeHash
   * @returns {Candidate}
   */
  const makeCandidate = ({
    peerId,
    localKey,
    peerEd25519,
    isInitiator,
    instance,
    identity,
    peerHello,
    tiebreaker,
    localEphemeral,
    peerEphemeral,
    handshakeHash,
  }) => {
    /** @type {Candidate | undefined} */
    let candidate;
    /** @type {Reconnector | undefined} */
    let reconnector;
    const built = buildSession({
      localKey,
      location: identity.location,
      locationSignature: identity.locationSignature,
      peerLocation: identity.peerLocation,
      peerLocationSignature: identity.peerLocationSignature,
      peerEd25519,
      isInitiator,
      instance,
      sessionToken: handshakeHash,
      localEphemeral,
      peerEphemeral,
      peerFeatures: peerHello.features,
      onClose: () => {
        if (reconnector && reconnectors.get(peerId) === reconnector) {
          reconnectors.delete(peerId);
        }
        if (candidate) forgetActive(peerId, candidate);
      },
    });
    const { session } = built;
    reconnector = built.reconnector;
    if (reconnector) {
      const { sessionToken } = reconnector;
      reconnector.dial = async (epoch, received) => {
        const dialed = await dialHandshake(
          localKey,
          identity.peerLocation,
          peerEd25519,
          () => ({ epoch, session: sessionToken, received }),
        );
        return { instance: dialed.instance, peerHello: dialed.peerHello };
      };
    }
    candidate = {
      session,
      tiebreaker,
      reconnector,
      close: () => session.close(),
    };
    return candidate;
  };

  /**
   * Drive the initiator side of a single handshake. Does not wait for
   * crossed-hello settlement; the caller is expected to register and
   * settle via the outer state machine.
   *
   * @param {RegisteredKey} localKey
   * @param {OcapnLocation} location
   * @param {Uint8Array} peerEd25519
   * @returns {Promise<Candidate>}
   */
  const runInitiator = async (localKey, location, peerEd25519) => {
    const peerId = toHex(peerEd25519);
    const dialed = await dialHandshake(
      localKey,
      location,
      peerEd25519,
      handshakeHash => ({ epoch: 0n, session: handshakeHash, received: 0n }),
    );
    if (!opensSession(dialed.peerHello, dialed.handshakeHash)) {
      Promise.resolve(dialed.instance.stream.writer.return(undefined)).catch(
        () => {},
      );
      throw makeError(X`ocapn-noise: peer did not open a fresh session`);
    }
    return makeCandidate({
      peerId,
      localKey,
      peerEd25519,
      isInitiator: true,
      ...dialed,
    });
  };

  /**
   * @param {ByteStream} stream
   */
  const handleIncoming = async stream => {
    await null;
    /** @type {KeyIdHex | undefined} */
    let registeredPeerId;
    /** @type {(() => void) | undefined} */
    let releaseInbound;
    /** @type {(reason: Error) => void} */
    let rejectEvicted = () => {};
    /** @type {Promise<never>} */
    const evicted = new Promise((_resolve, reject) => {
      rejectEvicted = reject;
    });
    evicted.catch(() => {});
    try {
      const prefixedSyn = await withTimeout(
        readFrame(stream.reader),
        handshakeTimeoutMs,
        'SYN read',
        stream,
      );
      expectFrameLength(prefixedSyn, PREFIXED_SYN_LENGTH, 'SYN');
      const intendedKeyId = toHex(prefixedSyn.subarray(0, 32));
      const localKey = registeredKeys.get(intendedKeyId);
      if (!localKey) {
        await stream.writer.return(undefined);
        return;
      }

      // Pre-authentication DoS bound. Cap concurrent inbound handshakes
      // per local identity before paying for any Noise IK SYN-decrypt
      // (the per-handshake cost includes a `WebAssembly.Instance`
      // construction and a Diffie-Hellman). This is keyed on our own
      // identity, never the claimed peer: the peer's verifying key is
      // both encrypted and replayable, so it cannot bound anything
      // before `exchangeIdentity`. A full budget evicts its oldest
      // unproven handshake (closing its stream and failing its pending
      // `exchangeIdentity`) rather than refusing this one. The slot is
      // released in `finally`.
      releaseInbound = admitInbound(intendedKeyId, () => {
        rejectEvicted(
          Error('ocapn-noise: evicted by newer inbound handshakes'),
        );
        Promise.resolve(stream.writer.return(undefined)).catch(() => {});
        Promise.resolve(stream.reader.return(undefined)).catch(() => {});
      });

      const noise = makeOcapnSessionCryptography({
        wasmModule,
        getRandomValues,
        signingKeys: {
          privateKey: localKey.privateKey,
          publicKey: localKey.publicKey,
        },
      });
      const asResp = noise.asResponder();
      const synack = new Uint8Array(SYNACK_LENGTH);
      // IK msg 1 (read) + msg 2 (write) finalize the handshake in
      // one bindings call.  No further wire message is required.
      // The bindings reject a SYN whose claimed `initiatorVerifyingKey`
      // does not match the static key Noise authenticated, so an
      // initiator cannot claim a key it does not hold.
      const { initiatorVerifyingKey, encrypt, handshakeHash, ...cipher } =
        asResp.responderReadSynWriteSynack(prefixedSyn, synack);
      const nonces = countReceivedNonces(cipher.decrypt);
      const { decrypt } = nonces;
      const initiatorKeyHex = toHex(initiatorVerifyingKey);

      // Late crossed hello against an ADOPTED session: refuse before we
      // answer. `decrementAndSettle` never displaces an adopted session,
      // so finishing this handshake would mint a session we immediately
      // close — and the peer may have adopted it by then, tearing it out
      // from under their CapTP layer (the two sides can even close each
      // other's adopted sessions mutually). Refuse before SYNACK so the
      // peer's dial fails fast and its own settlement converges on the
      // session both sides already share. A replayed SYN that lands here
      // is simply refused, which is harmless. An UNCLAIMED session
      // (still in `pendingInbound`) is deliberately left alone here and
      // handled after `exchangeIdentity`, so a replay cannot displace it.
      //
      // A session that resumes after loss is the exception: the peer may
      // be dialing to continue it, which only its `op:session-hello`
      // (after `exchangeIdentity`) can tell.
      const resumable = reconnectors.get(initiatorKeyHex);
      const adopted = active.get(initiatorKeyHex);
      if (
        !resumable &&
        adopted &&
        pendingInbound.indexOf(adopted.session) === -1
      ) {
        await stream.writer.return(undefined);
        return;
      }

      // Register this inbound against the peer now, before we answer, so
      // a concurrent outbound `provideSession` to the same peer waits for
      // it in `decrementAndSettle` and both directions run the
      // crossed-hello tiebreaker over the same pair of ephemerals.
      // Without this, the two sides can each settle on their own outbound
      // and then mutually close the other's session ("Session
      // disconnected"). A replayed SYN reaches here too and holds this
      // slot until it times out, but `settleDeadlines` caps how long the
      // peer's settlement waits on it, and it cannot displace the peer's
      // existing session (deferred to after `exchangeIdentity`).
      // The count is released in the `catch` or in `decrementAndSettle`.
      if (!resumable) {
        registeredPeerId = initiatorKeyHex;
        bumpInProgress(initiatorKeyHex);
      }
      const tiebreaker = tiebreakerFromPrefixedSyn(prefixedSyn);
      await Promise.race([
        withTimeout(
          stream.writer.next(synack),
          handshakeTimeoutMs,
          'SYNACK write',
          stream,
        ),
        evicted,
      ]);

      const { identity, peerHello } = await Promise.race([
        withTimeout(
          (async () => {
            const exchanged = await exchangeIdentity(
              localKey,
              stream.reader,
              stream.writer,
              encrypt,
              decrypt,
              initiatorVerifyingKey,
              handshakeHash,
            );
            const hello = await readSessionHello(stream.reader, decrypt);
            return { identity: exchanged, peerHello: hello };
          })(),
          handshakeTimeoutMs,
          'post-handshake identity exchange',
          stream,
        ),
        evicted,
      ]);
      /** @type {Instance} */
      const instance = {
        stream,
        encrypt,
        decrypt,
        getReceivedCount: nonces.getReceivedCount,
        // The identity greeting and the session hello take send nonces
        // 0 and 1.
        sentCount: 2n,
      };

      if (resumable) {
        if (peerHello.epoch > 0n) {
          // A reconnect. A hello that names another session (a replay
          // into the wrong session) is answered with a refusal, which
          // tells the dialer this side does not hold what it asks to
          // resume.
          const known =
            reconnectors.get(initiatorKeyHex) === resumable &&
            compareUint8Arrays(peerHello.session, resumable.sessionToken) === 0;
          if (!known) {
            await writeSessionHello(stream.writer, encrypt, {
              epoch: 0n,
              session: asUint8(handshakeHash),
              received: 0n,
            });
            await stream.writer.return(undefined);
            return;
          }
          // Close the dial without an answer, which the dialer takes as an
          // ordinary failed attempt. A later epoch is taken as is, so a
          // dialer that missed our answer to an earlier reconnect still
          // converges. The epoch only orders dials; the session token and
          // the handshake-authenticated initiator key checked above
          // authorize the resume, so a peer that jumps the epoch far
          // ahead can stall only the session it authenticated into.
          if (
            peerHello.epoch <= resumable.getEpoch() ||
            resumable.prefersOwnDial()
          ) {
            await stream.writer.return(undefined);
            return;
          }
          await writeSessionHello(stream.writer, encrypt, {
            epoch: peerHello.epoch,
            session: resumable.sessionToken,
            received: resumable.getReceivedFrames(),
          });
          resumable.attach(instance, peerHello.epoch, peerHello.received);
          return;
        }
        if (resumable.isAttached()) {
          // A fresh session from a peer we still hear from on the
          // session we share: a late crossed hello. Refuse it, as for
          // an adopted session above.
          await stream.writer.return(undefined);
          return;
        }
        // A fresh session from a peer whose session with us is waiting
        // to resume: the peer has lost that session (it restarted), so
        // nothing will ever resume it.
        resumable.abort(
          makeError(
            X`ocapn-noise: session aborted; peer opened a new session instead of resuming`,
          ),
        );
        registeredPeerId = initiatorKeyHex;
        bumpInProgress(initiatorKeyHex);
      }
      if (!opensSession(peerHello, handshakeHash)) {
        if (peerHello.epoch > 0n) {
          // A reconnect of a session this side no longer holds: refuse
          // it so the dialer aborts at once rather than retry until its
          // hard timeout.
          await writeSessionHello(stream.writer, encrypt, {
            epoch: 0n,
            session: asUint8(handshakeHash),
            received: 0n,
          });
        }
        throw makeError(
          X`ocapn-noise: op:session-hello does not open a fresh session`,
        );
      }
      await writeSessionHello(stream.writer, encrypt, {
        epoch: 0n,
        session: asUint8(handshakeHash),
        received: 0n,
      });

      // The peer is now proven live under `initiatorKeyHex`. Displacing a
      // stale UNCLAIMED session for this peer (a reconnect whose old
      // session still sits unconsumed in `pendingInbound`) is deferred to
      // here so a replayed SYN — which never completes `exchangeIdentity`
      // — can never close it. The early `bumpInProgress` above keeps
      // `inProgress` >= 1 for this peer until our own `decrementAndSettle`
      // below. A settlement deadline may still have promoted another
      // proven handshake meanwhile; if that one is unclaimed, this newer
      // proven session supersedes it exactly as a reconnect would.
      const unclaimed = active.get(initiatorKeyHex);
      if (unclaimed) {
        const pendingIndex = pendingInbound.indexOf(unclaimed.session);
        if (pendingIndex !== -1) {
          pendingInbound.splice(pendingIndex, 1);
          // `close` fires the session's onClose, which forgets the
          // active entry; the copy already queued on `inboundSessions`
          // surfaces as a dead session, exactly as the
          // MAX_PENDING_INBOUND_SESSIONS overflow path leaves one.
          unclaimed.close();
        }
      }

      const candidate = makeCandidate({
        peerId: initiatorKeyHex,
        localKey,
        peerEd25519: initiatorVerifyingKey,
        isInitiator: false,
        instance,
        identity,
        peerHello,
        tiebreaker,
        localEphemeral: synack.slice(0, 32),
        peerEphemeral: tiebreaker,
        handshakeHash: asUint8(handshakeHash),
      });

      recordCandidate(initiatorKeyHex, candidate);
      // `decrementAndSettle` decrements before anything in it can throw,
      // so the `catch` below must not decrement a second time.
      registeredPeerId = undefined;
      decrementAndSettle(initiatorKeyHex);
    } catch (err) {
      if (registeredPeerId) {
        recordError(registeredPeerId, /** @type {Error} */ (err));
        decrementAndSettle(registeredPeerId);
      }
      try {
        await stream.writer.return(undefined);
      } catch (_e) {
        // ignore
      }
      try {
        await stream.reader.return(undefined);
      } catch (_e) {
        // ignore
      }
    } finally {
      if (releaseInbound) releaseInbound();
    }
  };

  /** @type {OcapnNoiseNetwork['generateSigningKeys']} */
  const generateSigningKeys = () => {
    // Mint fresh 32-byte entropy and derive the Ed25519 public key
    // with the same cryptography helper the rest of the package uses.
    // Avoids spinning up a whole Noise WASM instance whose only
    // side-effect we want is the keypair.
    const privateKey = new Uint8Array(32);
    getRandomValues(privateKey);
    const keyPair = cryptography.makeOcapnKeyPairFromPrivateKey(privateKey);
    const publicKey = new Uint8Array(asUint8(keyPair.publicKey.bytes));
    return { privateKey, publicKey };
  };

  /** @type {OcapnNoiseNetwork['addSigningKeys']} */
  const addSigningKeys = ({ privateKey, publicKey }) => {
    if (privateKey.length !== 32) {
      throw makeError(X`ocapn-noise: privateKey must be 32 bytes`);
    }
    if (publicKey && publicKey.length !== 32) {
      throw makeError(X`ocapn-noise: publicKey must be 32 bytes when supplied`);
    }
    // Always derive the verifying key from the private key so the
    // `keyId` and the bytes handed to the Noise WASM agree. If the
    // caller supplied a public key, assert it matches what we derive
    // (silent disagreement here would let a peer be addressable
    // under one keyId but unable to complete a handshake as that
    // identity, which is a debugging cliff to fall off).
    const keyPair = cryptography.makeOcapnKeyPairFromPrivateKey(privateKey);
    const derivedPublicKey = new Uint8Array(asUint8(keyPair.publicKey.bytes));
    if (publicKey) {
      if (compareUint8Arrays(publicKey, derivedPublicKey) !== 0) {
        throw makeError(
          X`ocapn-noise: supplied publicKey does not match privateKey`,
        );
      }
    }
    const keyId = toHex(derivedPublicKey);
    if (registeredKeys.has(keyId)) return keyId;
    registeredKeys.set(
      keyId,
      harden({
        keyId,
        privateKey,
        publicKey: derivedPublicKey,
        keyPair,
      }),
    );
    return keyId;
  };

  /** @type {OcapnNoiseNetwork['removeSigningKeys']} */
  const removeSigningKeys = keyId => {
    registeredKeys.delete(keyId);
  };

  /** @type {OcapnNoiseNetwork['addTransport']} */
  const addTransport = async transport => {
    await null;
    if (registeredTransports.has(transport)) return;
    // Refuse a second transport with the same scheme: outgoing
    // dial selection iterates `registeredTransports` and returns the
    // first hint match, so a second `tcp` transport would be
    // silently shadowed; aggregated hints would also silently
    // overwrite each other.
    for (const t of registeredTransports) {
      if (t.scheme === transport.scheme) {
        throw makeError(
          X`ocapn-noise: a transport with scheme ${q(transport.scheme)} is already registered`,
        );
      }
    }
    if (transport.listen) {
      // Call `listen` first so a failure can't leave a half-registered
      // transport behind; only add to the set once the listener is
      // live.
      const listener = await transport.listen(stream => handleIncoming(stream));
      registeredTransports.add(transport);
      listenersByTransport.set(transport, listener);
    } else {
      registeredTransports.add(transport);
    }
  };

  /** @type {OcapnNoiseNetwork['removeTransport']} */
  const removeTransport = transport => {
    const listener = listenersByTransport.get(transport);
    if (listener) {
      listener.close();
      listenersByTransport.delete(transport);
    }
    registeredTransports.delete(transport);
  };

  /** @type {OcapnNoiseNetwork['locations']} */
  const locations = () =>
    [...registeredKeys.values()].map(rk => buildLocationFor(rk));

  /** @type {OcapnNoiseNetwork['locationFor']} */
  const locationFor = keyId => {
    const rk = registeredKeys.get(keyId);
    if (!rk) throw makeError(X`ocapn-noise: unknown keyId ${q(keyId)}`);
    return buildLocationFor(rk);
  };

  /**
   * @type {OcapnNoiseNetwork['provideSession']}
   * @param {OcapnLocation} remote
   * @param {{ localKeyId?: KeyIdHex }} [options]
   */
  const provideSession = async (remote, { localKeyId } = {}) => {
    if (registeredKeys.size === 0) {
      throw makeError(
        X`ocapn-noise: provideSession requires at least one signing key`,
      );
    }
    if (localKeyId === undefined && registeredKeys.size > 1) {
      throw makeError(
        X`ocapn-noise: provideSession requires \`localKeyId\` when ${q(registeredKeys.size)} keys are registered (pass \`{ localKeyId: '<64-hex>' }\`)`,
      );
    }
    const rk = localKeyId
      ? registeredKeys.get(localKeyId)
      : registeredKeys.values().next().value;
    if (!rk) {
      throw makeError(X`ocapn-noise: unknown local keyId ${q(localKeyId)}`);
    }
    const peerId = assertCanonicalKeyId(remote.designator);
    const peerEd25519 = hexToBytes(peerId);

    // If we already have an active session for this peer, reuse it
    // even if a stray inbound handshake is currently in flight: the
    // settlement code routes that handshake to the loser path and
    // resolves any waiters with the live session. Spawning another
    // outbound dial would just produce a second candidate that the
    // same code path will close.
    //
    // The cached session must have been established under the same
    // local identity the caller asked for. Returning a session whose
    // `selfIdentity.keyId` differs would silently swap the caller's
    // identity. Reject loudly so the caller knows the active map is
    // keyed by peer alone and they are competing with another local
    // identity for the same peer.
    const existing = active.get(peerId);
    if (existing) {
      if (existing.session.selfIdentity.keyId !== rk.keyId) {
        throw makeError(
          X`ocapn-noise: peer ${q(peerId)} already has an active session under local keyId ${q(existing.session.selfIdentity.keyId)}; cannot open a second session under ${q(rk.keyId)} (the active map is keyed by peer)`,
        );
      }
      return existing.session;
    }

    // Register our handshake, kick it off in the background, and
    // wait for settlement: either our own handshake graduates, or a
    // concurrent inbound handshake (crossed hello) wins.
    bumpInProgress(peerId);
    outboundInFlight.set(peerId, (outboundInFlight.get(peerId) ?? 0) + 1);
    const outboundDone = () => {
      const left = (outboundInFlight.get(peerId) ?? 0) - 1;
      if (left > 0) outboundInFlight.set(peerId, left);
      else outboundInFlight.delete(peerId);
    };
    // Two-argument `then`: a throw while settling a successful handshake
    // must not reach the failure handler and decrement a second time.
    runInitiator(rk, remote, peerEd25519)
      .then(
        candidate => {
          outboundDone();
          recordCandidate(peerId, candidate);
          decrementAndSettle(peerId);
        },
        err => {
          outboundDone();
          recordError(peerId, /** @type {Error} */ (err));
          decrementAndSettle(peerId);
        },
      )
      // Settlement can only throw from a candidate's teardown, which this
      // module treats as best-effort everywhere else.
      .catch(() => {});
    return awaitActiveSession(peerId);
  };

  /** @type {OcapnNoiseNetwork['waitForInboundSession']} */
  const waitForInboundSession = rawPeerKeyId => {
    // Validate/canonicalize like `provideSession`: this keys `active` and
    // `waiters`, so a non-canonical argument would park a waiter that
    // never resolves and grow the map. Surface the failure as a rejection
    // (not a synchronous throw) so this method's contract matches
    // `provideSession`'s: always Promise-returning.
    let peerKeyId;
    try {
      peerKeyId = assertCanonicalKeyId(rawPeerKeyId);
    } catch (err) {
      return Promise.reject(err);
    }
    const existing = active.get(peerKeyId);
    if (existing) return Promise.resolve(existing.session);
    return awaitActiveSession(peerKeyId);
  };

  const shutdown = () => {
    // Idempotent: a second call (often from a `t.teardown` overlapping
    // an explicit test-body `shutdown()`) is a no-op rather than
    // putting a second `done: true` on `inboundQueue` and rebumping
    // any already-released listener.
    if (isShutdown) return;
    // Set the flag first so any `runInitiator` or `handleIncoming`
    // that resolves while we are tearing down sees the network is
    // shutting down and closes its candidate rather than writing it
    // into a now-empty `active` map.
    isShutdown = true;
    // Reject any still-waiting provideSession callers first so their
    // promises settle before we tear down transports beneath them.
    const shutdownReason = Error('ocapn-noise: network shutdown');
    for (const [, queue] of waiters) {
      for (const { reject } of queue) reject(shutdownReason);
    }
    waiters.clear();
    inProgress.clear();
    for (const [, deadline] of settleDeadlines) clearTimeout(deadline);
    settleDeadlines.clear();
    outboundInFlight.clear();
    inFlightByLocalKey.clear();
    // Close any candidates that recorded themselves between
    // `runInitiator` resolution and `decrementAndSettle`. After this
    // sweep, future `recordCandidate` calls short-circuit on
    // `isShutdown` and close their candidate inline.
    for (const [, list] of candidates) {
      // Copy first: each close drops the candidate from `list` via
      // `forgetActive`, which would otherwise skip the next one.
      for (const c of [...list]) c.close();
    }
    candidates.clear();
    recentErrors.clear();
    for (const [, c] of active) c.close();
    active.clear();
    reconnectors.clear();
    // Close any sessions queued for `inboundSessions` that nobody
    // ever consumed. Without this they hold their underlying socket
    // and WASM cipher state until the process exits.
    while (pendingInbound.length > 0) {
      const s = pendingInbound.shift();
      if (s) s.close();
    }
    for (const [, listener] of listenersByTransport) listener.close();
    listenersByTransport.clear();
    for (const transport of registeredTransports) transport.shutdown();
    registeredTransports.clear();
    registeredKeys.clear();
    inboundClosed = true;
    inboundQueue.put(harden({ done: true, value: undefined }));
  };

  /** @type {AsyncIterable<OcapnNoiseSession>} */
  const inboundSessions = harden({
    [Symbol.asyncIterator]() {
      return harden({
        next: async () => {
          const result = await inboundQueue.get();
          if (!result.done) {
            // The session has been handed off to the consumer; drop
            // our tracking entry so it can no longer be evicted by
            // the drop-oldest cap.
            const idx = pendingInbound.indexOf(result.value);
            if (idx !== -1) pendingInbound.splice(idx, 1);
          }
          return result;
        },
        async return() {
          // Stop accepting further inbound sessions and close any
          // queued ones the consumer never pulled. This is the only
          // signal we have that the embedder no longer wants the
          // stream; without it, sessions accumulated in
          // `pendingInbound` would pin sockets indefinitely.
          inboundClosed = true;
          while (pendingInbound.length > 0) {
            const s = pendingInbound.shift();
            if (s) s.close();
          }
          return harden({ done: true, value: undefined });
        },
        async throw(err) {
          inboundClosed = true;
          while (pendingInbound.length > 0) {
            const s = pendingInbound.shift();
            if (s) s.close();
          }
          throw err;
        },
      });
    },
  });

  return harden({
    networkId: 'np',
    codec,
    inboundSessions,
    generateSigningKeys,
    addSigningKeys,
    removeSigningKeys,
    listSigningKeys: () => [...registeredKeys.keys()],
    addTransport,
    removeTransport,
    listTransports: () => [...registeredTransports],
    locations,
    locationFor,
    provideSession,
    waitForInboundSession,
    shutdown,
  });
};
