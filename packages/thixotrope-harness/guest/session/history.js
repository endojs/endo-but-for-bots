// @ts-check
/**
 * History pages and turn content in the session vat (M1a W1a.4, W1b.1;
 * M2 W2.5: `designs/m2-interfaces.md` 4.9 and 6).
 *
 * The vat shows its kept turns only; archived turns (ordinals up to the
 * archive's `sealedTurns`) are paged by the agent host's `History` from the
 * segment files, without a vat crank. A page holds whole turns, newest
 * first, while it stays within `historyPageTurns` turns, `frameBytes` and
 * `historyPageRecords` records (a page crank marshals about 3 ms per record,
 * J-0370, J-9387); the newest turn alone over the records or bytes bound
 * shows its first records and is marked `cut`. When a page reaches the
 * oldest kept turn and turns are archived, `next` names the newest archived
 * ordinal and `archived` is true. Every page of a session with sealed
 * segments carries the `ArchiveState` (the adapter learns it from the page).
 */
import { texts } from '../lib/interfaces.js';
import { limits } from '../lib/limits.js';
import { previewText } from '../lib/bounded.js';
import { inCallOrder, plainBytes } from './records.js';
import { blobsOf, isStaged } from './staging.js';

/** @import { RecordLog } from './records.js' */

/** Bytes kept free in a page for its wrapper. */
const PAGE_SLACK = 512;
/** Bytes one ToolIntents record may take in a preview. */
const PREVIEW_INTENTS_BYTES = 6144;
/** Bytes of a TurnPreview besides its records (keys, ids, state). */
const TURN_PREVIEW_KEYS_BYTES = 64;

/**
 * @param {object} options
 * @param {RecordLog} options.records
 * @param {(turnId: string) => any} options.turnInfo a kept turn's info
 * @param {(info: any) => any} options.turnHandle its Turn
 * @param {{ any: () => boolean, state: () => any, sealedTurns: () => number }} options.archive
 */
