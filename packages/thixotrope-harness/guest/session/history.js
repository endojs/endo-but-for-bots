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
import { texts } from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import {
  PAGE_SLACK,
  TURN_PREVIEW_KEYS_BYTES,
  previewRecord,
} from '../lib/record-preview.js';
import { inCallOrder, plainBytes } from './records.js';
import { blobsOf, isStaged } from './staging.js';

/** @import { RecordLog } from './records.js' */


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

  /**
   * A record with its text fields cut to previews (a staged field is its
   * own preview, with its blob), and its exact string bytes.
   * @param {any} record
   * @returns {{ record: any, cut: boolean, bytes: number }}
   */
  const previewOf = record => {
    const known = previews.get(record);
    if (known !== undefined) return known;
    const shown = previewRecord(record, { isStaged, intentBytes: plainBytes });
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
      const one = previewOf(record);
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
