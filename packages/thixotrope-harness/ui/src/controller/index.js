// @ts-check
/**
 * The UI controller (m3-interfaces.md 9.1, 9.2; W3.4): the page's state as
 * pure data, rebuilt from the daemon's objects, and the actions the views
 * call. Views render `getState()` after each `subscribe` notification and
 * never call the daemon themselves (features may, through
 * `FeatureContext.call`).
 *
 * Objects, not names (F.2): the controller keeps the presences it was given
 * (`Session`s from rows, `QueueEntry`s from pending rows, `Turn`s from
 * history pages, receipts and `getCurrentTurn`) and string keys only to
 * find one of those again (F.2 d). Records and events are kept exactly as
 * received; the controller reads the fields it knows and never projects
 * them onto M2's keys, so fields a later milestone adds reach the views
 * (`message.renderer`).
 */
import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */

import {
  makeFoldableStatus,
  makeReplyFold,
} from '../../../guest/lib/reply-fold.js';
import {
  uiTexts,
  uiTextOf,
} from '../../../resources/agent-host/impl/gateway/contract-m3.js';
import {
  LOCK_PREFIX,
  clearDraft,
  draftSessionKeys,
  newRequestId,
  readDraft,
  writeDraft,
} from './drafts.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */
/** @import { DraftStorage } from './drafts.js' */

/** `Content.read` page size (`limits.blobPageBytes`). */
export const CONTENT_PAGE_BYTES = 20_480;
/** Sessions per `listSessions` page (`limits.sessionPageRows`). */
const SESSION_PAGE_ROWS = 50;
/** Most pages of a text `readContent` reads (64 x 20 KiB = 1.25 MiB). */
const CONTENT_MAX_PAGES = 64;
/** Most `listSessions` pages one rebuild reads (50 x 200 = 10,000 rows). */
const LIST_MAX_PAGES = 200;

/**
 * @typedef {'unconfigured'|'connecting'|'open'|'reconnecting'|'starting'|'refused'} ConnectionState
 */

/**
 * One turn of the conversation view. `record` is its `TurnStarted` record
 * as a history page delivered it, or the live `turn-start` event while no
 * page has shown it (MessageRendererProps.record). `records` are the
 * history page's preview records (absent for a turn seen only live).
 * `fold` is the live fold of a turn this page watched (messages,
 * streamingText, phase, error), absent otherwise.
 *
 * @typedef {object} TurnEntry
 * @property {string} turnId
 * @property {any} [turn] the `Turn` presence (absent for archived turns)
 * @property {string} state `TurnState`
 * @property {number} at
 * @property {Record<string, any>} record
 * @property {any[]} [records]
 * @property {boolean} [sealed] an archived turn (History.page)
 * @property {string} [error]
 * @property {string} [resolution]
 * @property {{ messages: any[], streamingText: string, phase: string, error: any }} [fold]
 */

/**
 * @typedef {object} ConversationView
 * @property {Record<string, any>} info `SessionInfo` as received
 * @property {TurnEntry[]} messages oldest first
 * @property {string} streamingText the live turn's text so far
 * @property {string} phase the live turn's phase ('' when idle)
 * @property {boolean} busy a turn is running or cancelling
 * @property {Record<string, any>} [current] the newest `TurnStatus`
 * @property {any[]} pending `PendingRow`s as received
 * @property {Record<string, any>} [hold]
 * @property {Record<string, any>} usage `UsageTotals`
 * @property {'none'|'more'|'loading'} earlier
 * @property {string} status a status line ('' when none)
 * @property {{ text: string, caret: number }} input
 * @property {string} [sendError]
 * @property {string} [blocked] why the composer is disabled (A-5; no Web
 *   Locks)
 */

/**
 * @typedef {object} UiState
 * @property {ConnectionState} connection
 * @property {string} [connectionMessage] the refusal text
 * @property {Array<Record<string, any>>} sessions rows without their presence
 * @property {string} [activeKey]
 * @property {Array<{ index: number, label: string, available: boolean, description?: string, reasoningEffort?: string, unavailableReason?: string }>} presets
 * @property {Array<{ index: number, label: string, kind: string }>} backends
 * @property {{ rows: any[], state: string, next?: string, error?: string, backendIndex?: number }} models
 * @property {ConversationView | null} view
 * @property {{ turns: any[], next?: string, loading: boolean } | null} recovery
 * @property {boolean} settingsOpen
 * @property {boolean} drawerOpen
 * @property {string} status a page-wide status line ('' when none)
 * @property {string} [panel] the open `app.panel` feature's id
 * @property {boolean} newSessionOpen the "Start a new session" dialog
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/** @param {string} state */
const isLive = state => state === 'running' || state === 'cancelling';

/**
 * A staged field as the fold reads it: the preview of a StagedText (the
 * full text is read with `readContent` on expand).
 *
 * @param {any} value
 */
const plainText = value =>
  value && typeof value === 'object' && typeof value.preview === 'string'
    ? value.preview
    : value;

/**
 * A live event as the reply fold reads it: no `turnId` (nor a delta's
 * `round`), staged fields by preview. The event itself is not changed.
 *
 * @param {Record<string, any>} event
 * @returns {any}
 */
