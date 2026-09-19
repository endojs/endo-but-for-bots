// @ts-check
// A stand-in for the Floot daemon, for component tests.
//
// The chat space no longer drives a conversation; it subscribes to one. A fake
// that only answered `getHistory()` would exercise none of that, so this one
// is built from the daemon's own parts — the subscription hub, the durable
// queue and the pump that runs it — with a turn the test finishes by hand in
// place of a model. What the component is tested against is therefore the
// protocol the daemon really speaks, not a guess at it.

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import harden from '@endo/harden';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

// A dev dependency only: the space itself never imports Floot, it talks to it.
import {
  makeSessionListWatch,
  makeSessionWatch,
} from '@endo/floot/src/session-watch.js';
import { makePendingQueue } from '@endo/floot/src/pending-queue.js';
import { makeSessionSubmissions } from '@endo/floot/src/session-submissions.js';

/**
 * A subscription that says one thing and then nothing: for a test whose fake
 * session never changes on its own.
 *
 * @param {() => unknown} snapshot
 */
const staticStream = snapshot => {
  const view = makeBufferedReader();
  view.push(harden(snapshot()));
  return view.reader;
};

/**
 * `watch()` for a hand-written fake session facet: a snapshot assembled from
 * the facet's own getters, and no events after it.
 *
 * @param {Record<string, (...args: any[]) => any>} methods
 */
export const staticSessionWatch = methods => async () => {
  const history = methods.getHistory ? await methods.getHistory() : [];
  const current = methods.getCurrentTurn
    ? await methods.getCurrentTurn()
    : null;
  let execution = null;
  if (methods.getExecutionState) {
    execution = await Promise.resolve(methods.getExecutionState()).catch(
      () => null,
    );
  }
  let network = null;
  if (methods.getNetworkPolicy) {
    network = await Promise.resolve(methods.getNetworkPolicy()).catch(
      () => null,
    );
  }
  return staticStream(() => ({
    type: 'snapshot',
    transcript: { version: 1, base: 0, keep: 0, append: history },
    turn: current ? { input: current.input, turn: current.turn } : null,
    running: null,
    pending: { entries: [], hold: null },
    execution,
    network,
    usage: methods.getUsage ? methods.getUsage() : null,
    journalVersion: 0,
  }));
};
harden(staticSessionWatch);

/**
 * `watchSessions()` for a hand-written fake factory.
 *
 * @param {() => unknown} listSessions
 */
export const staticSessionListWatch = listSessions => async () => {
  const sessions = await listSessions();
  return staticStream(() => ({ type: 'snapshot', sessions }));
};
harden(staticSessionListWatch);

/**
 * @typedef {{ id: string, text: string, pendingId?: string,
 *   channel: ReturnType<typeof makeBufferedReader>, ref: object,
 *   begin: () => Promise<void> }} FakeTurn
 */

/**
 * A daemon with `count` sessions, `s0`, `s1`, ….
 *
 * @param {object} [options]
 * @param {number} [options.count]
 * @param {(turn: FakeTurn) => unknown} [options.turnStatus] what a turn's
 *   `watch()` snapshot reports
 * @param {boolean} [options.autoBegin] whether a turn's input is journaled the
 *   moment it starts (true), or when the test calls `turn.begin()`
 */
