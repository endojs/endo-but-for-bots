// @ts-check

/**
 * Session-level outbound queue and session epoch, Phase 2 of
 * designs/ocapn-noise-session-reconnect.md.
 *
 * Every serialized CapTP operation a session sends passes through this
 * queue on its way to the transport instance's `write`. While the
 * transport accepts writes synchronously the queue is transparent: an
 * operation goes straight to `write`, and a synchronous write failure
 * reaches the caller as it did before the queue existed.
 *
 * A transport instance may instead stall: its `write` returns a
 * promise that settles only when the bytes have left. The queue then
 * holds that operation in flight and accumulates every later operation
 * behind it, in order, until the write settles, and then drains them
 * one write at a time. A rejected or throwing write during the drain
 * closes the queue and reports the error through `onError`; liveness
 * is the heartbeat's verdict, not the queue's.
 *
 * The session epoch numbers the transport instances of one session,
 * starting at 0 for the handshake's connection. `advanceEpoch` binds
 * the queue to the next transport instance and replays every operation
 * not yet known to have left, including the one in flight on the old
 * instance (at-least-once; receivers dedupe per the design's § 4).
 * Phase 2 runs on a single transport instance, so nothing in the
 * client advances the epoch yet; reconnect (Phase 3) does.
 */

import harden from '@endo/harden';

const UINT64_MAX = 2n ** 64n - 1n;

/**
 * A transport instance's write. Returning a thenable means the write
 * is stalled until it settles.
 *
 * @typedef {(bytes: Uint8Array) => void | PromiseLike<unknown>} QueueWrite
 */

/**
 * @typedef {object} SendQueue
 * @property {(bytes: Uint8Array) => void} write enqueue one serialized
 *   operation; writes through immediately when nothing is pending
 * @property {() => bigint} getEpoch the current transport instance's
 *   session epoch
 * @property {(write: QueueWrite) => bigint} advanceEpoch bind the next
 *   transport instance, replay pending operations on it, and return
 *   the new epoch
 * @property {(wrap: (write: QueueWrite) => QueueWrite) => void} interposeWriter
 *   replace the current instance's write with a wrapper around it, for
 *   fault injection and instrumentation
 * @property {() => number} getPendingCount operations not yet written,
 *   including the one in flight
 * @property {() => boolean} isStalled whether a write is in flight
 * @property {(reason?: Error) => void} close drop pending operations
 *   and refuse further writes; idempotent
 */

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
const isThenable = value =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (/** @type {any} */ (value).then) === 'function';

/**
 * @param {object} params
 * @param {QueueWrite} params.write the handshake transport instance's
 *   write (epoch 0)
 * @param {(error: Error) => void} [params.onError] called once when a
 *   queued write fails during a drain
 * @returns {SendQueue}
 */
export const makeSendQueue = ({ write: initialWrite, onError = () => {} }) => {
  let write = initialWrite;
  let epoch = 0n;
  /** @type {Uint8Array[]} */
  const pending = [];
  /** @type {Uint8Array | undefined} */
  let inFlight;
  // Bumped whenever the in-flight write is abandoned (epoch advance or
  // close), so a late settlement from an obsolete write is ignored.
  let generation = 0;
  let closed = false;

  /** @param {Error} [reason] */
  const close = reason => {
    if (closed) return;
    closed = true;
    generation += 1;
    pending.length = 0;
    inFlight = undefined;
    if (reason) onError(reason);
  };

  /**
   * Write one operation. Returns true when the write completed
   * synchronously, false when it is now in flight.
   *
   * @param {Uint8Array} bytes
   */
  const writeOne = bytes => {
    const result = write(bytes);
    if (!isThenable(result)) return true;
    inFlight = bytes;
    const myGeneration = generation;
    result.then(
      () => {
        if (myGeneration !== generation) return;
        inFlight = undefined;
        drain();
      },
      error => {
        if (myGeneration !== generation) return;
        close(error instanceof Error ? error : Error(String(error)));
      },
    );
    return false;
  };

  const drain = () => {
    while (!closed && inFlight === undefined && pending.length > 0) {
      const bytes = /** @type {Uint8Array} */ (pending.shift());
      try {
        if (!writeOne(bytes)) return;
      } catch (error) {
        close(error instanceof Error ? error : Error(String(error)));
        return;
      }
    }
  };

  /** @type {SendQueue['write']} */
  const enqueue = bytes => {
    if (closed) return;
    if (inFlight === undefined && pending.length === 0) {
      // Transparent path: a synchronous failure reaches the caller.
      writeOne(bytes);
      return;
    }
    pending.push(bytes);
  };

  /** @type {SendQueue['advanceEpoch']} */
  const advanceEpoch = nextWrite => {
    if (closed) throw Error('OCapN send queue: closed');
    if (epoch >= UINT64_MAX) throw RangeError('OCapN session epoch exhausted');
    epoch += 1n;
    generation += 1;
    write = nextWrite;
    if (inFlight !== undefined) {
      // Whether the old instance delivered it is unknown; replay it.
      pending.unshift(inFlight);
      inFlight = undefined;
    }
    drain();
    return epoch;
  };

  return harden({
    write: enqueue,
    getEpoch: () => epoch,
    advanceEpoch,
    interposeWriter: wrap => {
      write = wrap(write);
    },
    getPendingCount: () => pending.length + (inFlight === undefined ? 0 : 1),
    isStalled: () => inFlight !== undefined,
    close,
  });
};
harden(makeSendQueue);
