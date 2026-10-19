// @ts-check

/**
 * Session-liveness heartbeat, Phase 1 of
 * designs/ocapn-noise-session-reconnect.md.
 *
 * Each side emits `op:ping` (and an `op:pong` carrying its explicit
 * receive-nonce acknowledgment) every `intervalMs`, on its own clock.
 * Any incoming operation from the peer is evidence of liveness and
 * re-arms a sliding `timeoutMs` window; when the window lapses with no
 * traffic the session is declared lost. Pings and pongs from an epoch
 * earlier than the current one are stragglers from an obsolete
 * transport instance and are dropped without counting as liveness.
 *
 * Phase 1 runs on a single transport instance, so the epoch stays at
 * zero and loss tears the session down. Later phases advance the
 * epoch on reconnect instead.
 */

import harden from '@endo/harden';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
export const MIN_HEARTBEAT_INTERVAL_MS = 1000;
export const MAX_HEARTBEAT_INTERVAL_MS = 60_000;

const UINT64_MAX = 2n ** 64n - 1n;

/**
 * @typedef {object} HeartbeatTimer
 * @property {(callback: () => void, delayMs: number) => unknown} setTimeout
 * @property {(handle: any) => void} clearTimeout
 */

/**
 * @typedef {object} HeartbeatOptions
 * @property {number} [intervalMs] how often to emit `op:ping` /
 *   `op:pong`. Default 5 s; range 1 s to 60 s.
 * @property {number} [timeoutMs] how long without incoming traffic
 *   before the session is declared lost. Default 30 s; at least
 *   `3 * intervalMs`.
 * @property {HeartbeatTimer} [timer] injectable clock, for tests.
 *   Defaults to the global `setTimeout` / `clearTimeout`.
 */

/**
 * @typedef {object} Heartbeat
 * @property {() => void} start arm the emit and liveness timers
 * @property {() => void} stop disarm both timers; idempotent
 * @property {(message: { type: string, epoch?: bigint, sequence?: bigint, lastAckedRecvNonce?: bigint }) => boolean} observe
 *   record an incoming operation; returns false when the operation is a
 *   stale-epoch heartbeat that was dropped
 * @property {() => bigint} getEpoch
 * @property {() => bigint} getPeerAckedRecvNonce highest receive nonce
 *   the peer has acknowledged via `op:pong`
 * @property {() => { intervalMs: number, timeoutMs: number }} getConfig
 */

/**
 * @param {HeartbeatOptions} [options]
 * @returns {{ intervalMs: number, timeoutMs: number }}
 */
export const validateHeartbeatOptions = (options = {}) => {
  const {
    intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    timeoutMs = Math.max(DEFAULT_SESSION_TIMEOUT_MS, 3 * intervalMs),
  } = options;
  if (
    typeof intervalMs !== 'number' ||
    !(intervalMs >= MIN_HEARTBEAT_INTERVAL_MS) ||
    !(intervalMs <= MAX_HEARTBEAT_INTERVAL_MS)
  ) {
    throw RangeError(
      `OCapN heartbeat: intervalMs must be between ${MIN_HEARTBEAT_INTERVAL_MS} and ${MAX_HEARTBEAT_INTERVAL_MS}, got ${intervalMs}`,
    );
  }
  if (typeof timeoutMs !== 'number' || !(timeoutMs >= 3 * intervalMs)) {
    throw RangeError(
      `OCapN heartbeat: timeoutMs must be at least 3 * intervalMs (${3 * intervalMs}), got ${timeoutMs}`,
    );
  }
  return harden({ intervalMs, timeoutMs });
};

/**
 * The host's timers, when it has them. A compartment without ambient
 * timers must pass `options.timer`.
 *
 * @returns {HeartbeatTimer}
 */
const makeDefaultTimer = () => {
  const { setTimeout: hostSetTimeout, clearTimeout: hostClearTimeout } =
    /** @type {any} */ (globalThis);
  if (
    typeof hostSetTimeout !== 'function' ||
    typeof hostClearTimeout !== 'function'
  ) {
    throw TypeError(
      'OCapN heartbeat: no global setTimeout; pass options.timer',
    );
  }
  return harden({
    setTimeout: (callback, delayMs) => hostSetTimeout(callback, delayMs),
    clearTimeout: handle => hostClearTimeout(handle),
  });
};