export const makeHistory = ({ records, turnInfo, turnHandle, archive }) => {
  /**
   * Previews of records, by record (records are immutable): a page that
   * shows a turn again costs a lookup per record. Records whose text needs
   * no cut are their own preview.
   * @type {WeakMap<object, { record: any, cut: boolean, bytes: number }>}
   */
  const previews = new WeakMap();

  /** @param {any} t */
  const message = t =>
    isStaged(t) ? t : previewText(t, limits.messagePreviewUnits);
  /** @param {any} t */
  const tool = t => (isStaged(t) ? t : previewText(t, limits.toolPreviewUnits));

  /**
   * A record with its text fields cut to previews (a staged field is its
   * own preview, with its blob), and its exact string bytes.
   * @param {any} record
   * @returns {{ record: any, cut: boolean, bytes: number }}
   */
  const previewRecord = record => {
    const known = previews.get(record);
    if (known !== undefined) return known;
    /** @type {any} */
    let shown = record;
    switch (record.kind) {
      case 'turn-started': {
        const input = message(record.input);
        if (input !== record.input) shown = harden({ ...record, input });
        break;
      }
      case 'partial':
      case 'round-settled': {
        const t = message(record.text);
        if (t !== record.text) shown = harden({ ...record, text: t });
        break;
      }
      case 'turn-settled': {
        if (record.final === undefined) break;
        const final = message(record.final);
        if (final !== record.final) shown = harden({ ...record, final });
        break;
      }
      case 'tool-result': {
        const result = tool(record.result);
        if (result !== record.result) shown = harden({ ...record, result });
        break;
      }
      case 'tool-intents': {
        let bytes = 0;
        let changed = false;
        /** @type {any[]} */
        const intents = [];
        for (const intent of record.intents) {
          const args = tool(intent.args);
          const one =
            args === intent.args ? intent : harden({ ...intent, args });
          if (one !== intent) changed = true;
          bytes += plainBytes(one);
          if (bytes > PREVIEW_INTENTS_BYTES && intents.length > 0) {
            changed = true;
            break;
          }
          intents.push(one);
        }
        if (changed) shown = harden({ ...record, intents: harden(intents) });
        break;
      }
      default:
        break;
    }
    const cut = shown !== record || blobsOf(record).length > 0;
    const preview = harden({ record: shown, cut, bytes: plainBytes(shown) });
    previews.set(record, preview);
    return preview;
  };

  /**
   * One kept turn as a history page shows it: records in call order,
   * previews, at most `maxRecords` records and `budget` bytes (a longer
   * turn shows its first records and is marked cut).
   * @param {string} turnId
   * @param {number} [budget]
   * @param {number} [maxRecords]
   * @returns {{ preview: any, bytes: number, records: number, whole: boolean }}
   */
  const preview = (
    turnId,
    budget = limits.frameBytes - PAGE_SLACK,
    maxRecords = limits.historyTurnRecords,
  ) => {
    const info = turnInfo(turnId);
    const ordered = inCallOrder(records.ofTurn(turnId));
    const limit = Math.min(maxRecords, limits.historyTurnRecords);
    let whole = ordered.length <= limit;
    let cut = !whole;
    /** @type {number} */
    let bytes = TURN_PREVIEW_KEYS_BYTES + turnId.length + info.state.length;
    /** @type {any[]} */
    const shown = [];
    for (const record of ordered.slice(0, limit)) {
      const one = previewRecord(record);
      if (bytes + one.bytes > budget) {
        whole = false;
        cut = true;
        break;
      }
      if (one.cut) cut = true;
      shown.push(one.record);
      bytes += one.bytes;
    }
    /** @type {Record<string, any>} */
    const result = {
      turn: turnHandle(info),
      turnId,
      state: info.state,
      at: info.at,
      records: harden(shown),
    };
    if (cut) result.cut = true;
    return { preview: harden(result), bytes, records: shown.length, whole };
  };

  /**
   * Section 4.9 and 6: newest kept turn first. The cursor `h<n>` names the
   * turns with ordinals <= n.
   * @param {string} [cursor]
   * @returns {any} a HistoryPage
   */
  const page = cursor => {
    const ids = records.turnIds();
    const sealed = records.droppedTurns();
    const total = sealed + ids.length;
    let end = total;
    if (cursor !== undefined) {
      const match = /^h([1-9][0-9]*)$/.exec(cursor);
      const n = match === null ? NaN : Number(match[1]);
      if (!(Number.isSafeInteger(n) && n <= total)) {
        throw Error(texts.badCursor);
      }
      end = n;
    }
    /** @type {Record<string, any>} */
    const result = {};
    if (archive.any()) result.archive = archive.state();
    if (end <= sealed) {
      return harden({
        ...result,
        turns: harden([]),
        next: `h${end}`,
        archived: true,
      });
    }
    const budget = limits.frameBytes - PAGE_SLACK;
    /** @type {any[]} */
    const shown = [];
    let used = 0;
    let recordsUsed = 0;
    let ordinal = end;
    while (ordinal > sealed && shown.length < limits.historyPageTurns) {
      const id = ids[ordinal - sealed - 1];
      const first = shown.length === 0;
      const one = first
        ? preview(id, budget, limits.historyPageRecords)
        : preview(id, budget - used, limits.historyPageRecords - recordsUsed);
      // Whole turns only, except the newest one alone.
      if (!first && !one.whole) break;
      shown.push(one.preview);
      used += one.bytes;
      recordsUsed += one.records;
      ordinal -= 1;
      if (!one.whole || recordsUsed >= limits.historyPageRecords) break;
    }
    result.turns = harden(shown);
    if (ordinal >= 1) {
      result.next = `h${ordinal}`;
      if (ordinal <= sealed) result.archived = true;
    }
    return harden(result);
  };

  /**
   * `Turn.getContent` (W1b.1) of a kept turn: its records in log order, in
   * full, at most `pageRecords` and `frameBytes` per page; cursor `c<n>`.
   * @param {string} turnId
   * @param {string} [cursor]
   */
  const content = (turnId, cursor) => {
    const own = records.ofTurn(turnId);
    let start = 0;
    if (cursor !== undefined) {
      const match = /^c([1-9][0-9]*)$/.exec(cursor);
      start = match === null ? NaN : Number(match[1]);
      if (!(Number.isSafeInteger(start) && start < own.length)) {
        throw Error(texts.badCursor);
      }
    }
    const budget = limits.frameBytes - PAGE_SLACK;
    /** @type {any[]} */
    const shown = [];
    let used = 0;
    let index = start;
    while (index < own.length && shown.length < limits.pageRecords) {
      const bytes = plainBytes(own[index]);
      if (shown.length > 0 && used + bytes > budget) break;
      shown.push(own[index]);
      used += bytes;
      index += 1;
    }
    /** @type {Record<string, any>} */
    const result = { records: harden(shown) };
    if (index < own.length) result.next = `c${index}`;
    return harden(result);
  };

  return harden({ page, content, preview });
};
harden(makeHistory);