export const makeFakeDaemon = ({
  count = 2,
  turnStatus = () => undefined,
  autoBegin = true,
} = {}) => {
  /** @type {Map<string, unknown>} */
  const store = new Map();
  const host = Far('FakeHost', {
    has: name => store.has(name),
    lookup: name => store.get(name),
    storeValue: (value, name) => {
      store.set(name, value);
    },
    remove: name => {
      store.delete(name);
    },
  });

  /** @type {Array<{ id: string, title: string, createdAt: number, lifecycle?: string }>} */
  let sessions = Array.from({ length: count }, (_value, index) => ({
    id: `s${index}`,
    title: `Session ${index}`,
    createdAt: count - index,
  }));
  /** @type {FakeTurn[]} */
  const turns = [];
  /** @type {string[]} */
  const deleted = [];
  /** @type {any[][]} */
  const creations = [];
  /** @type {object[]} */
  const cancelledTurns = [];
  let nextId = count;
  let failCreation = false;
  // Knobs a test turns to put the daemon in an awkward state.
  let transcriptDelayMs = 0;
  let transcriptFailures = 0;
  let failAfterAccepting = false;
  // Every call a page makes on a session facet, by method name.
  /** @type {string[]} */
  const calls = [];
  /** @type {(id: string) => any} */
  let readHistory = () => harden([]);

  const listWatch = makeSessionListWatch(async () =>
    harden(
      sessions.map(session => ({
        ...session,
        // eslint-disable-next-line no-use-before-define
        activity: parts.get(session.id)?.current ? 'working' : 'passive',
        // eslint-disable-next-line no-use-before-define
        pendingCount:
          // eslint-disable-next-line no-use-before-define
          parts.get(session.id)?.submissions.read().entries.length || 0,
      })),
    ),
  );

  /**
   * @typedef {{ current: { view: object, turn: FakeTurn } | null,
   *   watch: ReturnType<typeof makeSessionWatch>,
   *   submissions: ReturnType<typeof makeSessionSubmissions>,
   *   startTurn: (text: string, options?: { pendingId?: string,
   *     onBegun?: () => Promise<void> }) => object }} SessionParts
   */
  /** @type {Map<string, SessionParts>} */
  const parts = new Map();

  /** @param {string} id */
  /** @returns {SessionParts} */
  const partsFor = id => {
    const existing = parts.get(id);
    if (existing) return existing;
    const touch = (/** @type {any} */ kind = undefined) => {
      // eslint-disable-next-line no-use-before-define
      created.watch.touch(kind);
      listWatch.touch();
    };
    /**
     * Start a turn in this session's slot. The test ends it by pushing a
     * terminal event into `turn.channel`.
     *
     * @param {string} text
     * @param {{ pendingId?: string, onBegun?: () => Promise<void> }} [options]
     */
    const startTurn = (text, { pendingId, onBegun } = {}) => {
      // eslint-disable-next-line no-use-before-define
      if (created.current) throw Error('Session already has an active turn');
      const channel = makeBufferedReader();
      /** @type {(value?: unknown) => void} */
      let finish = () => {};
      const finished = new Promise(resolve => {
        finish = resolve;
      });
      let error = '';
      const ref = Far('TestFlootTurn', {
        watch: () => channel.reader,
        getStatus: () =>
          harden({
            messages: [],
            streamingText: '',
            phase: 'thinking',
            usage: null,
            error: error || null,
            done: channel.isClosed(),
          }),
        cancel: () => {
          cancelledTurns.push(ref);
        },
        whenFinished: () => finished,
      });
      let begun = false;
      /** @type {FakeTurn} */
      const turn = {
        id,
        text,
        ...(pendingId ? { pendingId } : {}),
        channel,
        ref,
        begin: async () => {
          if (begun) return;
          begun = true;
          if (onBegun) await onBegun();
        },
      };
      // The real channel finalises on a terminal event; hear of it too, so the
      // slot empties when the test ends the turn.
      const push = channel.push.bind(channel);
      const view = harden({
        input: text,
        turn: ref,
        ...(pendingId ? { pendingId } : {}),
      });
      // eslint-disable-next-line no-use-before-define
      created.current = { view, turn };
      turns.push({
        ...turn,
        channel: {
          ...channel,
          push: (/** @type {any} */ event) => {
            push(event);
            if (event && (event.type === 'end' || event.type === 'abort')) {
              error = event.type === 'abort' ? `${event.reason}` : '';
              // eslint-disable-next-line no-use-before-define
              if (created.current?.turn.ref === ref) created.current = null;
              finish(undefined);
              touch('transcript');
              touch('journal');
              // eslint-disable-next-line no-use-before-define
              void created.submissions.pump();
            }
          },
        },
      });
      push(
        harden({
          type: 'snapshot',
          status: turnStatus(turn) || {
            messages: [],
            streamingText: '',
            phase: 'thinking',
            usage: null,
            error: null,
            done: false,
          },
        }),
      );
      touch();
      touch('journal');
      if (autoBegin) void turn.begin();
      return ref;
    };
    const created = {
      /** @type {SessionParts['current']} */
      current: null,
      watch: makeSessionWatch({
        loadTranscript: async () => {
          if (transcriptDelayMs) {
            await new Promise(resolve =>
              setTimeout(resolve, transcriptDelayMs),
            );
          }
          if (transcriptFailures > 0) {
            transcriptFailures -= 1;
            throw Error('disk hiccup');
          }
          return readHistory(id);
        },
        // eslint-disable-next-line no-use-before-define
        readTurn: () => (created.current ? created.current.view : null),
        readRunning: () => null,
        // eslint-disable-next-line no-use-before-define
        readPending: () => created.submissions.read(),
        readExecution: () => harden({ state: 'running', supported: false }),
        loadNetwork: async () => null,
        loadUsage: async () =>
          harden({ inputTokens: 0, outputTokens: 0, turns: 0 }),
      }),
      submissions: makeSessionSubmissions({
        queue: makePendingQueue({ host, id, onChange: () => touch() }),
        // eslint-disable-next-line no-use-before-define
        getCurrentTurn: () => created.current,
        refusal: () => '',
        startTurn,
        onChange: () => touch(),
      }),
      startTurn,
    };
    parts.set(id, created);
    return created;
  };

  /** @param {string} id */
  const facet = id => {
    /** @type {Record<string, (...args: any[]) => any>} */
    const methods = {
      getInfo: () => harden(sessions.find(session => session.id === id)),
      getHistory: () => readHistory(id),
      getCurrentTurn: () => {
        const { current } = partsFor(id);
        return current
          ? harden({ input: current.turn.text, turn: current.turn.ref })
          : null;
      },
      getUsage: () => harden({ inputTokens: 0, outputTokens: 0, turns: 0 }),
      watch: async () => {
        await partsFor(id).submissions.ready();
        return partsFor(id).watch.watch();
      },
      enqueue: async text => {
        const accepted = await partsFor(id).submissions.submit(text);
        if (failAfterAccepting) throw Error('acknowledgement lost');
        return accepted;
      },
      listPending: async () => {
        await partsFor(id).submissions.ready();
        return partsFor(id).submissions.read();
      },
      editPending: async (entryId, text) => {
        await partsFor(id).submissions.edit(entryId, text);
      },
      cancelPending: entryId => partsFor(id).submissions.cancel(entryId),
      sendPending: async entryId => {
        const { cancelCurrent } =
          await partsFor(id).submissions.sendNow(entryId);
        const { current } = partsFor(id);
        if (cancelCurrent && current) await E(current.turn.ref).cancel();
      },
    };
    return Far(
      'TestFlootSession',
      Object.fromEntries(
        Object.entries(methods).map(([name, method]) => [
          name,
          (...args) => {
            calls.push(name);
            return method(...args);
          },
        ]),
      ),
    );
  };

  const factory = Far('TestFlootFactory', {
    listSessions: () => harden(sessions.map(session => ({ ...session }))),
    watchSessions: () => listWatch.watch(),
    listPresets: () => harden([]),
    listModels: () => harden([]),
    getSession: id => facet(id),
    renameSession: (id, title) => {
      sessions = sessions.map(session =>
        session.id === id ? { ...session, title } : session,
      );
      listWatch.touch();
    },
    deleteSession: id => {
      deleted.push(id);
      sessions = sessions.filter(session => session.id !== id);
      // Deliberately leave any turn open: UI cleanup must not depend on how
      // quickly the daemon shuts down a backend, or whether deletion succeeds.
      parts.get(id)?.watch.end();
      listWatch.touch();
    },
    createSession: (...args) => {
      if (failCreation) throw Error('creation unavailable');
      creations.push(args);
      const id = `s${nextId}`;
      nextId += 1;
      sessions.push({ id, title: `Session ${id}`, createdAt: nextId });
      listWatch.touch();
      return facet(id);
    },
  });

  return {
    factory,
    turns,
    /** The arguments of every createSession call that got as far as creating. */
    created: creations,
    deleted,
    cancelledTurns,
    store,
    /**
     * A turn the daemon started on its own account: another page's, or one
     * already running when this page looks.
     *
     * @param {string} id
     * @param {string} text
     */
    startTurn: (id, text) => partsFor(id).startTurn(text),
    /** Something other than a UI turn changed the transcript (mail). */
    touchTranscript: (/** @type {string} */ id) =>
      partsFor(id).watch.touch('transcript'),
    pendingOf: (/** @type {string} */ id) => partsFor(id).submissions.read(),
    setCreationFailure: (/** @type {boolean} */ value) => {
      failCreation = value;
    },
    /** Every session-facet call made so far, by method name. */
    calls,
    /** Make reading the transcript slow, as a long conversation's is. */
    setTranscriptDelay: (/** @type {number} */ ms) => {
      transcriptDelayMs = ms;
    },
    /** The next `count` transcript reads fail. */
    failTranscript: (/** @type {number} */ times) => {
      transcriptFailures = times;
    },
    /** `enqueue` queues the message and then reports failure. */
    setFailAfterAccepting: (/** @type {boolean} */ value) => {
      failAfterAccepting = value;
    },
    setHistoryReader: (/** @type {(id: string) => any} */ reader) => {
      readHistory = reader;
    },
    /** Queue something from "another page". */
    enqueue: (/** @type {string} */ id, /** @type {string} */ text) =>
      partsFor(id).submissions.submit(text),
  };
};
harden(makeFakeDaemon);
