// @ts-check

/**
 * One hosted turn's delivery channel, the same for every adapter.
 *
 * A hosted client answers `send` with a reader Floot pulls normalized events
 * from until a terminal. Three adapters had each built the same three
 * things around that reader: the credit-bounded queue with the same bounds
 * and the same weight function, a "terminal" promise the producer settles
 * exactly once so `interrupt` has something to await, and a hook for the
 * consumer closing the reader early. Two of them also raced the same
 * deadline against that barrier. This is those pieces, once.
 *
 * What it is not: an admission policy. Whether a second `send` queues behind
 * the first or is refused is the adapter's decision, made where its transport
 * makes it — the app-server binds one turn to a thread and answers a second
 * with an error, where a spawned CLI can simply wait its turn.
 *
 * @module
 */

import { clearTimeout, setTimeout } from 'node:timers';

import { Fail } from '@endo/errors';
import { makeBoundedReader } from '@endo/exo-stream/bounded-channel.js';

/**
 * The delivery bounds every hosted adapter uses: at most 1,024 undelivered
 * events and 16 MiB of accounting weight, where an event weighs 64 bytes
 * plus twice its JSON length. This bounds what is queued for delivery — a
 * consumer that stops pulling — not the turn: consumed events release their
 * charges, and overflow fails delivery explicitly rather than growing.
 */
export const HOSTED_TURN_CHANNEL_BOUNDS = harden({
  maxItems: 1024,
  maxWeight: 16 * 1024 * 1024,
});

/** @param {unknown} event */
export const weighHostedEvent = event => 64 + JSON.stringify(event).length * 2;
harden(weighHostedEvent);

/**
 * @typedef {object} HostedTurnChannel
 * @property {any} reader The reader handed to the consumer.
 * @property {(event: any) => void} push Deliver one event; a no-op once the
 *   reader is closed.
 * @property {() => void} close End the reader from the producer side,
 *   discarding what it had not delivered: how an adapter with nothing else
 *   to signal cuts a consumer loose. A delivered `end`/`abort` ends the
 *   reader by itself; this is for a turn that will not get one.
 * @property {Promise<void>} terminal Settles when the producer has delivered
 *   its terminal event, or otherwise given up on the turn; what an
 *   `interrupt` awaits so a later `send` cannot race the turn it ended.
 * @property {() => void} settle Settle `terminal`. Idempotent.
 * @property {() => boolean} isSettled
 * @property {() => boolean} isClosed Whether the consumer closed the reader.
 */

/**
 * @param {object} [options]
 * @param {() => void} [options.onConsumerClosed] Called once if the consumer
 *   closes the reader before the terminal: the adapter's cue to stop its
 *   producer. Reader closure is not the producer's exit; `terminal` still
 *   settles when the producer actually ends.
 * @returns {HostedTurnChannel}
 */
export const makeHostedTurnChannel = ({ onConsumerClosed } = {}) => {
  const { push, reader, close, setOnClose } = makeBoundedReader({
    ...HOSTED_TURN_CHANNEL_BOUNDS,
    weigh: weighHostedEvent,
  });
  let settled = false;
  let closed = false;
  /** @type {() => void} */
  let settle = () => {};
  const terminal = /** @type {Promise<void>} */ (
    new Promise(resolve => {
      settle = () => {
        settled = true;
        resolve(undefined);
      };
    })
  );
  setOnClose(() => {
    closed = true;
    if (onConsumerClosed) onConsumerClosed();
  });
  return harden({
    reader,
    push,
    close,
    terminal,
    settle: () => settle(),
    isSettled: () => settled,
    isClosed: () => closed,
  });
};
harden(makeHostedTurnChannel);

/**
 * Await a barrier, or give up at a deadline. The timer is cleared as soon as
 * the barrier settles, and deliberately not `unref`'d: a deadline that lets
 * the process exit before it fires is a deadline that never fires when
 * nothing else is pending, which is precisely when a wedged producer would
 * otherwise hang the caller. On the deadline the returned promise rejects
 * with `makeFailure()`, so the caller decides what a missed barrier means —
 * a failed session for an app-server that never confirmed an interrupt, an
 * error for a wedged bridge.
 *
 * @template T
 * @param {Promise<T>} barrier
 * @param {{ deadlineMs: number, makeFailure: () => Error }} options
 * @returns {Promise<T>}
 */
export const awaitBarrier = async (barrier, { deadlineMs, makeFailure }) => {
  (Number.isFinite(deadlineMs) && deadlineMs > 0) ||
    Fail`awaitBarrier needs a positive deadline`;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeFailure()), deadlineMs);
  });
  try {
    return await Promise.race([barrier, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
harden(awaitBarrier);
