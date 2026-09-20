// @ts-check

import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

/**
 * A value that changes, for readers who want the newest and not the history.
 *
 * `watch()` hands out an exo-stream reader: the current value at once when
 * there is one, then each later value, **coalesced** — a reader that is slow
 * or away gets the latest value when it next asks, not every value it missed.
 * So nothing accumulates per reader, whatever the rate of publication.
 *
 * What is retained is one value and one small record per open reader. Readers
 * are bounded: past `maxWatchers` the oldest is closed, because a remote
 * reader that went away without saying so cannot be told from a quiet one.
 * A closed reader's stream ends; a view subscribes again, as it does after a
 * restart.
 *
 * @template T
 * @param {object} [options]
 * @param {number} [options.maxWatchers]
 */
export const makeLatestTopic = ({ maxWatchers = 64 } = {}) => {
  (Number.isSafeInteger(maxWatchers) && maxWatchers > 0) ||
    assert.fail('maxWatchers must be a positive whole number');
  /** @type {T | undefined} */
  let value;
  let version = 0;
  /**
   * @typedef {object} Watcher
   * @property {number} seen
   * @property {boolean} closed
   * @property {Array<(result: IteratorResult<T, undefined>) => void>} pending
   */
  /** @type {Set<Watcher>} */
  const watchers = new Set();
  let closed = false;

  /** @param {Watcher} watcher */
  const closeWatcher = watcher => {
    watcher.closed = true;
    watchers.delete(watcher);
    for (const resolve of watcher.pending.splice(0)) {
      resolve(harden({ done: true, value: undefined }));
    }
  };

  /** @param {Watcher} watcher */
  const deliver = watcher => {
    // One waiting `next()` gets the new value; any others it queued keep
    // waiting for the one after.
    const resolve = watcher.pending.shift();
    if (resolve === undefined) return;
    watcher.seen = version;
    resolve(harden({ done: false, value: /** @type {T} */ (value) }));
  };

  /** @param {T} next */
  const publish = next => {
    if (closed) return;
    value = next;
    version += 1;
    for (const watcher of [...watchers]) deliver(watcher);
  };

  const watch = () => {
    /** @type {Watcher} */
    const watcher = { seen: 0, closed, pending: [] };
    if (!closed) watchers.add(watcher);
    while (watchers.size > maxWatchers) {
      const [oldest] = watchers;
      closeWatcher(oldest);
    }
    const iterator = harden({
      next: () => {
        if (watcher.closed) {
          return Promise.resolve(harden({ done: true, value: undefined }));
        }
        if (version > watcher.seen) {
          watcher.seen = version;
          return Promise.resolve(
            harden({ done: false, value: /** @type {T} */ (value) }),
          );
        }
        return new Promise(resolve => {
          watcher.pending.push(resolve);
        });
      },
      return: () => {
        closeWatcher(watcher);
        return Promise.resolve(harden({ done: true, value: undefined }));
      },
      [Symbol.asyncIterator]: () => iterator,
    });
    // A reader that closes while a `next()` is parked must not wait for the
    // next publication, which on a quiet daemon may never come: without this
    // hook the pump waits for the pending pull, and a page that went away
    // would leave its watcher behind.
    return readerFromIterator(/** @type {any} */ (iterator), {
      cancelPending: () => closeWatcher(watcher),
    });
  };

  const close = () => {
    closed = true;
    for (const watcher of [...watchers]) closeWatcher(watcher);
  };

  return harden({
    publish,
    watch,
    close,
    current: () => value,
    watcherCount: () => watchers.size,
  });
};
harden(makeLatestTopic);
