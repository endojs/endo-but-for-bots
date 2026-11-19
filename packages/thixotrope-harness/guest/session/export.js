// @ts-check
/**
 * A session's delete fence, blob pages and data-only export and import
 * (M2 W2.7; `designs/m2-interfaces.md` 7.1, 7.3, 4.11; R4-9).
 *
 * `makeSessionExport({ records, queue, runner, archive, fence, config, info,
 * rowReporter })` gives the `SessionInternal` methods M2 adds:
 *
 * - `deleteSelf()` (delete step 1): closes the session's one delete fence
 *   (made in session.js; the runner, the archive and the Session methods
 *   read it), so the session refuses new work with `texts.sessionDeleting`,
 *   claims nothing and starts no seal; then `runner.beginDelete()` cancels
 *   the current turn. Idempotent.
 * - `blobPage(cursor?)` (delete step 2): every staged field of the kept
 *   records (from the archive's `sealedTo`), the current turn's progress
 *   checkpoint, the staged system prompt and the waiting entries, at most
 *   `blobResolveBatch` (64) handles a page. A cursor `p<i>.<k>` resumes at
 *   source `i` (a record index, then the extras) after its first `k`
 *   handles. Archived records hold no handle (4.10).
 * - `exportState(cursor?)`: pages in the order head (info, config, usage,
 *   archive state, hold), archive (the segment index, 64 entries a page),
 *   records (from `sealedTo`, at most `pageRecords` and `frameBytes`), queue
 *   (waiting entries within `frameBytes`), inbox (M9 D-M9-21: the `inbox`
 *   part's `exportPage`, cursor `m<n>` from message number `n`), end.
 *   Archived turns are read by the exporter through `History` (4.11), not
 *   here.
 * - `importState(chunk)`: a new session (no record yet) takes `head` (its
 *   usage totals), then `records` chunks in log order (`from` must be the
 *   next index; a chunk already applied is answered again without effect,
 *   so an importer may resend after a lost answer), the waiting entries
 *   (then held `restart` unless the export carried another hold: nothing
 *   starts by itself in an imported session), the `inbox` pages (its
 *   `importPage`: every message kept, read-only) and `end`, which reports
 *   `imported` on the row so the factory lists it (7.2). The records go to
 *   `runner.importTurns` (W2.5), which rebuilds the turn infos and seals as
 *   4.3 allows.
 *
 * Vat module: prelude globals only; no record keys from data; every page
 * bounded by `frameBytes`.
 */
import { texts } from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { messageBytes } from '../lib/bounded.js';
import { holdText } from './holds.js';
import { blobsOf } from './staging.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Fail, harden } = /** @type {GuestGlobals} */ (globalThis);

/** Bytes kept free in an export page for its own keys and envelope. */
const PAGE_SLACK = 2048;

/**
 * @param {string | undefined} cursor
 * @param {RegExp} pattern
 */
const cursorNumbers = (cursor, pattern) => {
  const match = cursor === undefined ? null : pattern.exec(cursor);
  if (match === null) throw Error(`not an export cursor: ${cursor}`);
  return match.slice(1).map(Number);
};

/**
 * @param {object} powers
 * @param {{ count: () => number, at: (index: number) => any, messageCount: () => number, base: () => number }} powers.records
 *   the RecordLog
 * @param {{ items: () => any[], currentHold: () => any, size: () => number, hold: (reason: any, message: string) => void, enqueueOnce: (submission: any, requestId: string, at: number) => any }} powers.queue
 *   the session's queue
 * @param {any} powers.runner the turn runner (seams of 2.4 item 5)
 * @param {{ state: () => any, entries: () => any[] }} powers.archive the
 *   session's archive (`archive.js`)
 * @param {{ close: () => void, closed: () => boolean }} powers.fence the
 *   session's delete fence
 * @param {any} powers.config the SessionConfig
 * @param {() => any} powers.info the session's `SessionInfo`
 * @param {any} powers.rowReporter
 * @param {any} [powers.inbox] the `inbox` part (m9-interfaces.md 3.2, S7):
 *   its staged bodies join the blob pages, its messages the export
 */
