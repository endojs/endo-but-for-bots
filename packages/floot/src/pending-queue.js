// @ts-check
// A session's submissions that have been accepted and not yet run.
//
// A message sent while a turn is running used to wait in the browser: the chat
// space held it in component state and dispatched it when the turn ended. It
// was only as durable as the tab — closing it, reloading it, or switching
// session dropped the message while the turn it waited behind carried on — and
// no second view could see it. The daemon owns the turn; it owns what waits
// for the turn too.
//
// The queue is one record in the factory host's pet store, rewritten whole on
// every change (`storeValue` replaces a name in place, so a crash leaves the
// previous record or the next, never part of one). Its text is conversation
// content: it is removed only by the user cancelling it, by the turn journal
// taking it over, or with the session.
//
// Dispatch is at most once. An entry is marked `dispatching` durably before
// its turn is started and removed once the turn journal has recorded the
// input. A daemon that dies in between finds the entry `dispatching` when it
// comes back and cannot know whether the turn reached the backend, so it
// marks it `interrupted` and sends nothing: the user sees it, and sends it
// again or deletes it. While an interrupted entry is at the head, nothing
// behind it runs, so order is preserved.

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';

/**
 * @typedef {'queued' | 'dispatching' | 'interrupted'} PendingState
 * @typedef {{ id: string, text: string, createdAt: number, state: PendingState }} PendingEntry
 */

const STATES = harden(['queued', 'dispatching', 'interrupted']);

// How many messages may wait at once. Not a lifetime count — a session may
// queue any number over its life — but a bound on what is held: the record is
// rewritten whole, and published whole to every viewer, on each change.
const MAX_WAITING = 100;

/** @param {unknown} text */
const assertText = text => {
  (typeof text === 'string' && text.trim().length > 0) ||
    Fail`A queued message must be non-empty text`;
  return /** @type {string} */ (text);
};

/**
 * @param {object} options
 * @param {any} options.host the factory host's pet store
 * @param {string} options.id session id
 * @param {() => number} [options.now]
 * @param {() => void} [options.onChange] runs after every durable change
 */
