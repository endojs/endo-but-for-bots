// @ts-check

import { Fail } from '@endo/errors';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { passStyleOf, toThrowable } from '@endo/pass-style';

/** @import { PureData, RemotableObject } from '@endo/pass-style' */
/** @import { PassableReader } from '@endo/exo-stream' */

/**
 * Validate pass-by-copy session data without admitting nested capabilities,
 * promises, errors, or accessors. Inspect descriptors before passStyleOf so
 * an ordinary nested accessor is refused without evaluating its getter.
 * This uses the existing pass-style rules for frozen passable containers;
 * it is not a membrane for arbitrary local JavaScript proxies.
 *
 * @type {(value: unknown) => asserts value is PureData}
 */
export const assertCopyData = value => {
  /** @type {unknown[]} */
  const pending = [value];
  /** @type {Set<object>} */
  const objects = new Set();
  while (pending.length !== 0) {
    const next = pending.pop();
    typeof next !== 'function' || Fail`Session protocol requires copy data`;
    if (typeof next !== 'object' || next === null || objects.has(next)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    objects.add(next);
    for (const key of Reflect.ownKeys(next)) {
      const descriptor = Object.getOwnPropertyDescriptor(next, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw Fail`Session protocol copy data cannot contain accessors`;
      }
      pending.push(descriptor.value);
    }
  }
  // Establish passability, including valid container shapes and no cycles.
  passStyleOf(value);
  for (const object of objects) {
    const style = passStyleOf(object);
    style === 'copyRecord' ||
      style === 'copyArray' ||
      style === 'tagged' ||
      style === 'byteArray' ||
      Fail`Session protocol requires copy data, not ${style}`;
  }
};
harden(assertCopyData);

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
