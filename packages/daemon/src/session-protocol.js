// @ts-check

import { Fail } from '@endo/errors';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { passStyleOf, toThrowable } from '@endo/pass-style';

import { assertCopyData } from './copy-data.js';

export { assertCopyData } from './copy-data.js';

/** @import { PureData, RemotableObject } from '@endo/pass-style' */
/** @import { PassableReader } from '@endo/exo-stream' */

/**
 * Keep the source reader inside the administrative boundary. The anonymous
 * outer reader transmits only validated event/terminal data; it never exposes
 * source patterns or the source's promise-chain nodes. Buffering stays at zero.
 *
 * Admission is checked before each pull. Closing remains available after the
 * session fence and interrupts an outstanding pull through the source's stream
 * protocol. Hosted event-stream close carries no application value: an outer
 * return argument is validated but is not forwarded to the source. Source
 * terminal acknowledgements and passable source errors are preserved. Rejected
 * stream-chain values are coerced to throwables, since these nested promises
 * do not pass through an exo's asynchronous method rejection guard.
 *
 * @param {unknown} reader
 * @param {() => void} assertOpen
 * @returns {PassableReader<PureData, PureData> & RemotableObject}
 */
export const wrapSessionReader = (reader, assertOpen) => {
  passStyleOf(reader) === 'remotable' ||
    Fail`Session protocol requires a reader capability`;
  const source = iterateReader(
    /** @type {PassableReader<PureData, PureData>} */ (reader),
    { buffer: 0 },
  );
  /** @type {Promise<IteratorResult<PureData, PureData>> | undefined} */
  let closing;
  const close = () => {
    if (!closing) {
      closing = source
        .return()
        .then(result => {
          assertCopyData(result);
          return result;
        })
        .catch(reason => {
          throw toThrowable(reason);
        });
    }
    return closing;
  };
  const iterator = harden({
    next: async () => {
      assertOpen();
      const result = await source.next().catch(reason => {
        throw toThrowable(reason);
      });
      assertCopyData(result);
      return result;
    },
    return: async (/** @type {PureData} */ value = undefined) => {
      assertCopyData(value);
      return close();
    },
  });
  const outer = readerFromIterator(iterator, {
    buffer: 0,
    cancelPending: async () => {
      await close();
    },
  });
  // readerFromIterator constructs an exo; its structural interface omits the
  // remotable brand needed by a containing exo's return guard.
  return /** @type {typeof outer & RemotableObject} */ (outer);
};
harden(wrapSessionReader);