const foldable = event => {
  const { turnId: _turnId, round: _round, ...rest } = event;
  for (const field of ['text', 'args', 'result']) {
    if (field in rest) rest[field] = plainText(rest[field]);
  }
  return rest;
};

/**
 * `UsageTotals` from a `usage` event (the event minus `type`, `turnId`).
 *
 * @param {Record<string, any>} event
 */
const usageOfEvent = event => {
  const { type: _type, turnId: _turnId, ...usage } = event;
  return usage;
};

/** @returns {UiState} */
const initialState = () => ({
  connection: 'connecting',
  sessions: [],
  presets: [],
  backends: [],
  models: { rows: [], state: 'idle' },
  view: null,
  recovery: null,
  settingsOpen: false,
  drawerOpen: false,
  status: '',
  newSessionOpen: false,
});

/**
 * @param {object} options
 * @param {any} [options.powers] `GatewayPowers` to attach at once; later
 *   connections call `attach(powers)`
 * @param {DraftStorage} [options.storage] `globalThis.localStorage`
 * @param {{ request: (name: string, callback: () => Promise<any>) => Promise<any> }} [options.locks]
 *   `globalThis.navigator.locks`; without it sending is disabled (R6-41)
 * @param {() => number} [options.now] ms since the epoch
 * @param {readonly UiFeature[]} [options.features] the collected features
 *   (the `composer.addon` chain)
 * @param {() => string} [options.makeRequestId]
 */
