// @ts-check

// Node.js sockets and other readable streams reject a pending `reader.next()`
// with an error when they are destroyed rather than ended. For a consumer that
// treats a torn-down stream as an orderly end-of-input, that rejection is noise
// this adapter converts into a clean `{ done: true }`.

import harden from '@endo/harden';

/**
 * The `code` a destroyed Node.js stream rejects a pending read with. Destroying
 * a socket (which an explicit shutdown does, and which a peer crash produces)
 * rejects any in-flight `reader.next()` with this code; a destroyed socket *is*
 * a closed stream, so a consumer that wants an orderly end observes one instead
 * of catching a stray throw.
 */
export const defaultGracefulCodes = harden(['ERR_STREAM_PREMATURE_CLOSE']);

/**
 * Wrap a reader so an abrupt underlying teardown surfaces as a clean
 * end-of-stream (`{ done: true }`) instead of a rejection. Any error whose
 * `code` is in `gracefulCodes` is treated as an orderly end; every other error
 * still propagates.
 *
 * A gracefully handled teardown yields `{ value: undefined, done: true }`, so
 * the wrapped reader's return type is `undefined`.
 *
 * @template TRead
 * @param {import('@endo/stream').Reader<TRead>} reader
 * @param {object} [options]
 * @param {Iterable<string>} [options.gracefulCodes] - Error `code` values to
 *   treat as an orderly end-of-stream. Defaults to `defaultGracefulCodes`
 *   (`ERR_STREAM_PREMATURE_CLOSE`).
 * @returns {import('@endo/stream').Reader<TRead>}
 */
export const makeGracefulReader = (
  reader,
  { gracefulCodes = defaultGracefulCodes } = {},
) => {
  const codes = new Set(gracefulCodes);
  /** @type {import('@endo/stream').Reader<TRead>} */
  const graceful = {
    next: async value => {
      await null;
      try {
        return await reader.next(value);
      } catch (err) {
        if (
          err != null &&
          codes.has(/** @type {{ code?: string }} */ (err).code ?? '')
        ) {
          return harden({ value: undefined, done: true });
        }
        throw err;
      }
    },
    return: value => reader.return(value),
    throw: err => reader.throw(err),
    [Symbol.asyncIterator]: () => graceful,
  };
  return harden(graceful);
};
harden(makeGracefulReader);
