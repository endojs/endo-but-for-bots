// @ts-check
// The session's ContextSource (W1b.2; m1b-interfaces.md 6.5, 9; M2 W2.5:
// m2-interfaces.md 4.8): records as recorded, pages of up to
// contextPageBytes (to the adapter only). Cursor `p<index>`; no cursor:
// max(compaction boundary, the archive's `sealedTo`). Records below
// `sealedTo` are in the archive: a cursor there throws `recordsSealed`.
// `segments(cursor?)` pages the archive's index (`s<n>`).
import { interfaces, texts } from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { plainBytes } from './records.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RecordLog } from './records.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

/** Bytes kept free in a page for its wrapper and the blob slots. */
const SLACK = 2048;

const noSegments = harden({ segments: harden([]) });

/**
 * @param {object} options
 * @param {RecordLog} options.records
 * @param {{ segments: (cursor?: string) => any }} [options.archive] the
 *   session's archive (W2.5 archive.js)
 * @param {() => number} [options.boundary] index of the latest compaction
 *   boundary (M8 moves it; until then 0)
 */
export const makeContextSource = ({ records, archive, boundary = () => 0 }) =>
  makeExo('ContextSource', interfaces.ContextSource, {
    /** @param {string} [cursor] */
    page(cursor) {
      const count = records.count();
      const sealedTo = records.base();
      let from = Math.max(boundary(), sealedTo);
      if (cursor !== undefined) {
        const match = /^p(0|[1-9][0-9]*)$/.exec(cursor);
        const n = match === null ? NaN : Number(match[1]);
        if (Number.isSafeInteger(n) && n < sealedTo) {
          throw Error(texts.recordsSealed);
        }
        if (!(Number.isSafeInteger(n) && n >= from && n <= count)) {
          throw Error(texts.badCursor);
        }
        from = n;
      }
      const budget = limits.contextPageBytes - SLACK;
      // Only the page's own records are touched (M1b QC, J-0392): copying
      // the log's tail for every page made a rebuild O(n^2 / page) and
      // allocated O(n) in each page crank.
      /** @type {any[]} */
      const page = [];
      let used = 0;
      for (
        let i = from;
        i < count && page.length < limits.pageRecords;
        i += 1
      ) {
        const record = records.at(i);
        const bytes = plainBytes(record);
        if (page.length > 0 && used + bytes > budget) break;
        page.push(record);
        used += bytes;
      }
      /** @type {Record<string, any>} */
      const result = { from, records: harden(page) };
      if (from + page.length < count) result.next = `p${from + page.length}`;
      return harden(result);
    },
    /** @param {string} [cursor] */
    segments(cursor) {
      return archive === undefined ? noSegments : archive.segments(cursor);
    },
  });
harden(makeContextSource);
