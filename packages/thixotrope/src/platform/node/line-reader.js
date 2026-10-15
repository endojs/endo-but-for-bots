// @ts-check
/** @import { AsyncQueue, Reader } from '@endo/stream' */
import harden from '@endo/harden';
import { makeQueue } from '@endo/stream';

const done = harden(
  /** @type {IteratorReturnResult<undefined>} */ ({
    done: true,
    value: undefined,
  }),
);

/**
 * The lines a readline interface emits, as a pull-based reader. Lines wait
 * in a queue until read, so a consumer that starts late loses nothing, and
 * concurrent consumers each receive distinct lines in order instead of
 * racing for one wake-up. The reader ends when the interface closes; if
 * `input` failed first, the reader delivers the lines it already had and
 * then throws that failure, to every consumer.
 *
 * `return` is inert: a consumer that stops early leaves the interface to
 * its owner, which closes it when the session is over.
 *
 * @param {import('readline').Interface | undefined} lines the interface,
 *   or nothing for an input that was never opened, whose reader is empty
 * @param {import('events').EventEmitter} [input] the underlying stream,
 *   whose failure also ends the reader
 * @returns {Reader<string>}
 */
export const makeLineReader = (lines, input = undefined) => {
  /** @type {AsyncQueue<IteratorResult<string, undefined>>} */
  const queue = makeQueue();
  /** @type {Error | undefined} */
  let failure;
  let ended = false;
  let settled = false;
  let waiting = 0;
  const end = () => {
    if (ended) return;
    ended = true;
    queue.put(done);
  };
  /** @param {Error} error */
  const fail = error => {
    failure ??= error;
    end();
  };
  if (lines === undefined) {
    end();
  } else {
    lines.on('line', line => queue.put(harden({ done: false, value: line })));
    lines.on('close', end);
    lines.on('error', fail);
    input?.on('error', fail);
  }
  /** @type {Reader<string>} */
  const reader = harden({
    async next() {
      if (!settled) {
        waiting += 1;
        const result = await queue.get();
        waiting -= 1;
        if (!result.done) return result;
        // The first consumer to see the end releases the others, whose
        // gets are queued behind this one and would otherwise wait forever.
        settled = true;
        for (let count = waiting; count > 0; count -= 1) queue.put(done);
      }
      if (failure !== undefined) throw failure;
      return done;
    },
    async return() {
      return done;
    },
    async throw(error) {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return reader;
    },
  });
  return reader;
};
harden(makeLineReader);