export const makeSessionExport = ({
  records,
  queue,
  runner,
  archive,
  fence,
  config,
  info,
  rowReporter,
  inbox = undefined,
}) => {
  /** 0: never imported; 1: an import is open; 2: the import ended. */
  let importing = 0;

  /** @returns {{ sealedTo: number, sealedTurns: number, segments: number, digest: string } | undefined} */
  const archiveState = () => archive.state();
  /** @returns {number} */
  const keptFrom = () => records.base();

  const deleteSelf = () => {
    if (fence.closed()) return undefined;
    fence.close();
    runner.beginDelete();
    return undefined;
  };

  const extras = () => {
    /** @type {any[]} */
    const list = [runner.current()?.checkpoint, config.systemPrompt];
    for (const item of queue.items()) list.push(item.submission);
    if (inbox !== undefined) list.push(...inbox.blobs());
    return list;
  };

  /**
   * @param {string} [cursor]
   * @returns {{ blobs: any[], next?: string }}
   */
  const blobPage = cursor => {
    const base = keptFrom();
    let [i, k] =
      cursor === undefined
        ? [base, 0]
        : cursorNumbers(cursor, /^p(\d+)\.(\d+)$/);
    if (i < base) {
      i = base;
      k = 0;
    }
    const count = records.count();
    const more = extras();
    const end = count + more.length;
    /** @type {any[]} */
    const blobs = [];
    while (i < end) {
      const found = blobsOf(i < count ? records.at(i) : more[i - count]);
      while (k < found.length && blobs.length < limits.blobResolveBatch) {
        blobs.push(found[k]);
        k += 1;
      }
      if (k < found.length) return harden({ blobs, next: `p${i}.${k}` });
      i += 1;
      k = 0;
      if (blobs.length >= limits.blobResolveBatch && i < end)
        return harden({ blobs, next: `p${i}.0` });
    }
    return harden({ blobs });
  };

  const head = () => {
    const state = archiveState();
    const sealed = state !== undefined && state.segments > 0;
    /** @type {Record<string, any>} */
    const page = {
      part: 'head',
      info: info(),
      config,
      usage: runner.usage(),
      next: sealed ? 'a0' : `r${keptFrom()}`,
    };
    if (sealed) page.archive = state;
    const hold = queue.currentHold();
    if (hold !== undefined) page.hold = hold;
    return harden(page);
  };

  /** @param {number} from */
  const archivePage = from => {
    /** @type {any[]} */
    const entries = archive.entries();
    const to = from + limits.segmentPageEntries;
    return harden({
      part: 'archive',
      archive: archiveState(),
      segments: entries.slice(from, to),
      next: to < entries.length ? `a${to}` : `r${keptFrom()}`,
    });
  };

  /** @param {number} from */
  const recordsPage = from => {
    if (from < keptFrom()) throw Error(texts.recordsSealed);
    const count = records.count();
    /** @type {any[]} */
    const page = [];
    let bytes = PAGE_SLACK;
    let i = from;
    while (i < count && page.length < limits.pageRecords) {
      const record = records.at(i);
      const size = messageBytes(record);
      if (page.length > 0 && bytes + size > limits.frameBytes) break;
      bytes += size;
      page.push(record);
      i += 1;
    }
    return harden({
      part: 'records',
      from,
      records: page,
      next: i < count ? `r${i}` : 'q0',
    });
  };

  /** @param {number} from */
  const queuePage = from => {
    const items = queue.items();
    /** @type {any[]} */
    const entries = [];
    let bytes = PAGE_SLACK;
    let i = from;
    while (i < items.length) {
      const { submission, requestId, at } = items[i];
      const entry = harden({ submission, requestId, at });
      const size = messageBytes(entry);
      if (entries.length > 0 && bytes + size > limits.frameBytes) break;
      bytes += size;
      entries.push(entry);
      i += 1;
    }
    /** @type {Record<string, any>} */
    const page = {
      part: 'queue',
      entries,
      next: i < items.length ? `q${i}` : inbox ? 'm0' : 'e',
    };
    const hold = queue.currentHold();
    if (hold !== undefined) page.hold = hold;
    return harden(page);
  };

  /** @param {string} [cursor] */
  const exportState = cursor => {
    if (cursor === undefined) return head();
    if (cursor === 'e') return harden({ part: 'end' });
    const [n] = cursorNumbers(cursor.slice(1), /^(\d+)$/);
    if (cursor[0] === 'a') return archivePage(n);
    if (cursor[0] === 'r') return recordsPage(n);
    if (cursor[0] === 'q') return queuePage(n);
    if (cursor[0] === 'm' && inbox) return inbox.exportPage(n);
    throw Error(`not an export cursor: ${cursor}`);
  };

  const progress = () =>
    harden({ records: records.count(), complete: importing === 2 });

  /** @param {any} chunk a `SessionExportPage` (checked by the guard) */
  const importState = chunk => {
    if (fence.closed()) throw Error(texts.sessionDeleting);
    const { part } = chunk;
    if (importing === 2) return progress();
    if (part === 'head') {
      if (importing === 0) {
        (records.count() === 0 && runner.current() === undefined) ||
          Fail`only a new session imports`;
        importing = 1;
        if (chunk.usage !== undefined) runner.importUsage(chunk.usage);
      }
      return progress();
    }
    importing === 1 || Fail`no import is open`;
    if (part === 'archive') {
      // No importer sends one (7.3): an adopted ArchiveState the adapter
      // cannot validate would fail every later round (J-9493).
      Fail`an import carries no archive part`;
    } else if (part === 'records') {
      /** @type {any[]} */
      const added = chunk.records ?? [];
      /** @type {number} */
      const from = chunk.from ?? Fail`a records chunk names its from`;
      const count = records.count();
      if (from + added.length <= count) return progress();
      from === count || Fail`records continue at ${count}, not ${from}`;
      runner.importTurns(added);
    } else if (part === 'queue') {
      for (const { submission, requestId, at } of chunk.entries ?? []) {
        runner.see(at);
        queue.enqueueOnce(submission, requestId, at);
      }
      const hold = chunk.hold ?? { reason: 'restart', message: '' };
      if (queue.size() > 0)
        queue.hold(hold.reason, hold.message || holdText(hold.reason));
    } else if (part === 'inbox') {
      (inbox ?? Fail`this session has no inbox`).importPage(chunk);
    } else {
      runner.importEnd();
      importing = 2;
      E.sendOnly(rowReporter).changed(
        harden({
          imported: true,
          messageCount: records.messageCount(),
          queuedCount: queue.size(),
        }),
      );
    }
    return progress();
  };

  return harden({
    deleteSelf,
    blobPage,
    exportState,
    importState,
  });
};
harden(makeSessionExport);