export const makePendingQueue = ({
  host,
  id,
  now = () => Date.now(),
  onChange = () => {},
}) => {
  /^[A-Za-z0-9_-]{1,128}$/.test(id) || Fail`Invalid session identity`;
  // The length disambiguates ids that are prefixes of other ids. Same naming
  // as the session's other host-side records (network policy, turn journal).
  const name = `floot-pending-${id.length}-${id}`;
  /** @type {PendingEntry[]} */
  let entries = [];
  let nextSequence = 1n;
  let loaded = false;
  let chain = Promise.resolve();

  const changed = () => {
    try {
      onChange();
    } catch (error) {
      console.error('[floot-pending] change observer failed:', error);
    }
  };

  const persist = async () => {
    try {
      if (entries.length === 0) {
        // Nothing waits: no record. A session that never queues never has one.
        if (await E(host).has(name)) await E(host).remove(name);
      } else {
        await E(host).storeValue(
          harden({
            version: 1,
            nextSequence,
            entries: entries.map(entry => ({ ...entry })),
          }),
          name,
        );
      }
    } catch (error) {
      // The store may or may not hold what memory does, so memory is no
      // longer to be trusted: the next operation reads the record again and
      // goes by what was actually written. (A message this incarnation was
      // dispatching reads back as interrupted, which is the truth: whether
      // its bookkeeping landed is exactly what is not known.)
      loaded = false;
      throw error;
    }
  };

  const load = async () => {
    if (loaded) return;
    /** @type {PendingEntry[]} */
    let read = [];
    let readSequence = nextSequence;
    let interrupted = false;
    if (await E(host).has(name)) {
      const stored = await E(host).lookup(name);
      (stored?.version === 1 &&
        Array.isArray(stored.entries) &&
        typeof stored.nextSequence === 'bigint') ||
        Fail`Pending queue record ${q(name)} is corrupt`;
      read = stored.entries.map((/** @type {any} */ entry) => {
        (typeof entry?.id === 'string' &&
          typeof entry.text === 'string' &&
          typeof entry.createdAt === 'number' &&
          STATES.includes(entry.state)) ||
          Fail`Pending queue record ${q(name)} holds a malformed entry`;
        if (entry.state === 'dispatching') interrupted = true;
        return {
          id: entry.id,
          text: entry.text,
          createdAt: entry.createdAt,
          // This incarnation did not start that turn (or no longer knows
          // whether it did), and cannot tell whether it reached the backend.
          state: entry.state === 'dispatching' ? 'interrupted' : entry.state,
        };
      });
      /** @type {bigint} */
      const storedSequence = stored.nextSequence;
      if (storedSequence > readSequence) readSequence = storedSequence;
    }
    entries = read;
    nextSequence = readSequence;
    loaded = true;
    if (interrupted) await persist();
  };

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const ordered = operation => {
    const result = chain.then(async () => {
      await load();
      return operation();
    });
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /**
   * Apply a change to a copy, persist it, and only then adopt it, so memory
   * never runs ahead of the record.
   *
   * @template T
   * @param {(draft: PendingEntry[]) => T} mutate
   * @returns {Promise<T>}
   */
  const commit = async mutate => {
    const previous = entries;
    const draft = entries.map(entry => ({ ...entry }));
    const result = mutate(draft);
    entries = draft;
    try {
      await persist();
    } catch (error) {
      entries = previous;
      throw error;
    }
    changed();
    return result;
  };

  /** @param {PendingEntry} entry */
  const project = entry => harden({ ...entry });

  /**
   * @param {PendingEntry[]} draft
   * @param {string} entryId
   */
  const find = (draft, entryId) => {
    const entry = draft.find(candidate => candidate.id === entryId);
    entry || Fail`No queued message ${q(entryId)}`;
    return /** @type {PendingEntry} */ (entry);
  };

  return harden({
    /** Read the record, so `list()` is meaningful. */
    ready: () => ordered(async () => undefined),
    /** What waits, oldest first. Empty until `ready()` has resolved. */
    list: () => harden(entries.map(project)),
    isLoaded: () => loaded,
    /**
     * @param {string} text
     * @param {{ claim?: boolean }} [options] `claim` marks the entry
     *   `dispatching` in the same write, for a caller about to start its turn;
     *   honoured only when nothing is ahead of it.
     */
    enqueue: (text, { claim = false } = {}) =>
      ordered(async () => {
        const accepted = assertText(text).trim();
        return commit(draft => {
          draft.length < MAX_WAITING ||
            Fail`This session already has ${q(MAX_WAITING)} messages waiting; send or delete some first`;
          const createdAt = now();
          /** @type {PendingEntry} */
          const entry = {
            // The sequence orders entries within a record; the time keeps an
            // id from being reissued after the record has emptied (the
            // sequence goes with it) and the daemon restarted. A view holding
            // a stale id must not be able to cancel someone else's message.
            id: `p${createdAt.toString(36)}-${nextSequence}`,
            text: accepted,
            createdAt,
            state: claim && draft.length === 0 ? 'dispatching' : 'queued',
          };
          nextSequence += 1n;
          draft.push(entry);
          return project(entry);
        });
      }),
    /**
     * Rewrite a message that has not started.
     *
     * @param {string} entryId
     * @param {string} text
     */
    edit: (entryId, text) =>
      ordered(async () => {
        const accepted = assertText(text).trim();
        return commit(draft => {
          const entry = find(draft, entryId);
          entry.state !== 'dispatching' ||
            Fail`Message ${q(entryId)} is already being sent`;
          entry.text = accepted;
          return project(entry);
        });
      }),
    /**
     * Drop a message that has not started. The user's own act.
     *
     * @param {string} entryId
     */
    cancel: entryId =>
      ordered(async () =>
        commit(draft => {
          const index = draft.findIndex(entry => entry.id === entryId);
          if (index < 0) return false;
          draft[index].state !== 'dispatching' ||
            Fail`Message ${q(entryId)} is already being sent`;
          draft.splice(index, 1);
          return true;
        }),
      ),
    /**
     * Take the head for dispatch: durably `dispatching` before its turn is
     * started. Undefined when nothing can run — the queue is empty, the head
     * is already dispatching, or the head is interrupted and awaits the user.
     */
    claim: () =>
      ordered(async () => {
        const head = entries[0];
        if (!head || head.state !== 'queued') return undefined;
        return commit(draft => {
          draft[0].state = 'dispatching';
          return project(draft[0]);
        });
      }),
    /**
     * The turn journal has the input: the queue lets go of it.
     *
     * @param {string} entryId
     */
    complete: entryId =>
      ordered(async () =>
        commit(draft => {
          const index = draft.findIndex(entry => entry.id === entryId);
          if (index >= 0) draft.splice(index, 1);
        }),
      ),
    /**
     * The turn was refused before anything was sent: the message waits again.
     *
     * @param {string} entryId
     */
    release: entryId =>
      ordered(async () =>
        commit(draft => {
          const entry = draft.find(candidate => candidate.id === entryId);
          if (entry && entry.state === 'dispatching') entry.state = 'queued';
        }),
      ),
    /**
     * The user asks for an interrupted message to be sent after all.
     *
     * @param {string} entryId
     */
    retry: entryId =>
      ordered(async () =>
        commit(draft => {
          const entry = find(draft, entryId);
          if (entry.state === 'interrupted') entry.state = 'queued';
          return project(entry);
        }),
      ),
    /**
     * With the session. Does not read the record first: one that cannot be
     * read (corrupt, or written by a later version) must not make its session
     * undeletable.
     */
    destroy: () => {
      const result = chain.then(async () => {
        entries = [];
        loaded = true;
        if (await E(host).has(name)) await E(host).remove(name);
        changed();
      });
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
};
harden(makePendingQueue);
