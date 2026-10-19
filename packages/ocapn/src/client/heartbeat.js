// @ts-check
/* global setTimeout, clearTimeout */

import harden from '@endo/harden';

/**
 * Session-liveness heartbeat for an OCapN session, per Phase 1 of
 * designs/ocapn-noise-session-reconnect.md.
 *
 * Each side emits `op:ping` (and `op:pong`, carrying its
 * `lastAckedRecvNonce`) every `intervalMs` on its own clock. Receipt of
 * any traffic from the peer resets a sliding `timeoutMs` deadline; when
 * the deadline lapses the session is declared lost. Phase 1 has no
 * reconnection, so loss is surfaced to the caller (which aborts the
 * session) and the epoch is always zero.
 *
 * The `op:ping` and `op:pong` operations are proposed, pending OCapN-org
 * review, so the heartbeat is opt-in.
 */

/**
 * @typedef {object} HeartbeatOptions
 * @property {number} [intervalMs] How often this side emits `op:ping`
 *   and `op:pong`. Default: 5000.
 * @property {number} [timeoutMs] How long without any incoming traffic
 *   before the session is declared lost. Must be at least three times
 *   `intervalMs`. Default: 30000.
 * @property {() => bigint} [getLastAckedRecvNonce] The highest receive
 *   nonce this side has processed on the current cipher state, carried
 *   in `op:pong`. A network that owns a cipher state supplies this;
 *   absent one, the session reports the count of incoming frames.
 */

/**
 * @typedef {object} HeartbeatTimers
 * @property {(callback: () => void, ms: number) => any} setTimeout
 * @property {(handle: any) => void} clearTimeout
 */

/**
 * @typedef {object} Heartbeat
 * @property {() => void} noteActivity Reset the liveness deadline;
 *   call on every receipt of peer traffic.
 * @property {(message: { epoch: bigint, sequence: bigint, lastAckedRecvNonce: bigint }) => void} notePong
 *   Record the peer's acknowledged receive nonce from an `op:pong`.
 * @property {() => bigint} getPeerAckedRecvNonce The highest receive
 *   nonce the peer has acknowledged, never rewound by a stale or
 *   replayed `op:pong`.
 * @property {() => bigint} getEpoch
 * @property {() => void} stop Cancel all timers. Idempotent.
 */

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_SESSION_TIMEOUT_MS = 30_000;

/** @type {HeartbeatTimers} */
const defaultTimers = harden({
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // A heartbeat must not by itself keep a host process alive.
    if (typeof handle === 'object' && typeof handle.unref === 'function') {
      handle.unref();
    }
    return handle;
  },
  clearTimeout: handle => clearTimeout(handle),
});

/**
 * @param {object} opts
 * @param {HeartbeatOptions} opts.options
 * @param {(message: { type: 'op:ping', epoch: bigint, sequence: bigint }) => void} opts.sendPing
 * @param {(message: { type: 'op:pong', epoch: bigint, sequence: bigint, lastAckedRecvNonce: bigint }) => void} opts.sendPong
 * @param {() => bigint} opts.getLastAckedRecvNonce
 * @param {(reason: Error) => void} opts.onLoss Called once when the
 *   liveness deadline lapses.
 * @param {HeartbeatTimers} [opts.timers]
 * @returns {Heartbeat}
 */
export const makeHeartbeat = ({
  options,
  sendPing,
  sendPong,
  getLastAckedRecvNonce,
  onLoss,
  timers = defaultTimers,
}) => {
  const {
    intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = options;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw RangeError(
      `heartbeat intervalMs must be a positive finite number, got ${intervalMs}`,
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 3 * intervalMs) {
    throw RangeError(
      `heartbeat timeoutMs must be at least 3 * intervalMs (${3 * intervalMs}), got ${timeoutMs}`,
    );
  }

  // Phase 1 runs on a single transport instance; reconnection (and
  // with it epoch advance) arrives in a later phase.
  const epoch = 0n;
  let pingSequence = 0n;
  let pongSequence = 0n;
  let peerAckedRecvNonce = 0n;
  let stopped = false;
  /** @type {any} */
  let tickHandle;
  /** @type {any} */
  let deadlineHandle;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    timers.clearTimeout(tickHandle);
    timers.clearTimeout(deadlineHandle);
  };

  const lapse = () => {
    if (stopped) {
      return;
    }
    stop();
    onLoss(
      harden(
        Error(
          `OCapN session heartbeat timeout: no traffic from peer in ${timeoutMs}ms`,
        ),
      ),
    );
  };

  const armDeadline = () => {
    timers.clearTimeout(deadlineHandle);
    deadlineHandle = timers.setTimeout(lapse, timeoutMs);
  };

  const tick = () => {
    if (stopped) {
      return;
    }
    sendPing(harden({ type: 'op:ping', epoch, sequence: pingSequence }));
    pingSequence += 1n;
    sendPong(
      harden({
        type: 'op:pong',
        epoch,
        sequence: pongSequence,
        lastAckedRecvNonce: getLastAckedRecvNonce(),
      }),
    );
    pongSequence += 1n;
    if (!stopped) {
      tickHandle = timers.setTimeout(tick, intervalMs);
    }
  };

  const noteActivity = () => {
    if (!stopped) {
      armDeadline();
    }
  };

  /**
   * @param {{ epoch: bigint, lastAckedRecvNonce: bigint }} message
   */
  const notePong = ({ epoch: pongEpoch, lastAckedRecvNonce }) => {
    // A pong from an obsolete transport instance carries nothing about
    // the current one.
    if (pongEpoch < epoch) {
      return;
    }
    if (lastAckedRecvNonce > peerAckedRecvNonce) {
      peerAckedRecvNonce = lastAckedRecvNonce;
    }
  };

  armDeadline();
  tickHandle = timers.setTimeout(tick, intervalMs);

  return harden({
    noteActivity,
    notePong,
    getPeerAckedRecvNonce: () => peerAckedRecvNonce,
    getEpoch: () => epoch,
    stop,
  });
};
