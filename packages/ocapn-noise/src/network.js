// @ts-check
/* global setTimeout, clearTimeout, setInterval, clearInterval */

/** @import { HeartbeatOptions } from './types.js' */

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
  writeOcapnHandshakeMessage,
  writeOcapnHeartbeatMessage,
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

// Writer frames a heartbeat session queues before `writer.next` waits
// for the transport to take some, so a stalled or slow transport pushes
// back on the writer instead of growing the queue without bound. The
// bound holds for concurrent writers too, because a writer checks for
// room before it enqueues. Heartbeats coalesce to at most one queued
// ping/pong pair, so the queue never holds more than this plus two.
const OUTBOUND_HIGH_WATER_FRAMES = 64;

// The longest plaintext Noise `encrypt` accepts: Noise §3 caps a
// message at 65535 bytes, less the 16-byte AEAD tag.
const MAX_FRAME_PLAINTEXT_LENGTH = 65_535 - 16;

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

/**
 * Count the transport-phase messages the sending Noise CipherState has
 * encrypted. Each successful `encrypt` consumes exactly one nonce, so
 * the count minus one is the highest send nonce.
 *
 * @param {(bytes: Uint8Array) => Uint8Array} encrypt
 */
const countSentNonces = encrypt => {
  let sentCount = 0n;
  return harden({
    /** @param {Uint8Array} bytes */
    encrypt: bytes => {
      const cipherText = encrypt(bytes);
      sentCount += 1n;
      return cipherText;
    },
    getSentCount: () => sentCount,
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
 * }} options
 * @returns {OcapnNoiseNetwork}
 */
export const makeOcapnNoiseNetwork = ({
  codec,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  maxInProgressPerLocalKey = DEFAULT_MAX_IN_PROGRESS_PER_LOCAL_KEY,
  heartbeat,
}) => {
  const cryptography = makeCryptography(codec);
  const heartbeatSettings = normalizeHeartbeatOptions(heartbeat);

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
   * @typedef {{ session: OcapnNoiseSession, tiebreaker: Uint8Array, close: () => void }} Candidate
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
   * Build the streaming `NetworkSession` returned from `provideSession`.
   * Each inbound transport frame is one encrypted OCapN message; the
   * session reader decrypts and yields plaintext. The session writer
   * encrypts each outbound message and hands it to the transport as
   * one frame.
   *
   * @param {object} params
   * @param {RegisteredKey} params.localKey
   * @param {OcapnLocation} params.location
   * @param {OcapnSignature} params.locationSignature
   * @param {OcapnLocation} params.peerLocation
   * @param {OcapnSignature} params.peerLocationSignature
   * @param {Uint8Array} params.peerEd25519
   * @param {boolean} params.isInitiator
   * @param {ByteStream} params.stream
   * @param {(bytes: Uint8Array) => Uint8Array} params.encrypt
   * @param {(bytes: Uint8Array) => Uint8Array} params.decrypt
   * @param {() => bigint} params.getReceivedCount - How many
   *   transport messages `decrypt` has accepted on this CipherState.
   * @param {() => bigint} params.getSentCount - How many transport
   *   messages `encrypt` has sealed on this CipherState.
   * @param {() => void} params.onClose - Called when the session closes
   *   (peer disconnect, local `close()`, or stream end). Used by the
   *   network to forget the entry from `active` so a future
   *   `provideSession` does not resurrect a dead session.
   * @returns {OcapnNoiseSession}
   */
  const buildSession = ({
    localKey,
    location,
    locationSignature,
    peerLocation,
    peerLocationSignature,
    peerEd25519,
    isInitiator,
    stream,
    encrypt,
    decrypt,
    getReceivedCount,
    getSentCount,
    onClose,
  }) => {
    let closed = false;

    // The session epoch numbers transport instances. Without reconnect
    // there is only the handshake's instance, epoch 0.
    const epoch = 0n;
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

    // The session-level outbound queue: plaintext frames the session
    // has accepted but the transport has not. `writer.next` resolves on
    // acceptance, so a stalled transport holds a writer back only once
    // the queue reaches its high-water mark; awaiting one in-flight
    // write instead would hold every writer for the whole stall.
    /**
     * @typedef {{ heartbeat: boolean, render: () => Uint8Array }} OutboundFrame
     */
    /** @type {OutboundFrame[]} */
    const outbound = [];
    let queuedHeartbeatFrames = 0;
    /**
     * The running drain, or `undefined` while the queue is idle.
     *
     * @type {Promise<void> | undefined}
     */
    let activeDrain;
    // Writers waiting, in call order, for the queue to fall below its
    // high-water mark. A waiter's frame is enqueued in the same turn
    // that room appears, so a later writer cannot overtake it.
    /**
     * @type {Array<{ plainText: Uint8Array, resolve: (accepted: boolean) => void }>}
     */
    let spaceWaiters = [];
    const rejectSpaceWaiters = () => {
      const rejected = spaceWaiters;
      spaceWaiters = [];
      for (const { resolve } of rejected) resolve(false);
    };

    // Settles the drain's wait on the frame the transport holds, so a
    // write the transport never settles cannot hold the drain once the
    // session has ended. One per frame, so waiting retains nothing past
    // the frame.
    /** @type {(() => void) | undefined} */
    let abandonWrite;

    /** @type {() => void} */
    let resolveClosed = () => {};
    /** @type {Promise<void>} */
    const closedPromise = new Promise(resolve => {
      resolveClosed = resolve;
    });

    const stopHeartbeat = () => {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      if (livenessTimer !== undefined) clearTimeout(livenessTimer);
      if (writeStallTimer !== undefined) clearTimeout(writeStallTimer);
      heartbeatTimer = undefined;
      livenessTimer = undefined;
      writeStallTimer = undefined;
    };

    const fireOnClose = () => {
      stopHeartbeat();
      resolveClosed();
      if (abandonWrite !== undefined) abandonWrite();
      // The writes of the frames dropped here have already resolved, so
      // the error the reader surfaces is the only report of the loss. A
      // writer still waiting for room learns of it from a `done` result.
      outbound.length = 0;
      queuedHeartbeatFrames = 0;
      rejectSpaceWaiters();
      try {
        onClose();
      } catch (_e) {
        // never throw out of teardown
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      // Tear both directions down. We suppress any rejection here
      // because a transport's write half may have already closed.
      Promise.resolve(stream.writer.return(undefined)).catch(() => {});
      Promise.resolve(stream.reader.return(undefined)).catch(() => {});
      fireOnClose();
    };

    /** @type {Reader<Uint8Array>} */
    let reader;
    /**
     * Accepts a writer frame into the outbound queue, or `undefined`
     * for a session without heartbeats, which writes directly.
     *
     * @type {((plainText: Uint8Array) => Promise<IteratorResult<undefined, undefined>>) | undefined}
     */
    let acceptFrame;

    if (heartbeatSettings === undefined) {
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

      // A transport write that does not complete within the session
      // timeout is loss, not a stall: the peer, hearing nothing from us
      // for as long, has given up on this transport instance too.
      const onWriteStall = () => {
        fail(
          makeError(
            X`ocapn-noise: transport write stalled for ${q(sessionTimeoutMs)}ms; session lost`,
          ),
        );
      };

      // Encrypting at hand-off keeps the Noise nonce order equal to the
      // transport order however long a frame waits in the queue.
      // `activeDrain` is cleared in the same turn as the final
      // empty-queue check, so a frame enqueued after that check starts a
      // new drain rather than waiting for the next heartbeat.
      const drain = async () => {
        await null;
        try {
          while (!closed && outbound.length > 0) {
            const frame = outbound[0];
            writeStallTimer = setTimeout(onWriteStall, sessionTimeoutMs);
            try {
              const written = Promise.resolve(
                stream.writer.next(encrypt(frame.render())),
              );
              // eslint-disable-next-line no-await-in-loop
              await /** @type {Promise<void>} */ (
                new Promise((resolve, reject) => {
                  abandonWrite = () => resolve(undefined);
                  written.then(() => resolve(undefined), reject);
                })
              );
            } catch (error) {
              fail(/** @type {Error} */ (error));
              return;
            } finally {
              abandonWrite = undefined;
              clearTimeout(writeStallTimer);
              writeStallTimer = undefined;
            }
            if (closed) return;
            outbound.shift();
            if (frame.heartbeat) queuedHeartbeatFrames -= 1;
            while (
              spaceWaiters.length > 0 &&
              outbound.length < OUTBOUND_HIGH_WATER_FRAMES
            ) {
              const { plainText, resolve } =
                /** @type {(typeof spaceWaiters)[number]} */ (
                  spaceWaiters.shift()
                );
              enqueueFrame(plainText);
              resolve(true);
            }
          }
        } finally {
          activeDrain = undefined;
        }
      };

      /**
       * @param {OutboundFrame} frame
       */
      const enqueue = frame => {
        if (closed) return;
        outbound.push(frame);
        if (frame.heartbeat) queuedHeartbeatFrames += 1;
        if (activeDrain === undefined) activeDrain = drain();
      };

      /**
       * @param {Uint8Array} plainText
       */
      const enqueueFrame = plainText => {
        // The caller may reuse its buffer once the write resolves, and
        // the frame can wait in the queue past that. Not `.slice()`: on a
        // Node `Buffer` that returns a view over the same memory.
        const copy = new Uint8Array(plainText);
        enqueue({ heartbeat: false, render: () => copy });
      };

      // Validation stays here rather than in the drain, so a bad frame
      // rejects its own `writer.next` instead of ending the session.
      acceptFrame = async plainText => {
        if (!(plainText instanceof Uint8Array)) {
          throw makeError(
            X`ocapn-noise: session frame must be a Uint8Array, got ${q(typeof plainText)}`,
          );
        }
        if (plainText.length > MAX_FRAME_PLAINTEXT_LENGTH) {
          throw makeError(
            X`ocapn-noise: session frame of ${q(plainText.length)} bytes exceeds ${q(MAX_FRAME_PLAINTEXT_LENGTH)}`,
          );
        }
        if (
          spaceWaiters.length === 0 &&
          outbound.length < OUTBOUND_HIGH_WATER_FRAMES
        ) {
          enqueueFrame(plainText);
          return harden({ done: false, value: undefined });
        }
        const accepted = await new Promise(resolve => {
          spaceWaiters.push({ plainText, resolve });
        });
        return harden({ done: !accepted, value: undefined });
      };

      const sendHeartbeat = () => {
        // While the transport is stalled, heartbeats already waiting in
        // the queue carry all the liveness a fresh pair would, so do
        // not let a stall pile them up.
        if (queuedHeartbeatFrames > 0) return;
        const ping = pingSequence;
        pingSequence += 1n;
        enqueue({
          heartbeat: true,
          render: () =>
            writeOcapnHeartbeatMessage(
              { type: 'op:ping', epoch, sequence: ping },
              codec,
            ),
        });
        const pong = pongSequence;
        pongSequence += 1n;
        enqueue({
          heartbeat: true,
          // Rendered at hand-off, so the acknowledgment is current
          // even when the frame waited out a stall.
          render: () =>
            writeOcapnHeartbeatMessage(
              {
                type: 'op:pong',
                epoch,
                sequence: pong,
                lastAckedRecvNonce: getReceivedCount() - 1n,
              },
              codec,
            ),
        });
      };

      /**
       * Absorb a heartbeat operation, reporting whether the frame was
       * one. Any other frame belongs to the session above.
       *
       * @param {Uint8Array} plainText
       * @returns {boolean}
       */
      const absorbHeartbeat = plainText => {
        /** @type {{ type: string, epoch: bigint, lastAckedRecvNonce?: bigint }} */
        let message;
        try {
          const peekReader = codec.makeReader(plainText);
          if (peekReader.peekTypeHint() !== 'record') return false;
          peekReader.enterRecord();
          const label = peekReader.readRecordLabel();
          if (
            label.type === 'bytestring' ||
            (label.value !== 'op:ping' && label.value !== 'op:pong')
          ) {
            return false;
          }
          const messageReader = codec.makeReader(plainText);
          message = readOcapnHeartbeatMessage(messageReader);
          if (messageReader.index !== plainText.length) return false;
        } catch (_error) {
          return false;
        }
        // A heartbeat from an earlier epoch is a straggler from an
        // obsolete transport instance: dropped without effect.
        if (message.epoch < epoch) return true;
        const { lastAckedRecvNonce } = message;
        if (
          lastAckedRecvNonce !== undefined &&
          (peerAckedRecvNonce === undefined ||
            lastAckedRecvNonce > peerAckedRecvNonce)
        ) {
          peerAckedRecvNonce = lastAckedRecvNonce;
        }
        return true;
      };

      const onSessionTimeout = () => {
        fail(
          makeError(
            X`ocapn-noise: no traffic from peer for ${q(sessionTimeoutMs)}ms; session lost`,
          ),
        );
      };

      const resetLivenessTimer = () => {
        if (closed) return;
        if (livenessTimer !== undefined) clearTimeout(livenessTimer);
        livenessTimer = setTimeout(onSessionTimeout, sessionTimeoutMs);
      };

      // Read the transport eagerly rather than at the consumer's pace,
      // so that a consumer that is slow to call `next` cannot starve
      // the liveness timer of the traffic that resets it.
      const pump = async () => {
        await null;
        for (;;) {
          /** @type {IteratorResult<Uint8Array>} */
          let result;
          /** @type {Uint8Array} */
          let plainText;
          try {
            // eslint-disable-next-line no-await-in-loop
            result = await stream.reader.next(undefined);
            if (result.done) {
              inbound.put(harden({ done: true }));
              if (!closed) {
                closed = true;
                fireOnClose();
              }
              return;
            }
            plainText = decrypt(result.value);
          } catch (error) {
            fail(/** @type {Error} */ (error));
            return;
          }
          resetLivenessTimer();
          if (!absorbHeartbeat(plainText)) {
            inbound.put(harden({ done: false, value: plainText }));
          }
        }
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

      resetLivenessTimer();
      heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
      void pump();
    }

    /** @type {Writer<Uint8Array>} */
    const writer = harden({
      next: async value => {
        await null;
        if (closed) return harden({ done: true, value: undefined });
        if (acceptFrame !== undefined) return acceptFrame(value);
        await stream.writer.next(encrypt(value));
        return harden({ done: false, value: undefined });
      },
      return: async () => {
        await null;
        await Promise.race([activeDrain, closedPromise]);
        if (!closed) {
          closed = true;
          try {
            await stream.writer.return(undefined);
          } finally {
            fireOnClose();
          }
        }
        return harden({ done: true, value: undefined });
      },
      throw: async err => {
        await null;
        if (!closed) {
          closed = true;
          try {
            await stream.writer.throw(err);
          } finally {
            fireOnClose();
          }
        }
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

    return harden({
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
          epoch,
          lastAckedRecvNonce: getReceivedCount() - 1n,
          peerAckedRecvNonce,
          lastSentNonce: getSentCount() - 1n,
          queuedFrames: outbound.length,
        }),
      close,
    });
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
   * Drive the initiator side of a single handshake. Does not wait for
   * crossed-hello settlement; the caller is expected to register and
   * settle via the outer state machine.
   *
   * @param {RegisteredKey} localKey
   * @param {OcapnLocation} location
   * @param {Uint8Array} peerEd25519
   * @returns {Promise<{ session: OcapnNoiseSession, tiebreaker: Uint8Array, close: () => void }>}
   */
  const runInitiator = async (localKey, location, peerEd25519) => {
    const { transport, hints } = selectOutgoingTransport(location);
    const peerId = toHex(peerEd25519);

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
      const { handshakeHash, ...cipher } = initiatorReadSynack(synack);
      const nonces = countReceivedNonces(cipher.decrypt);
      const { decrypt } = nonces;
      const sent = countSentNonces(cipher.encrypt);
      const { encrypt } = sent;

      const {
        peerLocation,
        peerLocationSignature,
        location: myLocation,
        locationSignature,
      } = await withTimeout(
        exchangeIdentity(
          localKey,
          stream.reader,
          stream.writer,
          encrypt,
          decrypt,
          peerEd25519,
          handshakeHash,
        ),
        handshakeTimeoutMs,
        'post-handshake identity exchange',
        stream,
      );

      /** @type {Candidate | undefined} */
      let candidate;
      const session = buildSession({
        localKey,
        location: myLocation,
        locationSignature,
        peerLocation,
        peerLocationSignature,
        peerEd25519,
        isInitiator: true,
        stream,
        encrypt,
        decrypt,
        getReceivedCount: nonces.getReceivedCount,
        getSentCount: sent.getSentCount,
        onClose: () => {
          if (candidate) forgetActive(peerId, candidate);
        },
      });
      candidate = {
        session,
        tiebreaker,
        close: () => {
          session.close();
        },
      };
      return candidate;
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
      const { initiatorVerifyingKey, handshakeHash, ...cipher } =
        asResp.responderReadSynWriteSynack(prefixedSyn, synack);
      const nonces = countReceivedNonces(cipher.decrypt);
      const { decrypt } = nonces;
      const sent = countSentNonces(cipher.encrypt);
      const { encrypt } = sent;
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
      const adopted = active.get(initiatorKeyHex);
      if (adopted && pendingInbound.indexOf(adopted.session) === -1) {
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
      registeredPeerId = initiatorKeyHex;
      bumpInProgress(initiatorKeyHex);
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

      const {
        peerLocation,
        peerLocationSignature,
        location,
        locationSignature,
      } = await Promise.race([
        withTimeout(
          exchangeIdentity(
            localKey,
            stream.reader,
            stream.writer,
            encrypt,
            decrypt,
            initiatorVerifyingKey,
            handshakeHash,
          ),
          handshakeTimeoutMs,
          'post-handshake identity exchange',
          stream,
        ),
        evicted,
      ]);

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

      /** @type {Candidate | undefined} */
      let candidate;
      const session = buildSession({
        localKey,
        location,
        locationSignature,
        peerLocation,
        peerLocationSignature,
        peerEd25519: initiatorVerifyingKey,
        isInitiator: false,
        stream,
        encrypt,
        decrypt,
        getReceivedCount: nonces.getReceivedCount,
        getSentCount: sent.getSentCount,
        onClose: () => {
          if (candidate) forgetActive(initiatorKeyHex, candidate);
        },
      });
      candidate = {
        session,
        tiebreaker,
        close: () => session.close(),
      };

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
