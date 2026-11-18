// @ts-check
/**
 * Fake `GatewayPowers` for UI unit tests (m3-interfaces.md 17, W3.4; used by
 * M3's UI units and by M4's and M5's component tests). Everything is a local
 * `Far` object with the M1a-M2 methods of m3-interfaces.md 3.3, answering
 * records in the guards' shapes; nothing runs a vat or a socket.
 *
 * Fixed signature: `makeFakePowers({ sessions?, script?, operatorMethods?,
 * presets?, extras? }) -> { powers, control }`.
 *
 * - `sessions`: the sessions that exist at the start, each a partial
 *   `FakeSessionSpec` (or a number: that many default sessions).
 * - `script`: the replies of the turns, in the order turns start (any
 *   session): `{ chunks?, final?, tools?, status?, error? }` each; a turn
 *   past the end of the script replies `Reply to: <text>`. A turn runs when
 *   the test calls `control.play()` (or step by step: `control.delta`,
 *   `control.tool`, `control.finish`).
 * - `operatorMethods`: methods added to the fake `Operator` (M4:
 *   `getSecrets`, accounts; M5: the preset catalogue).
 * - `presets`: replaces the `listPresets()` answer (objects with
 *   `describe()`); default one built-in `chat-only` preset.
 * - `extras`: `GatewayPowers.extras` (`[{ label, service }]`).
 *
 * `control.calls` logs every call as `[label, method, ...args]`, so a test
 * asserts what reached the "daemon"; `control.failNext(label, method,
 * error)` makes the next such call reject.
 *
 * Runs under the test lockdown (`harden` global; `@endo/far`).
 */
import { Far } from '@endo/far';

/* eslint-disable import/no-relative-packages */

import {
  makeFoldableStatus,
  makeReplyFold,
} from '../../guest/lib/reply-fold.js';

/**
 * @typedef {object} FakeSessionSpec
 * @property {string} [key]
 * @property {string} [title]
 * @property {'creating'|'ready'|'error'|'lost'|'deleting'} [state]
 * @property {'passive'|'working'|'error'} [activity]
 * @property {string} [backendTitle]
 * @property {string} [modelId]
 * @property {string} [effort]
 * @property {number} [turns] settled turns in its history (default 0)
 * @property {number} [archived] how many of the oldest of those are
 *   archived (served by `History.page`, no `Turn` object)
 * @property {string} [running] a turn running with this input
 * @property {'outcome-unknown'|'interrupted'|'failed'} [lastState] the
 *   newest history turn's state (default `completed`)
 * @property {string[]} [pending] waiting entries' texts
 * @property {{ reason: string, message: string }} [hold]
 */

/**
 * @typedef {object} FakeTurnScript
 * @property {string[]} [chunks] deltas, in order
 * @property {string} [final] the final text (default: the chunks joined)
 * @property {Array<{ name: string, args: string, result: string, failed?: boolean }>} [tools]
 * @property {'completed'|'failed'|'cancelled'|'outcome-unknown'|'interrupted'} [status]
 * @property {string} [error] for `failed`
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {string} text */
const previewOf = text => text.slice(0, 1024);

/**
 * @param {{
 *   sessions?: Array<Partial<FakeSessionSpec>> | number,
 *   script?: FakeTurnScript[],
 *   operatorMethods?: Record<string, (...args: any[]) => any>,
 *   presets?: any[],
 *   extras?: Array<{ label: string, service: any }>,
 *   pageTurns?: number,
 * }} [options]
 */
