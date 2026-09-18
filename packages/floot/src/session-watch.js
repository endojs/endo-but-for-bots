// @ts-check
// Subscriptions on a session's state, and on the factory's session list.
//
// A view used to learn what a session was doing by asking again: the chat
// space re-read the transcript, the execution state and the network policy
// every three seconds, and never re-read the session list at all. Anything the
// daemon did on its own — a mail turn, a queued message it dispatched, a
// network request the model raised, a second browser — reached the screen late
// or not at all.
//
// Here the daemon says when something changed. `watch()` hands out a disposable
// stream, the same shape as a turn's (`session-turn.js`): a `snapshot` of the
// state as of the moment the view opened, then an event per change. Closing the
// stream detaches that viewer and nothing else.
//
// The model is state synchronisation, not an event log. The hub holds what it
// last told its viewers; a `touch` schedules a `sync`, and a sync recomputes
// the state and publishes only what differs. Every sync and every open runs on
// one chain, so:
//
// - a snapshot is built in the same synchronous step that registers the view,
//   and no change can fall between them;
// - several touches collapse into one sync, and a sync always publishes the
//   state as it is when it runs, never a stale value it was scheduled with;
// - the transcript is refreshed before the turn that produced it is reported
//   finished, so a reply never blinks out between the two.
//
// What a hub retains is bounded by the state itself: the last published values,
// and the transcript only while someone is watching. A viewer's channel holds
// what that viewer has not taken yet (exo-stream drops delivered events), and
// a reader that is handed out and never opened is closed after two minutes.
// A read that fails or never answers leaves its part dirty and is retried with
// backoff while someone is watching; it never stops the parts that can be read.

import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

/** @import { BufferedReaderKit } from '@endo/exo-stream' */

// History metadata passes through unfiltered, so a bigint may one day ride in
// it; `JSON.stringify` throws on one, and a throw here would stop a sync.
const canonical = value =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? `${item}n` : item,
  );
const sameData = (left, right) =>
  left === right || canonical(left) === canonical(right);

// A load that never answers must not stop every later event. These are well
// past anything a healthy read takes; a read that exceeds one is treated as
// failed, stays dirty, and is tried again.
const TRANSCRIPT_LOAD_MS = 30_000;
const SMALL_LOAD_MS = 20_000;
// A failed load is retried on its own while someone is watching.
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 60_000;
// A reader handed out and never opened has no close watcher; it is dropped.
const UNOPENED_VIEW_MS = 120_000;

/**
 * @typedef {{
 *   setTimeout: (fn: () => void, ms: number) => unknown,
 *   clearTimeout: (handle: any) => void,
 * }} Timers
 */
/** @type {Timers} */
const defaultTimers = harden({
  setTimeout: (fn, ms) => {
    const handle = globalThis.setTimeout(fn, ms);
    // None of these timers is a reason to keep a process alive.
    if (typeof handle === 'object' && handle && 'unref' in handle) {
      /** @type {{ unref: () => void }} */ (handle).unref();
    }
    return handle;
  },
  clearTimeout: handle => globalThis.clearTimeout(handle),
});

// Errors `within` raised because a deadline passed, as opposed to the read
// itself failing: a read that hangs is not worth trying again on every change.
/** @type {WeakSet<object>} */
const deadlineErrors = new WeakSet();

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @param {Timers} timers
 * @returns {Promise<T>}
 */
const within = (promise, ms, what, timers) =>
  new Promise((resolve, reject) => {
    const handle = timers.setTimeout(() => {
      const error = Error(`${what} did not answer within ${ms / 1000}s`);
      deadlineErrors.add(error);
      reject(error);
    }, ms);
    promise.then(
      value => {
        timers.clearTimeout(handle);
        resolve(value);
      },
      error => {
        timers.clearTimeout(handle);
        reject(error);
      },
    );
  });

/**
 * How to turn one transcript into another: keep the first `keep` messages and
 * append the rest. A finished turn appends; a resolution rewrites the tail.
 *
 * @param {readonly unknown[]} previous
 * @param {readonly unknown[]} next
 * @returns {{ keep: number, append: unknown[] }}
 */