export const makeController = ({
  powers: initialPowers,
  storage,
  locks,
  now = () => Date.now(),
  features = [],
  makeRequestId = () => newRequestId(),
}) => {
  /** @type {UiState} */
  let state = initialState();
  /** @type {Set<() => void>} */
  const listeners = new Set();

  /** @type {any} */
  let powers;
  /** @type {any} */
  let factory;
  /** Bumped on every attach: continuations of an older one stop. */
  let attachEpoch = 0;
  /** Bumped on every attach and session switch. */
  let viewEpoch = 0;

  /** key -> Session presence */
  const sessionsByKey = new Map();
  /** key -> row (as received, with its presence) */
  const rowsByKey = new Map();
  let listRev = 0;

  /** @type {any[]} index -> Preset presence */
  let presetObjects = [];
  /** @type {any[]} index -> Backend presence */
  let backendObjects = [];

  // ---- the active view's objects
  /** @type {any} */
  let viewSession;
  /** @type {any} */
  let viewSubscription;
  let viewRev = 0;
  /** entryKey -> QueueEntry */
  const entriesByKey = new Map();
  /**
   * Settles when the view being opened has applied its `watch()` snapshot
   * (or failed, or was replaced). A queue action whose key is not mapped
   * waits for it once: `openView` clears `entriesByKey` before its watch
   * answers, while the rows on screen are still the old ones (M3-FIX,
   * acceptance 12).
   */
  let viewReady = Promise.resolve();
  let markViewReady = () => {};
  const resetViewReady = () => {
    markViewReady();
    viewReady = new Promise(resolve => {
      markViewReady = () => resolve(undefined);
    });
  };
  /** turnId -> Turn */
  const turnsById = new Map();
  /** @type {string | undefined} */
  let earlierCursor;
  let earlierArchived = false;
  /** The live fold of the turn the channel is on. */
  let fold = makeFoldableStatus();
  let folder = makeReplyFold();
  /** @type {string | undefined} */
  let foldTurnId;
  /** @type {string | undefined} */
  let recoveryCursor;

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a view's listener must not break the controller
      }
    }
  };

  /** @param {Partial<UiState>} patch */
  const update = patch => {
    state = { ...state, ...patch };
    notify();
  };

  /** @param {Partial<ConversationView>} patch */
  const updateView = patch => {
    if (!state.view) return;
    update({ view: { ...state.view, ...patch } });
  };

  /** @param {unknown} error */
  const reportStatus = error => {
    const text = uiTextOf.statusError(messageOf(error));
    if (state.view) updateView({ status: text });
    update({ status: text });
  };

  // ------------------------------------------------------------ sessions

  const publishRows = () => {
    update({
      sessions: [...rowsByKey.values()].map(row => {
        const { session: _session, ...rest } = row;
        return rest;
      }),
    });
  };

  /** @param {Record<string, any>} row */
  const upsertRow = row => {
    sessionsByKey.set(row.key, row.session);
    rowsByKey.set(row.key, row);
  };

  /** @param {string} key */
  const removeRow = key => {
    sessionsByKey.delete(key);
    rowsByKey.delete(key);
    if (state.activeKey === key) {
      viewEpoch += 1;
      closeViewSubscription();
      update({ activeKey: undefined, view: null, recovery: null });
    }
  };

  /** @param {number} epoch */
  const loadSessions = async epoch => {
    /** @type {any[]} */
    const rows = [];
    /** @type {string | undefined} */
    let after;
    let rev = 0;
    for (let pageIndex = 0; pageIndex < LIST_MAX_PAGES; pageIndex += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page = await E(factory).listSessions(
        after === undefined
          ? { limit: SESSION_PAGE_ROWS }
          : { after, limit: SESSION_PAGE_ROWS },
      );
      if (epoch !== attachEpoch) return;
      if (pageIndex === 0) rev = page.rev;
      rows.push(...page.rows);
      if (page.next === undefined) break;
      after = page.next;
    }
    rowsByKey.clear();
    sessionsByKey.clear();
    for (const row of rows) upsertRow(row);
    listRev = rev;
    publishRows();
    if (state.activeKey !== undefined && !rowsByKey.has(state.activeKey)) {
      removeRow(state.activeKey);
    }
  };

  /**
   * Read the session list feed until the attach changes; a gap or a closed
   * batch reloads the list and subscribes again.
   *
   * @param {number} epoch
   */
  const pumpList = async epoch => {
    for (;;) {
      if (epoch !== attachEpoch) return;
      // eslint-disable-next-line no-await-in-loop
      const subscription = await E(powers.live).subscribeList(listRev);
      if (epoch !== attachEpoch) {
        E(subscription).close();
        return;
      }
      let reload = false;
      while (!reload) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await E(subscription).next();
        if (epoch !== attachEpoch) return;
        for (const delivery of batch.deliveries) {
          const { event } = delivery;
          /** @type {number} */
          const rev = delivery.rev;
          if (event.type === 'list-snapshot') {
            if (rev !== listRev) reload = true;
          } else if (rev > listRev + 1) {
            reload = true;
          } else {
            if (rev > listRev) listRev = rev;
            if (event.type === 'row') upsertRow(event.row);
            else if (event.type === 'row-removed') removeRow(event.key);
          }
        }
        publishRows();
        if (batch.closed) reload = true;
      }
      // A gap leaves the subscription open: close it before the next one.
      E(subscription)
        .close()
        .catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await loadSessions(epoch);
    }
  };

  /** @param {number} epoch */
  const loadCatalogue = async epoch => {
    const [presets, backends] = await Promise.all([
      E(factory).listPresets(),
      E(factory).listBackends(),
    ]);
    if (epoch !== attachEpoch) return;
    presetObjects = [...presets];
    backendObjects = [...backends];
    const presetRows = await Promise.all(
      presetObjects.map(async (preset, index) => {
        try {
          const description = await E(preset).describe();
          const available = description.available !== false;
          // M3-FIX: the dialog shows `description` and refuses an
          // unsupported `reasoningEffort` (R6-39); both come from M5's
          // PresetView when the preset's record has them.
          return {
            index,
            label: description.label,
            available,
            ...(typeof description.description === 'string'
              ? { description: description.description }
              : {}),
            ...(typeof description.reasoningEffort === 'string'
              ? { reasoningEffort: description.reasoningEffort }
              : {}),
            ...(!available && description.unavailableReason !== undefined
              ? { unavailableReason: description.unavailableReason }
              : {}),
          };
        } catch (error) {
          return {
            index,
            label: '',
            available: false,
            unavailableReason: uiTextOf.statusError(messageOf(error)),
          };
        }
      }),
    );
    const backendRows = await Promise.all(
      backendObjects.map(async (backend, index) => {
        try {
          const info = await E(backend).describe();
          return { index, label: info.label, kind: info.kind };
        } catch (error) {
          return {
            index,
            label: uiTextOf.statusError(messageOf(error)),
            kind: '',
          };
        }
      }),
    );
    if (epoch !== attachEpoch) return;
    update({ presets: presetRows, backends: backendRows });
  };

  // ------------------------------------------------------------ the view

  const closeViewSubscription = () => {
    if (viewSubscription) {
      const subscription = viewSubscription;
      viewSubscription = undefined;
      E(subscription)
        .close()
        .catch(() => {});
    }
  };

  const foldView = () => ({
    messages: fold.messages.map(message => ({ ...message })),
    streamingText: fold.streamingText,
    phase: fold.phase,
    error: fold.error,
  });

  /**
   * Replace or add turn entries (by turnId), keeping the oldest-first order.
   *
   * @param {TurnEntry[]} entries
   * @param {boolean} [prepend] older turns (Load earlier)
   */
  const mergeTurns = (entries, prepend = false) => {
    if (!state.view) return;
    const messages = [...state.view.messages];
    /** @type {TurnEntry[]} */
    const added = [];
    for (const entry of entries) {
      if (entry.turn) turnsById.set(entry.turnId, entry.turn);
      const index = messages.findIndex(item => item.turnId === entry.turnId);
      if (index >= 0) {
        const previous = messages[index];
        messages[index] = {
          ...previous,
          ...entry,
          // a live fold outlives a page that shows the same turn
          ...(previous.fold && !entry.fold ? { fold: previous.fold } : {}),
          // a live state is newer than a page read before it settled
          ...(isLive(entry.state) && !isLive(previous.state)
            ? { state: previous.state }
            : {}),
        };
      } else {
        added.push(entry);
      }
    }
    const next = prepend ? [...added, ...messages] : [...messages, ...added];
    next.sort((a, b) => a.at - b.at);
    updateView({ messages: next });
  };

  /**
   * A history page's turn as a view entry (records as received).
   *
   * @param {Record<string, any>} preview `TurnPreview` or `SealedTurnPreview`
   * @returns {TurnEntry}
   */
  const entryOfPreview = preview => {
    const started =
      preview.records.find(
        /** @param {any} record */ record => record.kind === 'turn-started',
      ) ?? preview.records[0];
    return {
      turnId: preview.turnId,
      ...(preview.turn ? { turn: preview.turn } : {}),
      state: preview.state,
      at: preview.at,
      record: started,
      records: preview.records,
      ...(preview.sealed ? { sealed: true } : {}),
      ...(preview.resolution ? { resolution: preview.resolution } : {}),
    };
  };

  /**
   * @param {Record<string, any>} page
   * @param {boolean} prepend
   */
  const applyHistoryPage = (page, prepend) => {
    // newest first in the page; the view keeps oldest first
    mergeTurns([...page.turns].reverse().map(entryOfPreview), prepend);
    earlierCursor = page.next;
    if (page.archived) earlierArchived = true;
    updateView({ earlier: page.next === undefined ? 'none' : 'more' });
  };

  /** @param {Record<string, any> | undefined} current */
  const blockedBy = current => {
    if (!locks) return uiTexts.noWebLocks;
    if (current && current.state === 'outcome-unknown' && !current.resolution) {
      // A-5: a journal resolution is pending (R6-43)
      return uiTexts.turnInterrupted;
    }
    return undefined;
  };

  /** @param {Record<string, any>} snapshot `WatchSnapshot` */
  const applyWatch = snapshot => {
    viewRev = snapshot.rev;
    entriesByKey.clear();
    for (const row of snapshot.pending.entries)
      entriesByKey.set(row.key, row.entry);
    const { current } = snapshot;
    updateView({
      info: snapshot.info,
      pending: snapshot.pending.entries,
      hold: snapshot.pending.hold,
      usage: snapshot.usage,
      current,
      busy: Boolean(current && isLive(current.state)),
      blocked: blockedBy(current),
    });
    markViewReady();
  };

  /**
   * @param {number} epoch
   */
  const rewatch = async epoch => {
    const snapshot = await E(viewSession).watch();
    if (epoch !== viewEpoch) return;
    applyWatch(snapshot);
    const page = await E(viewSession).getHistoryPage();
    if (epoch !== viewEpoch) return;
    mergeTurns([...page.turns].reverse().map(entryOfPreview));
  };

  /**
   * One live delivery of the active session's channel.
   *
   * @param {Record<string, any>} delivery
   * @returns {boolean} true when the view must re-watch (a rev gap)
   */
  const applyDelivery = delivery => {
    const { event } = delivery;
    /** @type {number} */
    const rev = delivery.rev;
    if (event.type === 'snapshot') {
      if (event.turn) {
        foldTurnId = event.turn.turnId;
        fold = makeFoldableStatus();
        folder = makeReplyFold();
        folder.adopt(fold, event.turn.status);
        mergeTurns([]);
        attachFold(event.turn.turnId);
      }
      return rev !== 0 && rev !== viewRev;
    }
    if (event.type === 'delta') {
      if (event.turnId === foldTurnId) {
        folder.apply(fold, foldable(event));
        attachFold(event.turnId);
      }
      return false;
    }
    // a vat event: one batch per rev
    const gap = rev > viewRev + 1;
    if (rev > viewRev) viewRev = rev;
    switch (event.type) {
      case 'turn-start': {
        foldTurnId = event.turnId;
        fold = makeFoldableStatus();
        folder = makeReplyFold();
        const current = {
          turnId: event.turnId,
          state: 'running',
          round: 0,
          at: event.at,
        };
        mergeTurns([
          {
            turnId: event.turnId,
            state: 'running',
            at: event.at,
            record: event,
          },
        ]);
        attachFold(event.turnId);
        updateView({ current, busy: true, blocked: blockedBy(current) });
        break;
      }
      case 'end':
      case 'abort': {
        if (event.turnId === foldTurnId) {
          folder.apply(fold, foldable(event));
          folder.finish(fold);
        }
        const settled = event.type === 'end' ? event.status : 'failed';
        const view = state.view;
        const previous =
          view && view.current && view.current.turnId === event.turnId
            ? view.current
            : { turnId: event.turnId, round: 0, at: 0 };
        const current = {
          ...previous,
          state: settled,
          ...(event.type === 'abort' ? { error: event.reason } : {}),
        };
        setEntry(event.turnId, {
          state: settled,
          ...(event.type === 'abort' ? { error: event.reason } : {}),
        });
        attachFold(event.turnId);
        updateView({ current, busy: false, blocked: blockedBy(current) });
        rereadSettled(event.turnId);
        break;
      }
      case 'usage':
        if (event.turnId === foldTurnId) folder.apply(fold, foldable(event));
        updateView({ usage: usageOfEvent(event) });
        break;
      case 'pending':
        entriesByKey.clear();
        for (const row of event.pending.entries)
          entriesByKey.set(row.key, row.entry);
        updateView({
          pending: event.pending.entries,
          hold: event.pending.hold,
        });
        break;
      default:
        if (event.turnId === foldTurnId) {
          folder.apply(fold, foldable(event));
          attachFold(event.turnId);
        }
    }
    return gap;
  };

  /**
   * Re-read a turn this page watched settle (M3-FIX, acceptance 8): the
   * newest history page holds its records, whose staged fields (a long
   * reply's full text) can be read; the live fold has only previews. The
   * entry keeps its fold and live record; the transcript takes the texts
   * from the records (`withRecordTexts`).
   *
   * @param {string} turnId
   */
  const rereadSettled = turnId => {
    const epoch = viewEpoch;
    E(viewSession)
      .getHistoryPage()
      .then(
        /** @param {Record<string, any>} page */ page => {
          if (epoch !== viewEpoch) return;
          mergeTurns(
            page.turns
              .filter(
                /** @param {any} preview */ preview =>
                  preview.turnId === turnId,
              )
              .map(preview => {
                // The live `turn-start` record stays the entry's record.
                const { record: _started, ...entry } = entryOfPreview(preview);
                return entry;
              }),
          );
        },
        () => {
          // A failed re-read leaves the fold; a reload reads the records.
        },
      );
  };

  /**
   * @param {string} turnId
   * @param {Partial<TurnEntry>} patch
   */
  const setEntry = (turnId, patch) => {
    if (!state.view) return;
    updateView({
      messages: state.view.messages.map(entry =>
        entry.turnId === turnId ? { ...entry, ...patch } : entry,
      ),
    });
  };

  /** @param {string} turnId */
  const attachFold = turnId => {
    if (!state.view) return;
    const folded = foldView();
    setEntry(turnId, { fold: folded });
    updateView({ streamingText: folded.streamingText, phase: folded.phase });
  };

  /**
   * Read the active session's channel; a gap re-watches, a closed batch
   * re-watches and subscribes again.
   *
   * @param {number} epoch
   */
  const pumpView = async epoch => {
    for (;;) {
      if (epoch !== viewEpoch) return;
      // eslint-disable-next-line no-await-in-loop
      const subscription = await E(powers.live).subscribe(viewSession, viewRev);
      if (epoch !== viewEpoch) {
        E(subscription)
          .close()
          .catch(() => {});
        return;
      }
      viewSubscription = subscription;
      let closed = false;
      while (!closed) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await E(subscription).next();
        if (epoch !== viewEpoch) return;
        let gap = false;
        for (const delivery of batch.deliveries) {
          if (applyDelivery(delivery)) gap = true;
        }
        closed = Boolean(batch.closed);
        // eslint-disable-next-line no-await-in-loop
        if (gap || closed) await rewatch(epoch);
      }
      viewSubscription = undefined;
    }
  };

  /**
   * Open (or re-open after a reconnect) a session's view: `watch()`, then
   * `subscribe(session, rev)`, `getCurrentTurn()` (re-attach, R4-62) and
   * the newest history page.
   *
   * @param {string} key
   */
  const openView = async key => {
    const session = sessionsByKey.get(key);
    if (!session) throw Error(`no session ${key}`);
    viewEpoch += 1;
    const epoch = viewEpoch;
    closeViewSubscription();
    viewSession = session;
    resetViewReady();
    entriesByKey.clear();
    turnsById.clear();
    earlierCursor = undefined;
    earlierArchived = false;
    fold = makeFoldableStatus();
    folder = makeReplyFold();
    foldTurnId = undefined;
    const keptInput =
      state.view && state.activeKey === key
        ? state.view.input
        : { text: '', caret: 0 };
    /** @type {Record<string, any>} */
    let snapshot;
    try {
      snapshot = await E(session).watch();
    } catch (error) {
      if (epoch === viewEpoch) markViewReady();
      throw error;
    }
    if (epoch !== viewEpoch) return;
    update({
      view: {
        info: snapshot.info,
        messages: [],
        streamingText: '',
        phase: '',
        busy: false,
        pending: [],
        usage: snapshot.usage,
        earlier: 'none',
        status: '',
        input: keptInput,
      },
      recovery: null,
    });
    applyWatch(snapshot);
    pumpView(epoch).catch(error => {
      if (epoch === viewEpoch) reportStatus(error);
    });
    const [current, page] = await Promise.all([
      E(session).getCurrentTurn(),
      E(session).getHistoryPage(),
    ]);
    if (epoch !== viewEpoch) return;
    applyHistoryPage(page, false);
    if (current) {
      turnsById.set(current.history.turnId, current.turn);
      mergeTurns([{ ...entryOfPreview(current.history), turn: current.turn }]);
      if (foldTurnId === current.history.turnId) {
        attachFold(current.history.turnId);
      }
    }
  };

  // ------------------------------------------------------------ features

  /** @type {FeatureContext | undefined} */
  let context;
  /** @returns {FeatureContext} */
  const featureContext = () => {
    if (!context) {
      context = harden({
        get powers() {
          return powers;
        },
        /** @param {string} label */
        extra: label => {
          const found = (powers ? powers.extras : []).find(
            /** @param {any} item */ item => item.label === label,
          );
          return found ? found.service : undefined;
        },
        // eslint-disable-next-line no-use-before-define
        controller: api,
        /** @param {() => Promise<unknown>} fn */
        call: async fn => {
          try {
            return await fn();
          } catch (error) {
            reportStatus(error);
            throw error;
          }
        },
      });
    }
    return context;
  };

  const addons = () =>
    features
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.slot === 'composer.addon')
      .sort(
        (a, b) =>
          (a.item.order ?? 100) - (b.item.order ?? 100) || a.index - b.index,
      )
      .map(({ item }) => item);

  /**
   * Send through the addon chain (9.2): the first addon whose `send`
   * answers a promise sends; otherwise `Composer.submit`.
   *
   * @param {any} session
   * @param {string} text
   * @param {string} requestId
   * @param {boolean} resend
   */
  const sendThroughChain = async (session, text, requestId, resend) => {
    for (const addon of addons()) {
      if (typeof addon.send === 'function') {
        const answer = addon.send({
          context: featureContext(),
          session,
          text,
          requestId,
          resend,
        });
        if (answer !== undefined) return answer;
      }
    }
    return E(powers.composer).submit(session, text, requestId);
  };

  /**
   * @template T
   * @param {string} sessionKey
   * @param {() => Promise<T>} body
   * @returns {Promise<T>}
   */
  const underLock = (sessionKey, body) => {
    if (!locks) return Promise.reject(Error(uiTexts.noWebLocks));
    return locks.request(`${LOCK_PREFIX}${sessionKey}`, body);
  };

  /**
   * Resend every saved draft whose session exists and that has no receipt
   * (after a reconnect or reload).
   *
   * @param {number} epoch
   */
  const resendDrafts = async epoch => {
    for (const sessionKey of draftSessionKeys(storage)) {
      const session = sessionsByKey.get(sessionKey);
      if (!session) {
        // a deleted session's draft stays until its key is listed again
      } else {
        // eslint-disable-next-line no-await-in-loop
        await underLock(sessionKey, async () => {
          const draft = readDraft(storage, sessionKey);
          if (!draft || epoch !== attachEpoch) return;
          const receipt = await E(session).getSubmissionReceipt(
            draft.requestId,
          );
          if (receipt) {
            clearDraft(storage, sessionKey, draft.requestId);
            return;
          }
          try {
            await sendThroughChain(session, draft.text, draft.requestId, true);
            clearDraft(storage, sessionKey, draft.requestId);
          } catch (error) {
            if (state.activeKey === sessionKey && state.view) {
              updateView({ sendError: uiTextOf.statusError(messageOf(error)) });
            }
          }
        }).catch(() => {});
      }
    }
  };

  // ------------------------------------------------------------ attach

  /**
   * Rebuild everything from a connection's powers (first connect and every
   * reconnect, 9.2).
   *
   * @param {any} newPowers
   */
  const attach = async newPowers => {
    attachEpoch += 1;
    const epoch = attachEpoch;
    viewEpoch += 1;
    powers = newPowers;
    context = undefined;
    viewSubscription = undefined;
    update({ connection: 'open', connectionMessage: undefined, status: '' });
    try {
      factory = await E(powers.operator).getFactory();
      if (epoch !== attachEpoch) return;
      await loadSessions(epoch);
      if (epoch !== attachEpoch) return;
      pumpList(epoch).catch(error => {
        if (epoch === attachEpoch) reportStatus(error);
      });
      const catalogue = loadCatalogue(epoch).catch(reportStatus);
      if (state.activeKey !== undefined && sessionsByKey.has(state.activeKey)) {
        await openView(state.activeKey);
      }
      await resendDrafts(epoch);
      await catalogue;
    } catch (error) {
      if (epoch === attachEpoch) reportStatus(error);
    }
  };

  // ------------------------------------------------------------ actions

  /** @param {string} key */
  const activeSession = key => {
    const session = sessionsByKey.get(key);
    if (!session) throw Error(`no session ${key}`);
    return session;
  };

  /**
   * The QueueEntry of a row; while a view is being (re)opened, after its
   * watch snapshot is applied.
   *
   * @param {string} entryKey
   */
  const entryOf = async entryKey => {
    let entry = entriesByKey.get(entryKey);
    if (!entry) {
      await viewReady;
      entry = entriesByKey.get(entryKey);
    }
    if (!entry) throw Error(`no queued entry ${entryKey}`);
    return entry;
  };

  /**
   * The running turn's `Turn`: from a page, a receipt or getCurrentTurn.
   *
   * @returns {Promise<any>}
   */
  const runningTurn = async () => {
    const current = state.view && state.view.current;
    if (!current || !isLive(current.state)) return undefined;
    const known = turnsById.get(current.turnId);
    if (known) return known;
    const answer = await E(viewSession).getCurrentTurn();
    if (!answer) return undefined;
    turnsById.set(answer.history.turnId, answer.turn);
    return answer.turn;
  };

  /**
   * @template T
   * @param {() => Promise<T>} body
   * @returns {Promise<T | undefined>}
   */
  const guarded = async body => {
    try {
      return await body();
    } catch (error) {
      reportStatus(error);
      return undefined;
    }
  };

  const api = {
    /** @returns {UiState} */
    getState: () => state,
    /**
     * @param {() => void} listener called after every state change
     * @returns {() => void} unsubscribe
     */
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach,
    /**
     * The connection layer's state (net/connection.js); `open` is set by
     * `attach`.
     *
     * @param {ConnectionState} connection
     * @param {string} [message]
     */
    setConnection: (connection, message) => {
      if (connection !== 'open') {
        attachEpoch += 1;
        viewEpoch += 1;
      }
      update({
        connection,
        ...(message === undefined ? {} : { connectionMessage: message }),
      });
    },
    featureContext,
    features,

    /** @param {string} key */
    selectSession: key =>
      guarded(async () => {
        update({
          activeKey: key,
          drawerOpen: false,
          settingsOpen: false,
          panel: undefined,
        });
        await openView(key);
      }),

    /**
     * @param {{ presetIndex?: number, backendIndex?: number, modelSelection?: string, title?: string, reasoningEffort?: string }} [choice]
     *   `modelSelection` is a `ModelRow.modelId` of the loaded catalogue, or
     *   absent for "Factory default"
     */
    newSession: (choice = {}) =>
      guarded(async () => {
        const {
          presetIndex,
          backendIndex,
          modelSelection,
          title,
          reasoningEffort,
        } = choice;
        const options = {
          ...(title ? { title } : {}),
          ...(presetIndex === undefined
            ? {}
            : { preset: presetObjects[presetIndex] }),
          ...(backendIndex === undefined
            ? {}
            : { backend: backendObjects[backendIndex] }),
          ...(modelSelection === undefined ? {} : { modelId: modelSelection }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          userInitiated: true,
          at: now(),
        };
        const session = await E(factory).createSession(options);
        const info = await E(session).getInfo();
        sessionsByKey.set(info.key, session);
        if (!rowsByKey.has(info.key)) {
          upsertRow({
            session,
            key: info.key,
            title: info.title,
            state: 'ready',
            activity: 'passive',
            backendTitle: info.backendTitle,
            modelId: info.modelId,
            messageCount: 0,
            queuedCount: 0,
          });
          publishRows();
        }
        update({
          activeKey: info.key,
          drawerOpen: false,
          newSessionOpen: false,
          panel: undefined,
        });
        await openView(info.key);
        return info.key;
      }),

    /**
     * @param {string} key
     * @param {string} title
     */
    renameSession: (key, title) =>
      guarded(() => E(activeSession(key)).rename(title)),

    /** @param {string} key */
    deleteSession: key =>
      guarded(() => E(factory).deleteSession(activeSession(key))),

    /**
     * Send the composer's text exactly once (9.2).
     *
     * @param {string} text
     */
    send: async text => {
      const key = state.activeKey;
      if (key === undefined || !state.view) return undefined;
      if (!locks) {
        updateView({ sendError: uiTexts.noWebLocks });
        return undefined;
      }
      const session = activeSession(key);
      updateView({ sendError: undefined });
      try {
        return await underLock(key, async () => {
          const saved = readDraft(storage, key);
          const requestId = saved ? saved.requestId : makeRequestId();
          writeDraft(storage, { sessionKey: key, text, requestId });
          const receipt = await sendThroughChain(
            session,
            text,
            requestId,
            false,
          );
          clearDraft(storage, key, requestId);
          if (state.activeKey === key && state.view) {
            updateView({ input: { text: '', caret: 0 }, sendError: undefined });
          }
          return receipt;
        });
      } catch (error) {
        if (state.activeKey === key && state.view) {
          updateView({ sendError: uiTextOf.statusError(messageOf(error)) });
        }
        return undefined;
      }
    },

    /** Stop the running turn (R6-49). Leaving the page cancels nothing. */
    stop: () =>
      guarded(async () => {
        const turn = await runningTurn();
        if (turn) await E(turn).cancel();
      }),

    /** @param {string} entryKey */
    sendPendingNow: entryKey =>
      guarded(async () => {
        const entry = await entryOf(entryKey);
        const view = state.view;
        const isHead = Boolean(
          view && view.pending.length > 0 && view.pending[0].key === entryKey,
        );
        await E(entry).sendNow();
        if (isHead && view && view.busy) {
          // R6-44: Send now on the head cancels the running turn so it goes next
          const turn = await runningTurn();
          if (turn) await E(turn).cancel();
        }
      }),

    /**
     * @param {string} entryKey
     * @param {string} text
     */
    editPending: (entryKey, text) =>
      guarded(async () =>
        E(powers.composer).edit(await entryOf(entryKey), text),
      ),

    /** @param {string} entryKey */
    cancelPending: entryKey =>
      guarded(async () => E(await entryOf(entryKey)).cancel()),

    /** "Load earlier messages": vat pages until `archived`, then `History`. */
    loadEarlier: () =>
      guarded(async () => {
        if (!state.view || state.view.earlier !== 'more') return;
        const epoch = viewEpoch;
        updateView({ earlier: 'loading' });
        let page = earlierArchived
          ? await E(powers.history).page(viewSession, earlierCursor)
          : await E(viewSession).getHistoryPage(earlierCursor);
        if (epoch !== viewEpoch) return;
        if (!earlierArchived && page.archived && page.turns.length === 0) {
          earlierArchived = true;
          page = await E(powers.history).page(viewSession, page.next);
          if (epoch !== viewEpoch) return;
        }
        applyHistoryPage(page, true);
      }),

    /** Open the "Turn journal and recovery" panel and read its first page. */
    openRecovery: () =>
      guarded(async () => {
        if (!viewSession) return;
        const epoch = viewEpoch;
        update({ recovery: { turns: [], loading: true } });
        const page = await E(powers.history).page(viewSession);
        if (epoch !== viewEpoch) return;
        recoveryCursor = page.next;
        update({
          recovery: {
            turns: page.turns,
            ...(page.next === undefined ? {} : { next: page.next }),
            loading: false,
          },
        });
      }),

    /** The recovery panel's next (older) page. */
    moreRecovery: () =>
      guarded(async () => {
        const recovery = state.recovery;
        if (!recovery || recoveryCursor === undefined || recovery.loading)
          return;
        const epoch = viewEpoch;
        update({ recovery: { ...recovery, loading: true } });
        const page = await E(powers.history).page(viewSession, recoveryCursor);
        if (epoch !== viewEpoch || !state.recovery) return;
        recoveryCursor = page.next;
        update({
          recovery: {
            turns: [...state.recovery.turns, ...page.turns],
            ...(page.next === undefined ? {} : { next: page.next }),
            loading: false,
          },
        });
      }),

    closeRecovery: () => update({ recovery: null }),

    /**
     * "Record acknowledgement" of an outcome-unknown turn (R6-51).
     *
     * @param {string} turnId
     * @param {string} note
     */
    resolveTurn: (turnId, note) =>
      guarded(async () => {
        const turn =
          turnsById.get(turnId) ?? (await E(viewSession).findTurn(turnId));
        turnsById.set(turnId, turn);
        await E(turn).resolve(note);
        setEntry(turnId, { resolution: note });
        await rewatch(viewEpoch);
      }),

    /**
     * The whole text of a StagedText (`Content.read`) or an archived
     * SealedField (`SealedText.read`), in `blobPageBytes` pages.
     *
     * @param {Record<string, any>} staged
     * @returns {Promise<string>}
     */
    readContent: async staged => {
      const parts = [];
      let offset = 0;
      for (let pageIndex = 0; pageIndex < CONTENT_MAX_PAGES; pageIndex += 1) {
        const range = { offset, maxBytes: CONTENT_PAGE_BYTES };
        const reader = staged.sealed
          ? E(staged.sealed).read(range)
          : E(powers.content).read(staged.blob, range);
        // eslint-disable-next-line no-await-in-loop
        const page = await reader;
        parts.push(page.text);
        if (page.done) return parts.join('');
        offset = page.next;
      }
      throw Error('text too long to show');
    },

    /**
     * @param {string} text
     * @param {number} [caret]
     */
    setInput: (text, caret = text.length) => {
      if (!state.view) return;
      updateView({ input: { text, caret }, sendError: undefined });
    },

    /**
     * Replace `[start, end)` of the input; the caret goes after `text`
     * (`ComposerAddonProps.replaceRange`).
     *
     * @param {number} start
     * @param {number} end
     * @param {string} text
     */
    replaceInput: (start, end, text) => {
      if (!state.view) return;
      const current = state.view.input.text;
      const from = Math.max(0, Math.min(start, current.length));
      const to = Math.max(from, Math.min(end, current.length));
      updateView({
        input: {
          text: `${current.slice(0, from)}${text}${current.slice(to)}`,
          caret: from + text.length,
        },
        sendError: undefined,
      });
    },

    toggleDrawer: () => update({ drawerOpen: !state.drawerOpen }),
    toggleSettings: () => update({ settingsOpen: !state.settingsOpen }),

    /**
     * Open an `app.panel` feature by its id (the header menu).
     *
     * @param {string} id
     */
    openPanel: id => update({ panel: id, drawerOpen: false }),
    closePanel: () => update({ panel: undefined }),
    openNewSession: () => update({ newSessionOpen: true, drawerOpen: false }),
    closeNewSession: () => update({ newSessionOpen: false }),

    /**
     * Load the first catalogue page of a backend (the new-session dialog).
     *
     * @param {number} backendIndex
     */
    refreshModels: backendIndex =>
      guarded(async () => {
        const backend = backendObjects[backendIndex];
        update({ models: { rows: [], state: 'loading', backendIndex } });
        const page = await E(factory).listModels(backend ? { backend } : {});
        if (state.models.backendIndex !== backendIndex) return;
        update({
          models: {
            rows: page.rows,
            state: page.state,
            backendIndex,
            ...(page.next === undefined ? {} : { next: page.next }),
            ...(page.error === undefined ? {} : { error: page.error }),
          },
        });
      }),

    /** The next catalogue page (A-9: the dialog filters loaded rows). */
    moreModels: () =>
      guarded(async () => {
        const { models } = state;
        if (models.next === undefined || models.backendIndex === undefined)
          return;
        const backendIndex = models.backendIndex;
        const backend = backendObjects[backendIndex];
        const page = await E(factory).listModels({
          ...(backend ? { backend } : {}),
          after: models.next,
        });
        if (state.models.backendIndex !== backendIndex) return;
        update({
          models: {
            rows: [...state.models.rows, ...page.rows],
            state: page.state,
            backendIndex,
            ...(page.next === undefined ? {} : { next: page.next }),
            ...(page.error === undefined ? {} : { error: page.error }),
          },
        });
      }),
  };

  if (initialPowers !== undefined) {
    attach(initialPowers).catch(reportStatus);
  }

  return api;
};