export const makeFakePowers = ({
  sessions: sessionSpecs = [],
  script = [],
  operatorMethods = {},
  presets,
  extras = [],
  pageTurns = 32,
} = {}) => {
  let clock = 1_700_000_000_000;
  const tick = () => {
    clock += 1000;
    return clock;
  };
  /** @type {any[][]} */
  const calls = [];
  /** @type {Map<string, any>} */
  const failures = new Map();

  /**
   * Log a call and throw a queued failure.
   *
   * @param {string} label
   * @param {string} method
   * @param {any[]} args
   */
  const enter = (label, method, args) => {
    calls.push([label, method, ...args]);
    const key = `${label}.${method}`;
    if (failures.has(key)) {
      const error = failures.get(key);
      failures.delete(key);
      throw error;
    }
  };

  // ------------------------------------------------------------ blobs

  /** @type {WeakMap<object, string>} */
  const blobTexts = new WeakMap();
  /**
   * A StagedText over a fake Blob.
   *
   * @param {string} text
   */
  const stage = text => {
    const blob = Far('Blob', {});
    blobTexts.set(blob, text);
    return harden({
      blob,
      preview: previewOf(text),
      bytes: encoder.encode(text).length,
    });
  };

  /**
   * A page of whole code points from `text`'s UTF-8 bytes.
   *
   * @param {string} text
   * @param {{ offset: number, maxBytes: number }} range
   */
  const readPage = (text, { offset, maxBytes }) => {
    const bytes = encoder.encode(text);
    let end = Math.min(bytes.length, offset + maxBytes);
    // Back off to a code point boundary (a continuation byte is 10xxxxxx).
    // eslint-disable-next-line no-bitwise
    while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    return harden({
      text: decoder.decode(bytes.subarray(offset, end)),
      next: end,
      done: end >= bytes.length,
    });
  };

  const content = Far('Content', {
    /**
     * @param {any} blob
     * @param {{ offset: number, maxBytes: number }} range
     */
    read: async (blob, range) => {
      enter('Content', 'read', [blob, range]);
      const text = blobTexts.get(blob);
      if (text === undefined) throw Error('unknown blob');
      return readPage(text, range);
    },
  });

  // ------------------------------------------------------------ live

  /**
   * One subscriber's queue.
   *
   * @typedef {object} Subscriber
   * @property {any[]} queue
   * @property {((batch: any) => void) | undefined} waiter
   * @property {boolean} closed
   * @property {string} [reason]
   * @property {any} facet
   */

  /** @returns {Subscriber} */
  const makeSubscriber = () => {
    /** @type {Subscriber} */
    const subscriber = {
      queue: [],
      waiter: undefined,
      closed: false,
      reason: undefined,
      facet: undefined,
    };
    const flush = () => {
      if (!subscriber.waiter) return;
      if (subscriber.queue.length === 0 && !subscriber.closed) return;
      const resolve = subscriber.waiter;
      subscriber.waiter = undefined;
      const deliveries = subscriber.queue.splice(0, 64);
      resolve(
        harden({
          deliveries,
          ...(subscriber.closed && subscriber.queue.length === 0
            ? {
                closed: true,
                ...(subscriber.reason ? { reason: subscriber.reason } : {}),
              }
            : {}),
        }),
      );
    };
    subscriber.facet = {
      flush,
      /** @param {any} delivery */
      push: delivery => {
        if (subscriber.closed) return;
        subscriber.queue.push(delivery);
        flush();
      },
      /** @param {string} [reason] */
      end: reason => {
        subscriber.closed = true;
        subscriber.reason = reason;
        flush();
      },
    };
    return subscriber;
  };

  /**
   * @param {Subscriber} subscriber
   * @param {string} label
   * @param {Set<Subscriber>} set
   */
  const subscriptionFacet = (subscriber, label, set) =>
    Far(label, {
      next: () => {
        enter(label, 'next', []);
        if (subscriber.waiter) throw Error('one next() at a time');
        return new Promise(resolve => {
          subscriber.waiter = resolve;
          subscriber.facet.flush();
        });
      },
      close: () => {
        enter(label, 'close', []);
        set.delete(subscriber);
        subscriber.facet.end('client');
      },
    });

  // ------------------------------------------------------------ sessions

  /**
   * @typedef {object} FakeTurn
   * @property {string} turnId
   * @property {any} turn the Turn facet (absent once archived)
   * @property {string} state
   * @property {number} round
   * @property {number} at
   * @property {string} input
   * @property {any[]} records
   * @property {string} [error]
   * @property {string} [resolution]
   * @property {boolean} archived
   * @property {Array<(status: any) => void>} finished
   */

  /**
   * @typedef {object} FakePending
   * @property {string} key
   * @property {string} text
   * @property {number} at
   * @property {string} requestId
   * @property {any} entry
   */

  /**
   * @typedef {object} FakeSession
   * @property {string} key
   * @property {string} title
   * @property {string} state
   * @property {string} activity
   * @property {string} backendTitle
   * @property {string} modelId
   * @property {string} [effort]
   * @property {string} presetLabel
   * @property {number} createdAt
   * @property {number} rev
   * @property {number} seq
   * @property {FakeTurn[]} turns
   * @property {FakeTurn} [current]
   * @property {FakePending[]} pending
   * @property {{ reason: string, message: string }} [hold]
   * @property {Map<string, any>} receipts
   * @property {Record<string, any>} usage
   * @property {Set<Subscriber>} subscribers
   * @property {any} fold
   * @property {any} folder
   * @property {{ turnId: string, settled: boolean }} [foldTurn]
   * @property {any} facet
   * @property {(event: any) => void} foldEvent
   */

  /** @type {Map<string, FakeSession>} key -> fake session state */
  const byKey = new Map();
  /** @type {Map<any, FakeSession>} Session facet -> state */
  const byFacet = new Map();
  let sessionCounter = 0;
  let turnCounter = 0;
  let scriptIndex = 0;
  let listRev = 1;
  let listSeq = 0;
  /** @type {Set<Subscriber>} */
  const listSubscribers = new Set();

  /** @param {FakeSession} s */
  const rowOf = s =>
    harden({
      session: s.facet,
      key: s.key,
      title: s.title,
      state: s.state,
      activity: s.activity,
      backendTitle: s.backendTitle,
      modelId: s.modelId,
      messageCount: s.turns.length,
      queuedCount: s.pending.length,
      ...(s.effort ? { effort: s.effort } : {}),
    });

  /** @param {any[]} events */
  const publishList = events => {
    listRev += 1;
    for (const event of events) {
      listSeq += 1;
      const delivery = harden({ seq: listSeq, rev: listRev, event });
      for (const subscriber of listSubscribers) subscriber.facet.push(delivery);
    }
  };
  /** @param {FakeSession} s */
  const rowChanged = s => publishList([harden({ type: 'row', row: rowOf(s) })]);

  /** @param {FakeTurn} t */
  const statusOf = t =>
    harden({
      turnId: t.turnId,
      state: t.state,
      round: t.round,
      at: t.at,
      ...(t.error ? { error: t.error } : {}),
      ...(t.resolution ? { resolution: t.resolution } : {}),
    });

  /** @param {FakeSession} s */
  const pendingView = s =>
    harden({
      entries: s.pending.map(
        /** @param {any} p */ p =>
          harden({
            entry: p.entry,
            key: p.key,
            preview: previewOf(p.text),
            state: 'queued',
            at: p.at,
          }),
      ),
      ...(s.hold ? { hold: s.hold } : {}),
    });

  /** @param {FakeSession} s */
  const usageOf = s => harden({ ...s.usage, context: { ...s.usage.context } });

  /**
   * Publish one vat batch to a session's channel (rev + 1), folding it.
   *
   * @param {FakeSession} s
   * @param {any[]} events
   */
  const publish = (s, events) => {
    s.rev += 1;
    for (const event of events) {
      s.foldEvent(event);
      s.seq += 1;
      const delivery = harden({ seq: s.seq, rev: s.rev, event: harden(event) });
      for (const subscriber of s.subscribers) subscriber.facet.push(delivery);
    }
  };

  /**
   * @param {FakeSession} s
   * @param {FakeTurn} t
   */
  const makeTurnFacet = (s, t) =>
    Far('Turn', {
      getStatus: () => {
        enter('Turn', 'getStatus', []);
        return statusOf(t);
      },
      cancel: () => {
        enter('Turn', 'cancel', []);
        if (t.state === 'running') {
          t.state = 'cancelling';
          publish(s, [
            { type: 'phase', turnId: t.turnId, phase: 'cancelling' },
          ]);
          settle(s, t, { status: 'cancelled' });
        }
      },
      whenFinished: () => {
        enter('Turn', 'whenFinished', []);
        if (t.state !== 'running' && t.state !== 'cancelling') {
          return Promise.resolve(statusOf(t));
        }
        return new Promise(resolve => t.finished.push(resolve));
      },
      /** @param {string} note */
      resolve: note => {
        enter('Turn', 'resolve', [note]);
        if (t.state !== 'outcome-unknown' || t.resolution) {
          throw Error(
            'only an unresolved outcome-unknown turn can be resolved',
          );
        }
        t.resolution = note;
        t.records.push(
          harden({ kind: 'turn-resolved', turnId: t.turnId, note, at: tick() }),
        );
      },
      /** @param {string} [cursor] */
      getContent: cursor => {
        enter('Turn', 'getContent', cursor === undefined ? [] : [cursor]);
        return harden({ records: [...t.records] });
      },
    });

  /**
   * @param {FakeSession} s
   * @param {string} input
   * @param {{ state?: string, archived?: boolean, at?: number }} [options]
   * @returns {FakeTurn}
   */
  const makeTurn = (
    s,
    input,
    { state = 'running', archived = false, at } = {},
  ) => {
    turnCounter += 1;
    const turnAt = at ?? tick();
    /** @type {FakeTurn} */
    const t = {
      turnId: `t${turnCounter}`,
      turn: undefined,
      state,
      round: 0,
      at: turnAt,
      input,
      records: [],
      archived,
      finished: [],
    };
    t.records.push(
      harden({
        kind: 'turn-started',
        turnId: t.turnId,
        input,
        at: turnAt,
      }),
    );
    if (!archived) t.turn = makeTurnFacet(s, t);
    s.turns.push(t);
    return t;
  };

  /**
   * Settle a turn: final, usage, end/abort in one batch, then claim the
   * next pending entry unless the queue is held.
   *
   * @param {FakeSession} s
   * @param {FakeTurn} t
   * @param {{ status?: string, final?: string, error?: string }} outcome
   */
  const settle = (s, t, { status = 'completed', final, error }) => {
    t.state = status;
    t.error = error;
    const at = tick();
    /** @type {any[]} */
    const events = [];
    if (status === 'completed') {
      const text = final ?? s.fold.streamingText;
      events.push({ type: 'final', turnId: t.turnId, text });
    }
    s.usage.inputTokens += 10;
    s.usage.outputTokens += 5;
    s.usage.turns += 1;
    if (status !== 'completed') s.usage.incompleteTurns += 1;
    s.usage.context = { usedTokens: s.usage.inputTokens, windowTokens: 1000 };
    events.push({ type: 'usage', turnId: t.turnId, ...usageOf(s) });
    events.push(
      status === 'failed'
        ? { type: 'abort', turnId: t.turnId, reason: error ?? 'failed' }
        : { type: 'end', turnId: t.turnId, status },
    );
    t.records.push(
      harden({
        kind: 'turn-settled',
        turnId: t.turnId,
        status,
        at,
        ...(error ? { error } : {}),
        ...(status === 'completed'
          ? { final: final ?? s.fold.streamingText }
          : {}),
      }),
    );
    s.current = undefined;
    s.activity = status === 'failed' ? 'error' : 'passive';
    const next =
      !s.hold && s.pending.length > 0 ? s.pending.shift() : undefined;
    if (next) events.push(...startEvents(s, next.text, next));
    if (next) events.push({ type: 'pending', pending: pendingView(s) });
    publish(s, events);
    for (const resolve of t.finished.splice(0)) resolve(statusOf(t));
    rowChanged(s);
  };

  /**
   * Start a turn for `text` (and a pending entry's receipt): the events of
   * its first batch.
   *
   * @param {FakeSession} s
   * @param {string} text
   * @param {any} [entry]
   */
  const startEvents = (s, text, entry) => {
    const t = makeTurn(s, text);
    s.current = t;
    s.activity = 'working';
    if (entry) {
      const receipt = s.receipts.get(entry.requestId);
      if (receipt) {
        s.receipts.set(
          entry.requestId,
          harden({
            requestId: entry.requestId,
            duplicate: false,
            state: 'started',
            turn: t.turn,
          }),
        );
      }
    }
    return [
      { type: 'turn-start', turnId: t.turnId, input: text, at: t.at },
      { type: 'phase', turnId: t.turnId, phase: 'thinking' },
    ];
  };

  /**
   * Make a session from a spec.
   *
   * @param {Partial<FakeSessionSpec>} spec
   */
  const addSession = (spec = {}) => {
    sessionCounter += 1;
    /** @type {FakeSession} */
    const s = {
      key: spec.key ?? `s${sessionCounter}`,
      title: spec.title ?? 'New chat',
      state: spec.state ?? 'ready',
      activity: spec.activity ?? 'passive',
      backendTitle: spec.backendTitle ?? 'Scripted',
      modelId: spec.modelId ?? 'scripted-model',
      effort: spec.effort,
      presetLabel: 'chat-only',
      createdAt: tick(),
      rev: 1,
      seq: 0,
      /** @type {FakeTurn[]} */
      turns: [],
      /** @type {FakeTurn | undefined} */
      current: undefined,
      /** @type {any[]} */
      pending: [],
      hold: spec.hold ? harden({ ...spec.hold }) : undefined,
      /** @type {Map<string, any>} */
      receipts: new Map(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
        context: { usedTokens: 0, windowTokens: 1000 },
        turns: 0,
        incompleteTurns: 0,
      },
      /** @type {Set<Subscriber>} */
      subscribers: new Set(),
      fold: makeFoldableStatus(),
      folder: makeReplyFold(),
      /** @type {{ turnId: string, settled: boolean } | undefined} */
      foldTurn: undefined,
      /** @type {any} */
      facet: undefined,
      /** @param {any} event */
      foldEvent: event => {
        if (event.type === 'turn-start') {
          s.fold = makeFoldableStatus();
          s.folder = makeReplyFold();
          s.foldTurn = { turnId: event.turnId, settled: false };
          return;
        }
        if (event.type === 'pending' || !s.foldTurn) return;
        if (event.turnId !== s.foldTurn.turnId) return;
        const { turnId: _t, round: _r, ...rest } = event;
        const plain = { ...rest };
        for (const field of ['text', 'args', 'result']) {
          if (plain[field] && typeof plain[field] === 'object') {
            plain[field] = plain[field].preview;
          }
        }
        s.folder.apply(s.fold, plain);
        if (event.type === 'end' || event.type === 'abort') {
          s.folder.finish(s.fold);
          s.foldTurn.settled = true;
        }
      },
    };
    const total = spec.turns ?? 0;
    const archivedCount = Math.min(spec.archived ?? 0, total);
    for (let i = 0; i < total; i += 1) {
      const t = makeTurn(s, `message ${i + 1}`, {
        state: i === total - 1 && spec.lastState ? spec.lastState : 'completed',
        archived: i < archivedCount,
      });
      t.round = 1;
      t.records.push(
        harden({
          kind: 'turn-settled',
          turnId: t.turnId,
          status: t.state,
          at: tick(),
          ...(t.state === 'completed' ? { final: `reply ${i + 1}` } : {}),
        }),
      );
      s.usage.turns += 1;
    }
    for (const text of spec.pending ?? []) {
      addPending(s, text, `fake-${sessionCounter}-${s.pending.length + 1}`);
    }
    s.facet = makeSessionFacet(s);
    byKey.set(s.key, s);
    byFacet.set(s.facet, s);
    if (spec.running !== undefined) {
      const t = makeTurn(s, spec.running);
      s.current = t;
      s.activity = 'working';
      s.foldEvent({ type: 'turn-start', turnId: t.turnId });
      s.rev += 1;
    }
    return s;
  };

  /**
   * @param {FakeSession} s
   * @param {string} text
   * @param {string} requestId
   */
  const addPending = (s, text, requestId) => {
    /** @type {FakePending} */
    const p = {
      key: `e${s.pending.length + 1}-${requestId}`,
      text,
      at: tick(),
      requestId,
      entry: undefined,
    };
    p.entry = Far('QueueEntry', {
      describe: () => {
        enter('QueueEntry', 'describe', []);
        return harden({
          key: p.key,
          preview: previewOf(p.text),
          state: 'queued',
          at: p.at,
        });
      },
      cancel: () => {
        enter('QueueEntry', 'cancel', []);
        const index = s.pending.indexOf(p);
        if (index < 0) return false;
        s.pending.splice(index, 1);
        publish(s, [{ type: 'pending', pending: pendingView(s) }]);
        rowChanged(s);
        return true;
      },
      /** @param {any} submission */
      edit: submission => {
        enter('QueueEntry', 'edit', [submission]);
        p.text = submission.text;
        publish(s, [{ type: 'pending', pending: pendingView(s) }]);
      },
      sendNow: () => {
        enter('QueueEntry', 'sendNow', []);
        const index = s.pending.indexOf(p);
        if (index < 0) return;
        s.pending.splice(index, 1);
        s.pending.unshift(p);
        s.hold = undefined;
        if (!s.current) {
          s.pending.shift();
          publish(s, [
            ...startEvents(s, p.text, p),
            { type: 'pending', pending: pendingView(s) },
          ]);
        } else {
          publish(s, [{ type: 'pending', pending: pendingView(s) }]);
        }
      },
    });
    s.pending.push(p);
    return p;
  };

  /** @param {FakeSession} s */
  const watchOf = s =>
    harden({
      rev: s.rev,
      info: infoOf(s),
      pending: pendingView(s),
      usage: usageOf(s),
      ...(s.current
        ? { current: statusOf(s.current) }
        : s.turns.length > 0
          ? { current: statusOf(s.turns[s.turns.length - 1]) }
          : {}),
    });

  /** @param {FakeSession} s */
  const infoOf = s =>
    harden({
      key: s.key,
      title: s.title,
      backendTitle: s.backendTitle,
      modelId: s.modelId,
      presetLabel: s.presetLabel,
      createdAt: s.createdAt,
      ...(s.effort ? { reasoningEffort: s.effort } : {}),
    });

  /**
   * @param {FakeTurn} t
   * @returns {any}
   */
  const previewOfTurn = t =>
    harden({
      ...(t.archived ? { sealed: true } : { turn: t.turn }),
      turnId: t.turnId,
      state: t.state,
      at: t.at,
      records: [...t.records],
      ...(t.archived && t.resolution ? { resolution: t.resolution } : {}),
    });

  /**
   * Newest first from ordinal `n` (1-based), kept or archived turns only.
   *
   * @param {FakeSession} s
   * @param {number} n
   * @param {boolean} archive
   * @returns {any}
   */
  const pageFrom = (s, n, archive) => {
    const sealedTurns = s.turns.filter(
      /** @param {FakeTurn} t */ t => t.archived,
    ).length;
    const floor = archive ? 1 : sealedTurns + 1;
    if (!archive && n <= sealedTurns) {
      return harden({ turns: [], next: `h${n}`, archived: true });
    }
    const turns = [];
    let o = n;
    while (o >= floor && turns.length < pageTurns) {
      turns.push(previewOfTurn(s.turns[o - 1]));
      o -= 1;
    }
    if (o >= 1) {
      return harden({
        turns,
        next: `h${o}`,
        ...(!archive && o <= sealedTurns ? { archived: true } : {}),
      });
    }
    return harden({ turns });
  };

  /** @param {string | undefined} cursor */
  const ordinalOf = cursor => {
    if (cursor === undefined) return undefined;
    const match = /^h(\d+)$/.exec(cursor);
    if (!match) throw Error(`bad cursor ${cursor}`);
    return Number(match[1]);
  };

  /** @param {FakeSession} s */
  function makeSessionFacet(s) {
    return Far('Session', {
      getInfo: () => {
        enter('Session', 'getInfo', []);
        return infoOf(s);
      },
      /** @param {string} title */
      rename: title => {
        enter('Session', 'rename', [title]);
        s.title = title;
        rowChanged(s);
      },
      watch: () => {
        enter('Session', 'watch', []);
        return watchOf(s);
      },
      /** @param {string} requestId */
      getSubmissionReceipt: requestId => {
        enter('Session', 'getSubmissionReceipt', [requestId]);
        return s.receipts.get(requestId);
      },
      listPending: () => {
        enter('Session', 'listPending', []);
        return pendingView(s);
      },
      getCurrentTurn: () => {
        enter('Session', 'getCurrentTurn', []);
        if (!s.current) return undefined;
        return harden({
          input: s.current.input,
          turn: s.current.turn,
          history: previewOfTurn(s.current),
        });
      },
      /** @param {string} [cursor] */
      getHistoryPage: cursor => {
        enter(
          'Session',
          'getHistoryPage',
          cursor === undefined ? [] : [cursor],
        );
        return pageFrom(s, ordinalOf(cursor) ?? s.turns.length, false);
      },
      getUsage: () => {
        enter('Session', 'getUsage', []);
        return usageOf(s);
      },
      /** @param {string} turnId */
      findTurn: turnId => {
        enter('Session', 'findTurn', [turnId]);
        const t = s.turns.find(
          /** @param {FakeTurn} x */ x => x.turnId === turnId,
        );
        if (!t) throw Error('unknown turn');
        if (!t.turn) t.turn = makeTurnFacet(s, t);
        return t.turn;
      },
    });
  }

  // ------------------------------------------------------------ catalogue

  const makePreset = (/** @type {string} */ label) =>
    Far('Preset', {
      describe: () => {
        enter('Preset', 'describe', []);
        return harden({ label, builtIn: true });
      },
      snapshot: () => harden({ label }),
    });
  const presetList = harden(presets ?? [makePreset('chat-only')]);

  /** @type {Array<{ kind: string, label: string, models: any[], state: string }>} */
  const backendSpecs = [];
  /** @type {any[]} */
  const backends = [];
  /**
   * @param {string} label
   * @param {{ kind?: string, models?: string[], state?: 'ok' | 'unavailable' }} [options]
   */
  const addBackend = (
    label,
    { kind = 'scripted', models = ['scripted-model'], state = 'ok' } = {},
  ) => {
    const spec = { kind, label, models: [...models], state };
    const backend = Far('Backend', {
      describe: () => {
        enter('Backend', 'describe', []);
        return harden({ kind: spec.kind, label: spec.label });
      },
      /** @param {any} [request] */
      listModels: async request => {
        enter('Backend', 'listModels', request === undefined ? [] : [request]);
        return modelPage(backend, spec, request);
      },
    });
    backendSpecs.push(spec);
    backends.push(backend);
    return backend;
  };
  /**
   * @param {any} backend
   * @param {{ models: string[], state: string }} spec
   * @param {{ after?: string, limit?: number }} [request]
   */
  const modelPage = (backend, spec, request = {}) => {
    if (spec.state !== 'ok') {
      return harden({
        rows: [],
        state: 'unavailable',
        error: 'catalogue unavailable',
      });
    }
    /** @type {number} */
    const limit = request.limit ?? 50;
    const start = request.after ? spec.models.indexOf(request.after) + 1 : 0;
    const slice = spec.models.slice(start, start + limit);
    const rows = slice.map((modelId, index) =>
      harden({
        backend,
        modelId,
        selectionId: modelId,
        title: modelId,
        default: start + index === 0,
        reasoningEfforts: [],
      }),
    );
    return harden({
      rows,
      state: 'ok',
      ...(start + limit < spec.models.length
        ? { next: slice[slice.length - 1] }
        : {}),
    });
  };
  addBackend('Scripted');

  // ------------------------------------------------------------ factory

  const factory = Far('SessionFactory', {
    /** @param {any} [options] */
    createSession: async (options = {}) => {
      enter('SessionFactory', 'createSession', [options]);
      const s = addSession({
        title: options.title,
        modelId: options.modelId,
        effort: options.reasoningEffort,
      });
      rowChanged(s);
      return s.facet;
    },
    /** @param {{ after?: string, limit?: number }} [page] */
    listSessions: ({ after, limit = 50 } = {}) => {
      enter('SessionFactory', 'listSessions', [{ after, limit }]);
      const all = [...byKey.values()];
      const start =
        after === undefined ? 0 : all.findIndex(s => s.key === after) + 1;
      const slice = all.slice(start, start + limit);
      return harden({
        rows: slice.map(rowOf),
        rev: listRev,
        ...(start + limit < all.length
          ? { next: slice[slice.length - 1].key }
          : {}),
      });
    },
    sessionListFeed: () => {
      enter('SessionFactory', 'sessionListFeed', []);
      return harden({ rev: listRev });
    },
    /** @param {string} key */
    findSession: key => {
      enter('SessionFactory', 'findSession', [key]);
      const s = byKey.get(key);
      if (!s) throw Error('unknown session');
      return s.facet;
    },
    listPresets: () => {
      enter('SessionFactory', 'listPresets', []);
      return presetList;
    },
    /** @param {any} session */
    deleteSession: async session => {
      enter('SessionFactory', 'deleteSession', [session]);
      const s = byFacet.get(session);
      if (!s) return;
      byKey.delete(s.key);
      byFacet.delete(session);
      publishList([harden({ type: 'row-removed', session, key: s.key })]);
    },
    listBackends: () => {
      enter('SessionFactory', 'listBackends', []);
      return harden([...backends]);
    },
    /** @param {any} [request] */
    listModels: async (request = {}) => {
      enter('SessionFactory', 'listModels', [request]);
      const backend = request.backend ?? backends[0];
      const index = backends.indexOf(backend);
      return modelPage(backend, backendSpecs[index], request);
    },
  });

  const operator = Far('Operator', {
    getFactory: () => {
      enter('Operator', 'getFactory', []);
      return factory;
    },
    ...operatorMethods,
  });

  // ------------------------------------------------------------ gateway-local

  const live = Far('Live', {
    /**
     * @param {any} session
     * @param {number} [rev]
     */
    subscribe: async (session, rev) => {
      enter(
        'Live',
        'subscribe',
        rev === undefined ? [session] : [session, rev],
      );
      const s = byFacet.get(session);
      if (!s) throw Error('unknown session');
      const subscriber = makeSubscriber();
      s.subscribers.add(subscriber);
      s.seq += 1;
      subscriber.facet.push(
        harden({
          seq: s.seq,
          rev: s.rev,
          event: {
            type: 'snapshot',
            ...(s.foldTurn
              ? {
                  turn: {
                    turnId: s.foldTurn.turnId,
                    settled: s.foldTurn.settled,
                    status: {
                      ...s.fold,
                      messages: s.fold.messages.map(
                        /** @param {any} m */ m => ({ ...m }),
                      ),
                    },
                  },
                }
              : {}),
          },
        }),
      );
      return subscriptionFacet(subscriber, 'LiveSubscription', s.subscribers);
    },
    /** @param {number} [rev] */
    subscribeList: async rev => {
      enter('Live', 'subscribeList', rev === undefined ? [] : [rev]);
      const subscriber = makeSubscriber();
      listSubscribers.add(subscriber);
      listSeq += 1;
      subscriber.facet.push(
        harden({
          seq: listSeq,
          rev: listRev,
          event: { type: 'list-snapshot' },
        }),
      );
      return subscriptionFacet(subscriber, 'ListSubscription', listSubscribers);
    },
  });

  const composer = Far('Composer', {
    /**
     * @param {any} session
     * @param {string} text
     * @param {string} requestId
     */
    submit: async (session, text, requestId) => {
      enter('Composer', 'submit', [session, text, requestId]);
      const s = byFacet.get(session);
      if (!s) throw Error('unknown session');
      const known = s.receipts.get(requestId);
      if (known) return harden({ ...known, duplicate: true });
      if (!s.current && !s.hold && s.pending.length === 0) {
        const events = startEvents(s, text);
        const receipt = harden({
          requestId,
          duplicate: false,
          state: 'started',
          turn: /** @type {any} */ (s).current.turn,
        });
        s.receipts.set(requestId, receipt);
        publish(s, events);
        rowChanged(s);
        return receipt;
      }
      const p = addPending(s, text, requestId);
      const receipt = harden({
        requestId,
        duplicate: false,
        state: 'queued',
        entry: p.entry,
      });
      s.receipts.set(requestId, receipt);
      publish(s, [{ type: 'pending', pending: pendingView(s) }]);
      rowChanged(s);
      return receipt;
    },
    /**
     * @param {any} entry
     * @param {string} text
     */
    edit: async (entry, text) => {
      enter('Composer', 'edit', [entry, text]);
      for (const s of byKey.values()) {
        const p = s.pending.find(/** @param {any} x */ x => x.entry === entry);
        if (p) {
          p.text = text;
          publish(s, [{ type: 'pending', pending: pendingView(s) }]);
          return;
        }
      }
      throw Error('unknown entry');
    },
  });

  const history = Far('History', {
    /**
     * @param {any} session
     * @param {string} [cursor]
     */
    page: async (session, cursor) => {
      enter(
        'History',
        'page',
        cursor === undefined ? [session] : [session, cursor],
      );
      const s = byFacet.get(session);
      if (!s) throw Error('unknown session');
      const n = ordinalOf(cursor) ?? s.turns.length;
      const sealedTurns = s.turns.filter(
        /** @param {FakeTurn} t */ t => t.archived,
      ).length;
      return pageFrom(s, n, n <= sealedTurns);
    },
    /**
     * @param {any} session
     * @param {string} turnId
     */
    turnContent: async (session, turnId) => {
      enter('History', 'turnContent', [session, turnId]);
      const s = byFacet.get(session);
      const t =
        s && s.turns.find(/** @param {FakeTurn} x */ x => x.turnId === turnId);
      if (!t) throw Error('unknown turn');
      return harden({ records: [...t.records] });
    },
  });

  const powers = harden({
    operator,
    live,
    content,
    composer,
    history,
    extras: harden(extras.map(extra => harden({ ...extra }))),
  });

  // ------------------------------------------------------------ set-up

  const specs =
    typeof sessionSpecs === 'number'
      ? Array.from({ length: sessionSpecs }, () => ({}))
      : sessionSpecs;
  for (const spec of specs) addSession(spec);

  /** @param {string | undefined} key */
  const sessionState = key => {
    if (key !== undefined) {
      const s = byKey.get(key);
      if (!s) throw Error(`no fake session ${key}`);
      return s;
    }
    for (const s of byKey.values()) if (s.current) return s;
    throw Error('no fake session has a running turn');
  };

  /** @param {FakeSession} s */
  const nextScript = s => {
    /** @type {FakeTurnScript} */
    const step = script[scriptIndex] ?? {
      chunks: [`Reply to: ${s.current?.input}`],
    };
    scriptIndex += 1;
    return step;
  };

  // Not hardened: `calls` keeps growing.
  const control = Object.freeze({
    calls,
    /** The current fake clock (ms). */
    now: () => clock,
    stage,
    /**
     * @param {string} label
     * @param {string} method
     * @param {any} error
     */
    failNext: (label, method, error) => {
      failures.set(`${label}.${method}`, error);
    },
    /**
     * @param {string} label
     * @param {string} method
     */
    callsOf: (label, method) =>
      calls.filter(call => call[0] === label && call[1] === method),
    /** @param {Partial<FakeSessionSpec>} [spec] */
    addSession: (spec = {}) => {
      const s = addSession(spec);
      rowChanged(s);
      return s.facet;
    },
    addBackend,
    /** @param {string} key */
    session: key => sessionState(key).facet,
    /** @param {any} facet */
    keyOf: facet => byFacet.get(facet)?.key,
    /**
     * @param {string} key
     * @param {Partial<{ title: string, activity: string, state: string }>} patch
     */
    patchRow: (key, patch) => {
      const s = sessionState(key);
      Object.assign(s, patch);
      rowChanged(s);
    },
    /** @param {string} key */
    removeSession: key => {
      const s = sessionState(key);
      byKey.delete(key);
      byFacet.delete(s.facet);
      publishList([harden({ type: 'row-removed', session: s.facet, key })]);
    },
    /** @param {string} [key] */
    currentTurn: key => sessionState(key).current?.turn,
    /** @param {string} key */
    receipts: key => [...sessionState(key).receipts.values()],
    /** @param {string} key */
    turns: key => sessionState(key).turns.map(statusOf),
    /** @param {string} key */
    pendingTexts: key =>
      sessionState(key).pending.map(/** @param {any} p */ p => p.text),
    /**
     * @param {string} key
     * @param {{ reason: string, message: string } | undefined} hold
     */
    setHold: (key, hold) => {
      const s = sessionState(key);
      s.hold = hold && harden({ ...hold });
      publish(s, [{ type: 'pending', pending: pendingView(s) }]);
    },
    /**
     * Publish raw vat events to a session's channel (one batch).
     *
     * @param {string} key
     * @param {any[]} events
     */
    publish: (key, events) => publish(sessionState(key), events),
    /**
     * Skip a rev: the next batch arrives with a gap (as after a lost
     * delivery).
     *
     * @param {string} key
     */
    skipRev: key => {
      sessionState(key).rev += 1;
    },
    /**
     * A text delta of the running turn (adapter-published: no rev).
     *
     * @param {string} [key]
     * @param {string} [text]
     */
    delta: (key, text = 'chunk') => {
      const s = sessionState(key);
      const t = s.current;
      if (!t) throw Error('no running turn');
      const event = { type: 'delta', turnId: t.turnId, round: t.round, text };
      s.foldEvent(event);
      s.seq += 1;
      const delivery = harden({ seq: s.seq, rev: s.rev, event });
      for (const subscriber of s.subscribers) subscriber.facet.push(delivery);
    },
    /**
     * A tool round of the running turn.
     *
     * @param {string | undefined} key
     * @param {{ name: string, args: string, result: string, failed?: boolean }} call
     */
    tool: (key, { name, args, result, failed = false }) => {
      const s = sessionState(key);
      const t = s.current;
      if (!t) throw Error('no running turn');
      turnCounter += 1;
      const id = `op${turnCounter}`;
      publish(s, [
        { type: 'phase', turnId: t.turnId, phase: 'using tools' },
        { type: 'tool_call', turnId: t.turnId, id, name, args },
      ]);
      publish(s, [
        { type: 'tool_result', turnId: t.turnId, id, name, result, failed },
      ]);
      t.round += 1;
    },
    /**
     * Settle the running turn.
     *
     * @param {string} [key]
     * @param {{ status?: string, final?: string, error?: string }} [outcome]
     */
    finish: (key, outcome = {}) => {
      const s = sessionState(key);
      if (!s.current) throw Error('no running turn');
      settle(s, s.current, outcome);
    },
    /**
     * Play the running turn's script to its end (deltas, tools, final).
     *
     * @param {string} [key]
     */
    play: key => {
      const s = sessionState(key);
      if (!s.current) throw Error('no running turn');
      const step = nextScript(s);
      const chunks = step.chunks ?? [];
      for (const chunk of chunks) control.delta(s.key, chunk);
      for (const call of step.tools ?? []) control.tool(s.key, call);
      settle(s, s.current, {
        status: step.status ?? 'completed',
        final: step.final ?? chunks.join(''),
        error: step.error,
      });
    },
    /**
     * Close every subscription of a session (or of the list, key
     * undefined) as the channel would.
     *
     * @param {string | undefined} key
     * @param {string} [reason]
     */
    closeSubscriptions: (key, reason = 'queueDeliveries') => {
      const set =
        key === undefined ? listSubscribers : sessionState(key).subscribers;
      for (const subscriber of set) subscriber.facet.end(reason);
      set.clear();
    },
    /** @param {string} [key] */
    subscriberCount: key =>
      key === undefined
        ? listSubscribers.size
        : sessionState(key).subscribers.size,
  });

  return { powers, control };
};
harden(makeFakePowers);
