// @ts-check
/**
 * The factory's session index (M1a W1a.6; architecture 3.1, D-3, D-17;
 * `designs/m1a-interfaces.md` sections 3.4 and 9).
 *
 * One row per session, in creation order, kept in the factory vat's heap so
 * a session list never wakes a session vat. Rows are plain records with a
 * fixed key vocabulary (rule 12.10); the collections are a `Map` keyed by
 * the session key and an array in creation order. A row is listed only once
 * its session exists (`state` is not `creating`): nothing half-made is
 * listed (R4-6).
 *
 * Each session holds its own `RowReporter`, which can change only that
 * row. A row becomes `lost` when a factory call into its session breaks
 * with the retired text (a session vat is a guest vat: the text means it
 * halted or was given up, never a restart); a lost row stays listed
 * (transcripts are never deleted by the harness).
 *
 * Guest rules: prelude globals only; no clock; no data-dependent keys.
 */
import { interfaces, shapes, texts } from '../lib/guards/factory.js';
import { limits } from '../lib/limits.js';
import { messageBytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/**
 * Bytes kept free in a session page for the page record itself and the
 * message envelope (`rows`, `rev`, `next`, the answer's framing).
 */
const PAGE_OVERHEAD_BYTES = 1024;

/**
 * @typedef {object} Row
 * @property {number} ordinal creation order
 * @property {string} key `s<n>`
 * @property {string} title
 * @property {'creating' | 'ready' | 'error' | 'lost' | 'deleting'} state
 * @property {'passive' | 'working' | 'error'} activity
 * @property {string} backendTitle
 * @property {string} modelId
 * @property {number} messageCount
 * @property {number} queuedCount
 * @property {boolean} userInitiated
 * @property {any} session the Session, once made
 * @property {any} internal the SessionInternal, once made
 * @property {boolean} dropped true once the row was removed (a rolled-back creation)
 * @property {any} facade the session vat's worker facade, once made (M2
 *   W2.7: delete retires it)
 * @property {any} execVat the session's ExecHandle, if any (M2 W2.7)
 * @property {boolean} importing an import whose `end` has not arrived: the
 *   row is not listed (M2 W2.7, m2-interfaces.md 7.2)
 * @property {Row} [parent] a subagent's parent row: the row is never listed
 *   (R4-5), though `get` and `ofSession` still find it
 */

/**
 * @typedef {object} RowSeed
 * @property {string} title
 * @property {string} backendTitle
 * @property {string} modelId
 * @property {boolean} userInitiated
 * @property {Row} [parent] a subagent's parent row
 */

/**
 * The row table and its row reporters.
 *
 * M1b (W1b.5): `onChange(row, kind)` is told of every change (`kind`
 * 'changed' or 'removed'), so the list feed can publish it; `rev`, when
 * given, is the revision pages report (the list feed's batch rev, so
 * `listSessions().rev` and the feed agree); by default the table counts
 * changes itself, as in M1a.
 * @param {object} [options]
 * @param {(row: Row, kind: 'changed' | 'removed') => void} [options.onChange]
 * @param {() => number} [options.rev]
 */
export const makeRowTable = ({ onChange, rev: revOf } = {}) => {
  /** @type {Map<string, Row>} */
  const byKey = new Map();
  /**
   * Rows in creation order. Only appended to; a drop replaces the array
   * rather than moving elements in place (C-16, QC advisory 2).
   * @type {Row[]}
   */
  let order = [];
  let counter = 0;
  let rev = 0;

  /**
   * @param {Row} row
   * @param {'changed' | 'removed'} [kind]
   */
  const bump = (row, kind = 'changed') => {
    rev += 1;
    if (onChange !== undefined) onChange(row, kind);
  };

  /**
   * A new row in state `creating`, with the next key.
   * @param {RowSeed} seed
   * @returns {Row}
   */
  const add = ({ title, backendTitle, modelId, userInitiated, parent }) => {
    counter += 1;
    /** @type {Row} */
    const row = {
      ordinal: counter,
      key: `s${counter}`,
      title,
      state: 'creating',
      activity: 'passive',
      backendTitle,
      modelId,
      messageCount: 0,
      queuedCount: 0,
      userInitiated,
      session: undefined,
      internal: undefined,
      dropped: false,
      facade: undefined,
      execVat: undefined,
      importing: false,
    };
    if (parent !== undefined) row.parent = parent;
    byKey.set(row.key, row);
    order.push(row);
    bump(row);
    return row;
  };

  /**
   * Remove a row (a creation rolled back). Its key is never reused.
   * @param {Row} row
   */
  const drop = row => {
    if (row.dropped) return;
    row.dropped = true;
    byKey.delete(row.key);
    order = order.filter(other => other !== row);
    bump(row, 'removed');
  };

  /** @type {WeakMap<any, Row>} Session -> its row (M2: deleteSession) */
  const bySession = new WeakMap();

  /**
   * The session was made: the row is ready and listed (an import's once
   * its `end` arrived).
   * @param {Row} row
   * @param {{ session: any, internal: any }} made
   * @param {{ facade?: any, execVat?: any }} [vats] M2 W2.7
   */
  const ready = (row, { session, internal }, { facade, execVat } = {}) => {
    if (row.dropped) return;
    row.session = session;
    row.internal = internal;
    row.facade = facade;
    row.execVat = execVat;
    row.state = 'ready';
    bySession.set(session, row);
    bump(row);
  };

  /**
   * M2 W2.7: a delete began (R4-9); the row stays listed as `deleting`.
   * @param {Row} row
   */
  const markDeleting = row => {
    if (row.dropped || row.state === 'deleting') return;
    row.state = 'deleting';
    bump(row);
  };

  /**
   * M2 W2.7: an import's row is listed once its `end` arrived (7.2).
   * @param {Row} row
   * @param {boolean} importing
   */
  const setImporting = (row, importing) => {
    if (row.dropped || row.importing === importing) return;
    row.importing = importing;
    bump(row);
  };

  /**
   * Apply a row patch (from the session's RowReporter or a rowSnapshot).
   * @param {Row} row
   * @param {{ title?: string, activity?: Row['activity'], messageCount?: number, queuedCount?: number, imported?: boolean }} patch
   */
  const apply = (row, patch) => {
    if (row.dropped) return;
    let changed = false;
    // M2 W2.7: an imported session reports its import's end (7.2).
    if (patch.imported === true && row.importing) {
      row.importing = false;
      changed = true;
    }
    if (patch.title !== undefined && patch.title !== row.title) {
      row.title = patch.title;
      changed = true;
    }
    if (patch.activity !== undefined && patch.activity !== row.activity) {
      row.activity = patch.activity;
      changed = true;
    }
    if (
      patch.messageCount !== undefined &&
      patch.messageCount !== row.messageCount
    ) {
      row.messageCount = patch.messageCount;
      changed = true;
    }
    if (
      patch.queuedCount !== undefined &&
      patch.queuedCount !== row.queuedCount
    ) {
      row.queuedCount = patch.queuedCount;
      changed = true;
    }
    if (changed) bump(row);
  };

  /**
   * A call into the row's session broke with the retired text (D-17).
   * @param {Row} row
   */
  const markLost = row => {
    if (row.dropped || row.state === 'lost' || row.state === 'deleting') return;
    row.state = 'lost';
    bump(row);
  };

  /**
   * The RowReporter a session holds: it can change only its own row.
   * `changed` is sendOnly from the session; a patch for a dropped row is
   * ignored.
   * @param {Row} row
   */
  const makeReporter = row =>
    makeExo('RowReporter', interfaces.RowReporter, {
      /** @param {any} patch */
      changed: patch => {
        apply(row, patch);
        return undefined;
      },
    });

  /**
   * The listed form of a row (`shapes.SessionRow`).
   * @param {Row} row
   */
  const listed = row =>
    harden({
      session: row.session,
      key: row.key,
      title: row.title,
      state: row.state,
      activity: row.activity,
      backendTitle: row.backendTitle,
      modelId: row.modelId,
      messageCount: row.messageCount,
      queuedCount: row.queuedCount,
    });

  const pageRev = () => (revOf === undefined ? rev : revOf());

  /** @param {Row} row */
  const isListed = row =>
    row.state !== 'creating' &&
    row.userInitiated &&
    !row.importing &&
    row.parent === undefined;

  /**
   * One page of listed rows in creation order: at most `limit` rows (at
   * most `sessionPageRows`) and at most `frameBytes` in all, so the page
   * fits one message wherever it goes (architecture section 9). `after` is
   * the last key of the previous page; `next` is set when more rows exist.
   * @param {{ after?: string, limit?: number }} [options]
   */
  const page = ({ after, limit = limits.sessionPageRows } = {}) => {
    const most = Math.max(
      1,
      Math.min(Math.floor(limit), limits.sessionPageRows),
    );
    let start = 0;
    if (after !== undefined) {
      const from = byKey.get(after);
      if (from === undefined) throw Error(texts.unknownSession);
      start = order.indexOf(from) + 1;
    }
    /** @type {ReturnType<typeof listed>[]} */
    const rows = [];
    let bytes = PAGE_OVERHEAD_BYTES;
    let more = false;
    for (let i = start; i < order.length; i += 1) {
      const row = order[i];
      if (isListed(row)) {
        if (rows.length >= most) {
          more = true;
          break;
        }
        const entry = listed(row);
        const size = messageBytes(entry);
        if (rows.length > 0 && bytes + size > limits.frameBytes) {
          more = true;
          break;
        }
        bytes += size;
        rows.push(entry);
      }
    }
    /** @type {{ rows: ReturnType<typeof listed>[], rev: number, next?: string }} */
    const result =
      more && rows.length > 0
        ? harden({ rows, rev: pageRev(), next: rows[rows.length - 1].key })
        : harden({ rows, rev: pageRev() });
    mustMatch(result, shapes.SessionPage);
    return result;
  };

  return harden({
    add,
    drop,
    ready,
    apply,
    markLost,
    markDeleting,
    setImporting,
    /** @param {any} session */
    ofSession: session => bySession.get(session),
    makeReporter,
    page,
    listed,
    isListed,
    /** @param {string} key */
    get: key => byKey.get(key),
    /**
     * Rows in creation order: a fresh array, not hardened (hardening it
     * would freeze the mutable rows). Vat-internal only.
     */
    all: () => [...order],
    size: () => order.length,
    rev: pageRev,
  });
};
harden(makeRowTable);

/** @typedef {ReturnType<typeof makeRowTable>} RowTable */
