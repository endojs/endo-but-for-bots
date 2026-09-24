// @ts-check
/**
 * A `PassableBytesWriter` whose sink buffers every frame and commits the
 * concatenated bytes once, in `return()`.
 *
 * The file-write sinks (`OpenFile.write`, `File.write`) and `Xattrs.set` all
 * share this shape. The helper owns the three rules they must agree on:
 *
 * - each frame is bounded by `frameByteLengthLimit` (the writer's per-frame
 *   check),
 * - the running total is bounded by `totalByteLengthLimit`, so many in-limit
 *   frames cannot grow the buffer without bound before `return()`,
 * - `throw()` (the pump's abort) and an over-limit frame discard the buffer,
 *   so an aborted write commits nothing, while `return()` commits.
 *
 * Each `stream()` call gets its own buffer and running total. So a second
 * write on the same writer starts empty instead of inheriting the first
 * one's state. Two holders that stream at once also cannot interleave frames
 * or discard each other's buffer. A sink latches after its first terminal
 * `return()` or `throw()`, so it never commits twice.
 */

import { makeError, X, b, q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';
import { PassableBytesWriterInterface } from '@endo/exo-stream/type-guards.js';

/** @import { PassableBytesWriter } from '@endo/exo-stream' */

/**
 * @param {object} opts
 * @param {string} opts.label  names the write in `E2BIG` errors
 * @param {number} opts.frameByteLengthLimit
 * @param {number} opts.totalByteLengthLimit
 * @param {(bytes: Uint8Array) => Promise<void> | void} opts.commit
 */
/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {number} opts.totalByteLengthLimit
 * @param {(bytes: Uint8Array) => Promise<void> | void} opts.commit
 */
const makeBufferingSink = ({ label, totalByteLengthLimit, commit }) => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  let rejected = false;
  let settled = false;
  const discard = () => {
    rejected = true;
    chunks.length = 0;
    total = 0;
  };
  const sink = {
    /** @param {Uint8Array} chunk */
    async next(chunk) {
      if (settled) {
        throw makeError(X`${b(label)} already closed`);
      }
      if (rejected) {
        throw makeError(X`E2BIG: ${b(label)} already rejected`);
      }
      if (chunk instanceof Uint8Array && chunk.length !== 0) {
        if (total + chunk.length > totalByteLengthLimit) {
          discard();
          throw makeError(
            X`E2BIG: ${b(label)} exceeds ${q(totalByteLengthLimit)} bytes`,
          );
        }
        chunks.push(chunk);
        total += chunk.length;
      }
      return { done: false, value: undefined };
    },
    async return(value) {
      if (settled || rejected) {
        settled = true;
        return { done: true, value };
      }
      settled = true;
      const merged = new Uint8Array(total);
      let p = 0;
      for (const c of chunks) {
        merged.set(c, p);
        p += c.length;
      }
      chunks.length = 0;
      total = 0;
      await commit(merged);
      return { done: true, value };
    },
    // The pump calls `throw()` when it aborts the stream (a rejected frame or
    // a broken initiator). Discard the buffered frames so an aborted write
    // commits nothing.
    async throw() {
      settled = true;
      discard();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return sink;
    },
  };
  return sink;
};

/**
 * @param {object} opts
 * @param {string} opts.label  names the write in `E2BIG` errors
 * @param {number} opts.frameByteLengthLimit
 * @param {number} opts.totalByteLengthLimit
 * @param {(bytes: Uint8Array) => Promise<void> | void} opts.commit
 * @returns {PassableBytesWriter}
 */
export const makeBufferedBytesWriter = ({
  label,
  frameByteLengthLimit,
  totalByteLengthLimit,
  commit,
}) =>
  /** @type {PassableBytesWriter} */ (
    /** @type {unknown} */ (
      makeExo('PassableBytesWriter', PassableBytesWriterInterface, {
        /** @param {any} synPromise */
        stream(synPromise) {
          const writer = bytesWriterFromIterator(
            makeBufferingSink({ label, totalByteLengthLimit, commit }),
            { byteLengthLimit: frameByteLengthLimit },
          );
          return writer.stream(synPromise);
        },
        writeReturnPattern() {
          return undefined;
        },
      })
    )
  );
harden(makeBufferedBytesWriter);
