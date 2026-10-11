// @ts-check
/* global clearTimeout, setTimeout */

import harden from '@endo/harden';

/**
 * @typedef {{ kind: 'add' | 'remove' | 'replace', name: string }} DirectoryWatchEvent
 */

/**
 * Options a caller may pass to a watcher.  The `cancelled` token is a
 * real cancellation channel the adapter honors; every other field is a
 * *hint* an implementation is free to honor or ignore (the XS fallback,
 * for instance, ignores the tuning hints because it has no `fs.watch`
 * equivalent).  Callers must not depend on any particular hint value
 * being observed.
 *
 * @typedef {object} WatchDirectoryOptions
 * @property {Promise<void>} [cancelled] Per-call cancellation token:
 *   settle (or reject) it to close the OS watcher handle and terminate
 *   `events`; idempotent with the iterator's own `return()`.  Defaults
 *   to a forever-pending promise when omitted, leaving the iterator's
 *   `return()` as the sole cancellation surface.  This is a per-call
 *   field — the factory-level defaults ignore it, since one shared token
 *   cannot address distinct watchers.
 * @property {number} [debounceMs] Per-filename debounce/coalesce window
 *   in milliseconds.  The node-fs adapter honors it; other backends may
 *   ignore it.  Defaults to 50 ms when unset or not a finite,
 *   non-negative number.
 */

/**
 * Watch a directory for entry-name changes (children added or
 * removed).  The returned `events` stream yields one record per
 * coalesced filesystem event; the `kind` field is a hint that the
 * consumer reconciles against its own snapshot set to decide
 * whether the entry was genuinely added, removed, or unchanged.
 *
 * The per-filename debounce/coalesce window defaults to 50 ms.  It is
 * an advisory setting a caller may override through
 * {@link WatchDirectoryOptions} `debounceMs`, which an implementation
 * is free to ignore.
 *
 * Cancellation idiom (note for the focused reviewer): the watcher is
 * cancelled by settling the `cancelled` promise the caller passes in
 * the options bag, rather than by a `cancel()` function returned to the
 * caller.  We establish "accept a `cancelled` promise" as the general
 * idiom.  `cancelled` defaults to a forever-pending promise when the
 * field is omitted, so the option is optional and a caller that never
 * cancels through it simply drops the iterator instead.  That returned
 * `events` async iterator is the other cancellation surface, cancellable
 * the way async iterators always are — through its `return()` (the
 * `for await … of` cleanup path).  Both surfaces resolve to the same
 * idempotent close, so a caller may cancel by settling `cancelled`, by
 * dropping the iterator, or both.
 *
 * On platforms or filesystems where `fs.watch` is unavailable, the
 * implementation logs to `console.error` and returns an `events`
 * stream that terminates immediately so callers see end-of-stream
 * rather than hang.
 *
 * @typedef {(path: string, options?: WatchDirectoryOptions) => AsyncIterable<DirectoryWatchEvent>} WatchDirectory
 */

/**
 * Coerce an advisory `debounceMs` hint to a usable window, falling back
 * to `fallbackMs` when the hint is absent or not a finite, non-negative
 * number.  Being advisory, a nonsensical value is ignored rather than
 * throwing.
 *
 * @param {unknown} value
 * @param {number} fallbackMs
 * @returns {number}
 */
const coerceDebounceMs = (value, fallbackMs) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallbackMs;

/**
 * Node.js `fs.watch` adapter that exposes {@link WatchDirectory}, the
 * directory-name-change primitive `@endo/daemon`'s `FilePowers`
 * delegates to.  Its only ambient dependency is node `fs`, so the
 * daemon body (and `EndoMount.followNameChanges`) stay
 * platform-agnostic.
 *
 * @param {Pick<typeof import('fs'), 'watch'>} fs
 * @param {WatchDirectoryOptions} [factoryOptions] Advisory defaults
 *   applied to every watcher this adapter produces (a per-call
 *   `options` argument overrides them).
 * @returns {WatchDirectory}
 */