/**
 * @param {object} params
 * @param {HeartbeatOptions} [params.options]
 * @param {(message: object) => void} params.send emit one operation
 * @param {(reason: Error) => void} params.onLoss called once when the
 *   liveness window lapses
 * @param {() => bigint} [params.getLastAckedRecvNonce] highest receive
 *   nonce this side has decrypted, for `op:pong`. Defaults to 0n where
 *   the cipher state is not visible (the CapTP layer above a network).
 * @returns {Heartbeat}
 */
export const makeHeartbeat = ({
  options = {},
  send,
  onLoss,
  getLastAckedRecvNonce = () => 0n,
}) => {
  const { intervalMs, timeoutMs } = validateHeartbeatOptions(options);
  const { timer = makeDefaultTimer() } = options;

  // A single transport instance per session until reconnect lands.
  const epoch = 0n;
  let pingSequence = 0n;
  let pongSequence = 0n;
  let peerAckedRecvNonce = 0n;
  let running = false;
  /** @type {unknown} */
  let emitHandle;
  /** @type {unknown} */
  let livenessHandle;

  /** @param {unknown} handle */
  const unref = handle => {
    // Do not let an idle heartbeat keep a Node.js process alive.
    const maybe = /** @type {{ unref?: () => void } | undefined} */ (handle);
    if (maybe && typeof maybe.unref === 'function') maybe.unref();
    return handle;
  };

  const stop = () => {
    running = false;
    if (emitHandle !== undefined) timer.clearTimeout(emitHandle);
    if (livenessHandle !== undefined) timer.clearTimeout(livenessHandle);
    emitHandle = undefined;
    livenessHandle = undefined;
  };

  const armLiveness = () => {
    if (livenessHandle !== undefined) timer.clearTimeout(livenessHandle);
    livenessHandle = unref(
      timer.setTimeout(() => {
        livenessHandle = undefined;
        if (!running) return;
        stop();
        onLoss(
          Error(
            `OCapN session timeout: no traffic from peer for ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs),
    );
  };

  const emit = () => {
    emitHandle = undefined;
    if (!running) return;
    const lastAckedRecvNonce = getLastAckedRecvNonce();
    /** @param {object} message */
    const trySend = message => {
      try {
        send(harden(message));
      } catch (_err) {
        // A failed write is not itself a liveness verdict; the
        // liveness window decides.
      }
    };
    trySend({ type: 'op:ping', epoch, sequence: pingSequence });
    trySend({
      type: 'op:pong',
      epoch,
      sequence: pongSequence,
      lastAckedRecvNonce,
    });
    if (pingSequence < UINT64_MAX) pingSequence += 1n;
    if (pongSequence < UINT64_MAX) pongSequence += 1n;
    if (running) {
      emitHandle = unref(timer.setTimeout(emit, intervalMs));
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    armLiveness();
    emitHandle = unref(timer.setTimeout(emit, intervalMs));
  };

  /** @type {Heartbeat['observe']} */
  const observe = message => {
    const { type } = message;
    if (type === 'op:ping' || type === 'op:pong') {
      if (/** @type {bigint} */ (message.epoch) < epoch) return false;
      if (type === 'op:pong') {
        // Take the max so a replayed or reordered pong cannot rewind
        // the acknowledgment.
        const acked = /** @type {bigint} */ (message.lastAckedRecvNonce);
        if (acked > peerAckedRecvNonce) peerAckedRecvNonce = acked;
      }
    }
    if (running) armLiveness();
    return true;
  };

  return harden({
    start,
    stop,
    observe,
    getEpoch: () => epoch,
    getPeerAckedRecvNonce: () => peerAckedRecvNonce,
    getConfig: () => harden({ intervalMs, timeoutMs }),
  });
};
harden(makeHeartbeat);
