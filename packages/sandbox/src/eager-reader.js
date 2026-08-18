// @ts-check

import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { Fail, makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';

const CAPTURE_BLOCK_SIZE = 64 * 1024;
const STREAM_BUFFER = 8;

/**
 * Eagerly pump a driver-local byte source into one passable reader.
 *
 * The pump starts at process admission, rather than when a remote consumer
 * first pulls. This both preserves output from short-lived processes and lets
 * the supervisor enforce a byte limit even when nobody consumes the reader.
 * Only this adapter sees the driver-local iterator; callers receive the one
 * `PassableBytesReader` capability and cannot accidentally merge stdout and
 * stderr authority.
 *
 * @param {AsyncIterable<Uint8Array> | null | undefined} iterable
 * @param {{ label: 'stdout' | 'stderr', byteLimit: bigint, onFailure: (error: Error) => void }} options
 * @returns {{ reader: object, finished: Promise<void>, close: () => void, iterator: AsyncIterableIterator<Uint8Array> }}
 */
export const makeEagerReader = (iterable, { label, byteLimit, onFailure }) => {
  /** @type {Uint8Array[]} */
  const queue = [];
  /** @type {Uint8Array | undefined} */
  let pendingBlock;
  let pendingLength = 0;
  /** @param {Uint8Array} bytes */
  const enqueueBytes = bytes => {
    let offset = 0;
    while (offset < bytes.length) {
      if (pendingBlock === undefined) {
        pendingBlock = new Uint8Array(CAPTURE_BLOCK_SIZE);
        pendingLength = 0;
      }
      const take = Math.min(
        CAPTURE_BLOCK_SIZE - pendingLength,
        bytes.length - offset,
      );
      pendingBlock.set(bytes.subarray(offset, offset + take), pendingLength);
      pendingLength += take;
      offset += take;
      if (pendingLength === CAPTURE_BLOCK_SIZE) {
        queue.push(pendingBlock);
        pendingBlock = undefined;
      }
    }
  };
  const flushPendingBlock = () => {
    if (pendingBlock !== undefined && pendingLength > 0) {
      queue.push(pendingBlock.slice(0, pendingLength));
      pendingLength = 0;
    }
  };
  let byteCount = 0n;
  let ended = false;
  /** @type {Error | undefined} */
  let failure;
  /** @type {(() => void) | undefined} */
  let wakeWaiter;
  // The single waiter slot makes overlapping pulls unsafe: queueing them
  // would interleave arbitrary halves of one process's output.
  let nextInFlight = false;
  const { promise: finished, resolve: finish } =
    /** @type {import('@endo/promise-kit').PromiseKit<void>} */ (
      makePromiseKit()
    );

  const wake = () => {
    const waiter = wakeWaiter;
    wakeWaiter = undefined;
    if (waiter !== undefined) waiter();
  };

  const close = () => {
    if (!ended) {
      ended = true;
      finish();
    }
    wake();
  };

  if (iterable === undefined || iterable === null) {
    close();
  } else {
    void (async () => {
      await null;
      try {
        for await (const value of iterable) {
          if (ended) return;
          const bytes =
            value instanceof Uint8Array
              ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
              : new Uint8Array(value);
          const remaining = byteLimit - byteCount;
          if (remaining > 0n) {
            const captured =
              BigInt(bytes.length) <= remaining
                ? bytes
                : bytes.subarray(0, Number(remaining));
            enqueueBytes(captured);
            byteCount += BigInt(captured.length);
            wake();
          }
          if (byteCount >= byteLimit) {
            failure = makeError(
              X`sandbox ${label} byte limit reached (${byteLimit})`,
            );
            onFailure(failure);
            close();
            return;
          }
        }
        close();
      } catch (e) {
        failure = makeError(
          X`sandbox ${label} reader failed: ${q(/** @type {Error} */ (e).message)}`,
        );
        onFailure(failure);
        close();
      }
    })();
  }

  /** @type {AsyncIterableIterator<Uint8Array>} */
  const iterator = {
    async next() {
      !nextInFlight ||
        Fail`sandbox ${q(label)} reader is single-consumer: concurrent next() is not supported`;
      nextInFlight = true;
      await null;
      try {
        for (;;) {
          if (queue.length === 0) flushPendingBlock();
          if (queue.length > 0) {
            // The block is fresh, unaliased, and immediately encoded by
            // bytesReaderFromIterator, so freezing every typed-array element
            // would impose a daemon-wide stall without protecting a caller.
            return {
              done: false,
              value: /** @type {Uint8Array} */ (queue.shift()),
            };
          }
          if (failure !== undefined) throw failure;
          if (ended) return harden({ done: true, value: undefined });
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => {
            wakeWaiter = () => resolve(undefined);
          });
        }
      } finally {
        nextInFlight = false;
      }
    },
    async return() {
      close();
      queue.length = 0;
      pendingBlock = undefined;
      pendingLength = 0;
      return harden({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return harden({
    reader: bytesReaderFromIterator(iterator, { buffer: STREAM_BUFFER }),
    finished,
    close,
    iterator,
  });
};
harden(makeEagerReader);