export const diffTranscript = (previous, next) => {
  const limit = Math.min(previous.length, next.length);
  let keep = 0;
  while (keep < limit && sameData(previous[keep], next[keep])) keep += 1;
  return harden({ keep, append: next.slice(keep) });
};
harden(diffTranscript);

/**
 * Apply a transcript event to the messages a viewer holds. Returns undefined
 * when the event does not follow from what the viewer has (a gap), which means
 * the viewer must reopen its view rather than guess.
 *
 * @param {{ version: number, messages: readonly unknown[] } | null} held
 * @param {{ version: number, base: number, keep: number, append: readonly unknown[] }} event
 * @returns {{ version: number, messages: unknown[] } | undefined}
 */
export const applyTranscript = (held, event) => {
  if (!held) {
    if (event.base !== 0 || event.keep !== 0) return undefined;
    return { version: event.version, messages: [...event.append] };
  }
  if (event.version <= held.version)
    return { ...held, messages: [...held.messages] };
  if (event.base !== held.version || event.keep > held.messages.length)
    return undefined;
  return {
    version: event.version,
    messages: [...held.messages.slice(0, event.keep), ...event.append],
  };
};
harden(applyTranscript);

/**
 * The viewers of one subject.
 *
 * @param {Timers} timers
 * @param {() => void} [onEmpty] runs when the last viewer leaves
 */
const makeViewers = (timers, onEmpty = () => {}) => {
  /** @type {Set<BufferedReaderKit>} */
  const views = new Set();
  let ended = false;
  /** @param {BufferedReaderKit} view */
  /** @type {Map<BufferedReaderKit, unknown>} */
  const reapers = new Map();
  const drop = view => {
    if (!views.delete(view)) return;
    timers.clearTimeout(reapers.get(view));
    reapers.delete(view);
    if (views.size === 0) onEmpty();
  };
  return harden({
    /** @param {unknown} first the snapshot event */
    open(first) {
      const view = makeBufferedReader();
      view.push(harden(first));
      if (ended) {
        view.push(harden({ type: 'end' }));
        return view.reader;
      }
      views.add(view);
      view.setOnClose(() => drop(view));
      // Until the consumer calls `stream()` nothing notices it going away: a
      // tab closed between receiving the reader and opening it would stay a
      // viewer for ever, keeping the transcript held and its buffer growing.
      reapers.set(
        view,
        timers.setTimeout(() => {
          reapers.delete(view);
          if (!view.isStarted()) view.close();
        }, UNOPENED_VIEW_MS),
      );
      return view.reader;
    },
    /** @param {unknown} event */
    publish(event) {
      const hardened = harden(event);
      for (const view of [...views]) view.push(hardened);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const view of [...views]) view.push(harden({ type: 'end' }));
      for (const handle of reapers.values()) timers.clearTimeout(handle);
      reapers.clear();
      views.clear();
    },
    size: () => views.size,
    isEnded: () => ended,
  });
};

/**
 * One chain on which every sync and every open runs. `schedule` collapses
 * requests made while one is already waiting its turn.
 *
 * @param {() => Promise<void>} sync
 */
