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
 */

import { makeError, X, b, q } from '@endo/errors';

import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';

/**
 * @param {object} opts
 * @param {string} opts.label  names the write in `E2BIG` errors
 * @param {number} opts.frameByteLengthLimit
 * @param {number} opts.totalByteLengthLimit
 * @param {(bytes: Uint8Array) => Promise<void> | void} opts.commit
 */
export const makeBufferedBytesWriter = ({
  label,
  frameByteLengthLimit,
  totalByteLengthLimit,
  commit,
}) => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  let rejected = false;
  const discard = () => {
    rejected = true;
    chunks.length = 0;
    total = 0;
  };
  const sink = {
    /** @param {Uint8Array} chunk */
    async next(chunk) {
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
      if (rejected) {
        return { done: true, value };
      }
      const merged = new Uint8Array(total);
      let p = 0;
      for (const c of chunks) {
        merged.set(c, p);
        p += c.length;
      }
      chunks.length = 0;
      await commit(merged);
      return { done: true, value };
    },
    // The pump calls `throw()` when it aborts the stream (a rejected frame or
    // a broken initiator). Discard the buffered frames so an aborted write
    // commits nothing.
    async throw() {
      discard();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return sink;
    },
  };
  return bytesWriterFromIterator(sink, {
    byteLengthLimit: frameByteLengthLimit,
  });
};
harden(makeBufferedBytesWriter);