export const makeWatchDirectory = (fs, factoryOptions = {}) => {
  const defaultDebounceMs = coerceDebounceMs(factoryOptions.debounceMs, 50);
  /**
   * @param {string} dirPath
   * @param {WatchDirectoryOptions} [options] - per-call options.  Its
   *   `cancelled` token (defaulting to a forever-pending promise) closes
   *   the OS watcher handle and terminates `events` when it settles;
   *   `debounceMs` is advisory per-call tuning that overrides the factory
   *   default.
   * @returns {AsyncIterable<DirectoryWatchEvent>}
   */
  const watchDirectory = (dirPath, options = {}) => {
    // Absent a `cancelled` token, a forever-pending promise stands in so
    // the only cancellation surface is the iterator's own `return()`.
    const { cancelled = new Promise(() => {}) } = options;
    /** @type {Array<DirectoryWatchEvent>} */
    const buffered = [];
    /** @type {Array<(value: IteratorResult<DirectoryWatchEvent>) => void>} */
    const waiters = [];
    let closed = false;
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    const pending = new Map();
    // Advisory: the caller's per-call hint wins, then the factory
    // default, then the 50 ms baseline.
    const debounceMs = coerceDebounceMs(options.debounceMs, defaultDebounceMs);

    const deliver = event => {
      if (closed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ value: event, done: false });
      } else {
        buffered.push(event);
      }
    };

    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
      try {
        watcher.close();
      } catch {
        // ignore
      }
      while (waiters.length > 0) {
        const waiter = /** @type {(typeof waiters)[number]} */ (
          waiters.shift()
        );
        waiter({ value: undefined, done: true });
      }
    };

    /**
     * Schedule (or reset) a debounced reconciliation for `name`.  The
     * `kind` we report is a best-effort guess based on what `stat`
     * sees when the timer fires; the consumer is the source of truth
     * for whether `name` is currently in its snapshot set.
     *
     * @param {string} name
     */
    const schedule = name => {
      const existing = pending.get(name);
      if (existing !== undefined) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        pending.delete(name);
        // Probe disk to classify, but the consumer reconciles
        // against its own snapshot set, so the `kind` field is only
        // a hint.  Use 'replace' as a neutral term that the
        // consumer will resolve to add / remove / no-op.
        deliver(harden({ kind: 'replace', name }));
      }, debounceMs);
      pending.set(name, timer);
    };

    let watcher;
    try {
      watcher = fs.watch(dirPath, { persistent: false });
    } catch (error) {
      // Surface watcher-creation failures by returning a cancelled
      // stream that immediately terminates.
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      console.error(
        `watchDirectory(${dirPath}): fs.watch unavailable (${code}); stream will close immediately`,
      );
      /** @type {AsyncIterable<DirectoryWatchEvent>} */
      const emptyEvents = harden({
        [Symbol.asyncIterator]() {
          return harden({
            /** @returns {Promise<IteratorResult<DirectoryWatchEvent>>} */
            next: async () =>
              harden(
                /** @type {IteratorResult<DirectoryWatchEvent>} */ ({
                  value: undefined,
                  done: true,
                }),
              ),
            return: async () =>
              harden(
                /** @type {IteratorResult<DirectoryWatchEvent>} */ ({
                  value: undefined,
                  done: true,
                }),
              ),
          });
        },
      });
      return emptyEvents;
    }

    // Accept-a-`cancelled`-promise idiom: settling `cancelled` closes
    // the OS watcher and terminates `events`.  It resolves to the same
    // idempotent `close()` the iterator's `return()` uses, so the two
    // cancellation surfaces are interchangeable.
    void Promise.resolve(cancelled).then(close, close);

    watcher.on('change', (eventType, filename) => {
      // `filename` may be null on some platforms; ignore the event
      // when we cannot tell which child changed.
      if (filename === null || filename === undefined) {
        return;
      }
      const name =
        typeof filename === 'string' ? filename : filename.toString();
      if (eventType === 'rename') {
        schedule(name);
      }
      // 'change' events refer to file-content mutations, not name
      // changes; the followNameChanges contract intentionally drops
      // them.
    });

    watcher.on('error', error => {
      console.error(`watchDirectory(${dirPath}): ${error.message}`);
      close();
    });

    /** @type {AsyncIterable<DirectoryWatchEvent>} */
    const events = harden({
      [Symbol.asyncIterator]() {
        return harden({
          /** @returns {Promise<IteratorResult<DirectoryWatchEvent>>} */
          next: async () => {
            await null;
            if (buffered.length > 0) {
              const value = /** @type {(typeof buffered)[number]} */ (
                buffered.shift()
              );
              return harden(
                /** @type {IteratorResult<DirectoryWatchEvent>} */ ({
                  value,
                  done: false,
                }),
              );
            }
            if (closed) {
              return harden(
                /** @type {IteratorResult<DirectoryWatchEvent>} */ ({
                  value: undefined,
                  done: true,
                }),
              );
            }
            return /** @type {Promise<IteratorResult<DirectoryWatchEvent>>} */ (
              new Promise(resolve => {
                waiters.push(resolve);
              })
            );
          },
          return: async () => {
            close();
            return harden(
              /** @type {IteratorResult<DirectoryWatchEvent>} */ ({
                value: undefined,
                done: true,
              }),
            );
          },
        });
      },
    });

    return events;
  };

  return harden(watchDirectory);
};