const makeSyncChain = sync => {
  let chain = Promise.resolve();
  let queued = false;
  /**
   * @template T
   * @param {() => Promise<T> | T} step
   * @returns {Promise<T>}
   */
  const run = step => {
    const result = chain.then(step);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return harden({
    run,
    schedule() {
      if (queued) return;
      queued = true;
      void run(async () => {
        queued = false;
        await sync();
      }).catch(() => undefined);
    },
  });
};

/**
 * @typedef {object} SessionWatchSources
 * @property {() => Promise<readonly unknown[]>} loadTranscript the settled
 *   transcript: every turn that has ended, none that is still running
 * @property {() => unknown} readTurn the UI turn in flight, or null. Compared
 *   by identity, so return the same record for the same turn.
 * @property {() => unknown} readRunning what the agent is running right now,
 *   whoever started it (`{ input, from? }`), or null. A mail turn has no
 *   FlootTurn to watch; this is how a view knows one is under way.
 * @property {() => unknown} readPending queued submissions, as plain data
 * @property {() => unknown} readExecution execution state, as plain data
 * @property {() => Promise<unknown>} loadNetwork network policy projection
 * @property {() => Promise<unknown>} loadUsage cumulative token usage
 * @property {Timers} [timers]
 */

/**
 * Events: `snapshot` (every field below at once), `transcript`
 * (`{ version, base, keep, append }`), `transcript-error` (`{ message }`: the
 * transcript could not be read; it is retried, and what the viewer holds
 * stands), `turn` (`{ turn }`, null when none), `running` (`{ running }`),
 * `pending` (`{ pending }`), `execution` (`{ execution }`), `network`
 * (`{ network }`), `usage` (`{ usage }`), `journal` (`{ version }`: turn
 * records changed, re-read them if you show them) and `end` (the session is
 * gone).
 *
 * @param {SessionWatchSources} sources
 */
export const makeSessionWatch = ({
  loadTranscript,
  readTurn,
  readRunning,
  readPending,
  readExecution,
  loadNetwork,
  loadUsage,
  timers = defaultTimers,
}) => {
  /** @type {{ version: number, messages: readonly unknown[] } | null} */
  let transcript = null;
  let transcriptVersion = 0;
  let transcriptError = '';
  let transcriptDirty = true;
  // After a failed read, not tried again until the retry timer says so: a
  // read that hangs would otherwise hold every sync to its deadline.
  let transcriptSuspended = false;
  // The last read ran out its deadline rather than failing. A busy session
  // touches the transcript at every turn; letting each touch retry a read that
  // hangs would hold the chain to the deadline every time.
  let transcriptHung = false;
  /** @type {unknown} */
  let turn = null;
  /** @type {unknown} */
  let running = null;
  /** @type {unknown} */
  let pending = null;
  /** @type {unknown} */
  let execution = null;
  let journalVersion = 0;
  let journalDirty = false;
  // `watch()` calls that are loading and have not registered their view yet.
  // A change during one must still be synced, and the transcript it loaded
  // must not be dropped because some other viewer happened to leave.
  let opening = 0;
  let retryMs = RETRY_FIRST_MS;
  /** @type {unknown} */
  let retryHandle;

  const watched = () => opening > 0;
  const dropTranscript = () => {
    transcript = null;
    transcriptDirty = true;
  };
  const viewers = makeViewers(timers, () => {
    // Nobody is watching: the transcript is the only large thing held here.
    if (!watched()) dropTranscript();
  });
  const active = () => viewers.size() > 0 || watched();

  /** @type {{ schedule: () => void, run: <T>(step: () => Promise<T> | T) => Promise<T> }} */
  // eslint-disable-next-line prefer-const
  let chain;
  /** @type {Array<() => void>} */
  const resumptions = [];
  const scheduleRetry = () => {
    if (retryHandle !== undefined) return;
    retryHandle = timers.setTimeout(() => {
      retryHandle = undefined;
      transcriptSuspended = false;
      transcriptHung = false;
      for (const resume of resumptions) resume();
      if (active()) chain.schedule();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  /**
   * A small value read on its own, off the chain: nothing orders it against
   * the rest, and a read that hangs (the network policy queues behind a policy
   * change in progress) must not hold up a turn event. Its result is published
   * when it arrives; a snapshot takes whatever is held at that moment.
   *
   * @param {() => Promise<unknown>} load
   * @param {string} what
   * @param {(value: unknown) => object} toEvent
   */
  const makeDetached = (load, what, toEvent) => {
    /** @type {unknown} */
    let value = null;
    let loaded = false;
    let isDirty = true;
    let suspended = false;
    /** @type {Promise<void> | null} */
    let inFlight = null;
    const start = () => {
      if (inFlight || suspended || !isDirty || !active()) return;
      // Cleared before the read: a touch during it sets it again, and the
      // read is run once more when this one returns.
      isDirty = false;
      inFlight = within(
        Promise.resolve().then(load),
        SMALL_LOAD_MS,
        what,
        timers,
      )
        .then(
          next => {
            retryMs = RETRY_FIRST_MS;
            if (!loaded || !sameData(next, value)) {
              value = next;
              loaded = true;
              viewers.publish(toEvent(value));
            }
          },
          () => {
            isDirty = true;
            suspended = true;
            scheduleRetry();
          },
        )
        .catch(error => {
          console.error(`[floot-watch] publishing ${what} failed:`, error);
        })
        .finally(() => {
          inFlight = null;
          start();
        });
    };
    resumptions.push(() => {
      suspended = false;
      start();
    });
    return harden({
      touch() {
        isDirty = true;
        start();
      },
      start,
      /**
       * Settles once there is a value to put in a snapshot, or the first read
       * has failed or run out its deadline. Never waits for a re-read: a later
       * viewer takes what is held.
       */
      firstLoad: async () => {
        start();
        if (!loaded && inFlight) await inFlight;
      },
      value: () => (loaded ? value : null),
    });
  };
  const networkValue = makeDetached(
    loadNetwork,
    'The network policy',
    value => ({
      type: 'network',
      network: value,
    }),
  );
  const usageValue = makeDetached(loadUsage, 'Usage', value => ({
    type: 'usage',
    usage: value,
  }));

  // Nothing orders these against the transcript, so they are also published
  // before it is read: an emergency stop must not wait out a slow read.
  const publishUnordered = () => {
    const nextPending = readPending();
    if (!sameData(nextPending, pending)) {
      pending = nextPending;
      viewers.publish({ type: 'pending', pending });
    }
    const nextExecution = readExecution();
    if (!sameData(nextExecution, execution)) {
      execution = nextExecution;
      viewers.publish({ type: 'execution', execution });
    }
  };

  const refresh = async () => {
    publishUnordered();
    if ((transcriptDirty || !transcript) && !transcriptSuspended) {
      // Cleared before the read, not after: a change that lands while the
      // read is in flight sets it again, and the sync queued behind this one
      // must find it set. Cleared afterwards, that change was lost for good.
      transcriptDirty = false;
      try {
        const messages = await within(
          Promise.resolve().then(loadTranscript),
          TRANSCRIPT_LOAD_MS,
          'The transcript',
          timers,
        );
        const previous = transcript;
        const delta = diffTranscript(
          previous ? previous.messages : [],
          messages,
        );
        const changed =
          !previous ||
          delta.append.length > 0 ||
          delta.keep !== previous.messages.length;
        if (changed) {
          transcriptVersion += 1;
          transcript = { version: transcriptVersion, messages };
          // With no previous transcript every viewer holds none (it is dropped
          // only when nobody is watching, and otherwise absent because no read
          // has succeeded yet), so base 0 is what they can all apply.
          viewers.publish({
            type: 'transcript',
            version: transcriptVersion,
            base: previous ? previous.version : 0,
            ...delta,
          });
        }
        transcriptError = '';
        retryMs = RETRY_FIRST_MS;
      } catch (error) {
        transcriptDirty = true;
        transcriptSuspended = true;
        transcriptHung = deadlineErrors.has(/** @type {object} */ (error));
        scheduleRetry();
        const message = error instanceof Error ? error.message : String(error);
        if (message !== transcriptError) {
          transcriptError = message;
          viewers.publish({ type: 'transcript-error', message });
        }
      }
    }
    // The synchronous reads come after the await, so what is published (and
    // what a snapshot is built from, in the same step) is the state as it is
    // now rather than as it was before the transcript was read. The turn and
    // what is running come only after it: a turn is reported gone once the
    // transcript that contains it has been.
    const nextTurn = readTurn();
    if (nextTurn !== turn) {
      turn = nextTurn;
      viewers.publish({ type: 'turn', turn });
    }
    const nextRunning = readRunning();
    if (!sameData(nextRunning, running)) {
      running = nextRunning;
      viewers.publish({ type: 'running', running });
    }
    publishUnordered();
    if (journalDirty) {
      journalDirty = false;
      journalVersion += 1;
      viewers.publish({ type: 'journal', version: journalVersion });
    }
  };

  chain = makeSyncChain(async () => {
    if (viewers.isEnded() || !active()) return;
    await refresh();
    // The last viewer may have left while the transcript was loading.
    if (!active()) dropTranscript();
  });

  return harden({
    /**
     * Something changed. Name what, so a sync does not re-read a transcript
     * because a policy request arrived.
     *
     * @param {'transcript' | 'network' | 'usage' | 'journal'} [kind]
     */
    touch(kind) {
      if (kind === 'network') {
        networkValue.touch();
        return;
      }
      if (kind === 'usage') {
        usageValue.touch();
        return;
      }
      if (kind === 'transcript') {
        transcriptDirty = true;
        // Asked for by name: a read that failed is worth trying now rather
        // than at the next retry. One that hung is not.
        if (!transcriptHung) transcriptSuspended = false;
      }
      if (kind === 'journal') journalDirty = true;
      if (active()) chain.schedule();
    },
    /** @returns {Promise<object>} a Far StreamReader */
    watch: () => {
      opening += 1;
      // A first viewer waits for the small values (to their deadline at most)
      // before it takes its place on the chain, so that wait holds up nobody
      // else's events; later viewers take what is held.
      return Promise.all([networkValue.firstLoad(), usageValue.firstLoad()])
        .then(() =>
          chain.run(async () => {
            await refresh();
            // No await between reading the state and registering the view.
            return viewers.open({
              type: 'snapshot',
              transcript: transcript
                ? {
                    version: transcript.version,
                    base: 0,
                    keep: 0,
                    append: transcript.messages,
                  }
                : null,
              ...(transcriptError ? { transcriptError } : {}),
              turn,
              running,
              pending,
              execution,
              network: networkValue.value(),
              usage: usageValue.value(),
              journalVersion,
            });
          }),
        )
        .finally(() => {
          opening -= 1;
          if (!active()) dropTranscript();
        });
    },
    end: () => viewers.end(),
    viewers: () => viewers.size(),
  });
};
harden(makeSessionWatch);

/**
 * The factory's session list. Events: `snapshot` (`{ sessions }`), `session`
 * (`{ session }`: added or changed) and `removed` (`{ id }`).
 *
 * @param {() => Promise<ReadonlyArray<{ id: string }>>} loadSessions
 * @param {Timers} [timers]
 */
export const makeSessionListWatch = (loadSessions, timers = defaultTimers) => {
  /** @type {Map<string, { id: string }>} */
  let published = new Map();
  let opening = 0;
  let stale = false;
  let retryMs = RETRY_FIRST_MS;
  /** @type {unknown} */
  let retryHandle;
  const viewers = makeViewers(timers, () => {
    if (opening === 0) published = new Map();
  });
  /** @type {{ schedule: () => void, run: <T>(step: () => Promise<T> | T) => Promise<T> }} */
  // eslint-disable-next-line prefer-const
  let chain;
  const refresh = async () => {
    stale = false;
    let sessions;
    try {
      sessions = await within(
        Promise.resolve(loadSessions()),
        SMALL_LOAD_MS,
        'The session list',
        timers,
      );
    } catch (error) {
      // What viewers hold stands; the change that prompted this is not lost.
      stale = true;
      if (retryHandle === undefined) {
        retryHandle = timers.setTimeout(() => {
          retryHandle = undefined;
          if (viewers.size() > 0 || opening > 0) chain.schedule();
        }, retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
      throw error;
    }
    retryMs = RETRY_FIRST_MS;
    const next = new Map();
    for (const session of sessions) next.set(session.id, session);
    for (const id of published.keys()) {
      if (!next.has(id)) viewers.publish({ type: 'removed', id });
    }
    for (const [id, session] of next) {
      if (!sameData(published.get(id), session)) {
        viewers.publish({ type: 'session', session });
      }
    }
    published = next;
  };
  chain = makeSyncChain(async () => {
    if (viewers.size() === 0 && opening === 0) return;
    await refresh();
    if (viewers.size() === 0 && opening === 0) published = new Map();
  });
  return harden({
    touch() {
      if (viewers.size() > 0 || opening > 0) chain.schedule();
    },
    /** @returns {Promise<object>} a Far StreamReader */
    watch: () => {
      opening += 1;
      return chain
        .run(async () => {
          // A viewer cannot be opened on a list that could not be read.
          await refresh();
          return viewers.open({
            type: 'snapshot',
            sessions: [...published.values()],
          });
        })
        .finally(() => {
          opening -= 1;
          if (viewers.size() === 0 && opening === 0) published = new Map();
        });
    },
    viewers: () => viewers.size(),
    isStale: () => stale,
  });
};
harden(makeSessionListWatch);
