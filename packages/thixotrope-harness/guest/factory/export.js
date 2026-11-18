// @ts-check
/**
 * Data-only export and import, factory side (M2 W2.7;
 * `designs/m2-interfaces.md` 7.3; architecture 9).
 *
 * `makeFactoryExport({ rows, settings, create })` gives the `HarnessRoot`
 * methods:
 *
 * - `exportPage(cursor?)`: the operator settings on the first page (no
 *   cursor), then the sessions in creation order, at most `sessionPageRows`
 *   and `frameBytes` a page, each `{ session, internal, key, title, state,
 *   userInitiated }`; `next` is the last key shown. Rows being created,
 *   deleted or imported are left out. The exporter (`scripts/export.mjs`)
 *   reads each session's own pages through its `internal`.
 * - `importSession(options)`: a creation (contract 9) whose row stays
 *   unlisted until the session reports its import's `end` (7.2); a restart
 *   before then deletes it (the factory's start listener).
 *
 * Exec bindings are not exportable (they live in the exec vat's scope, not
 * in records): an imported session starts with an empty scope. Secrets are
 * not exported (re-create them); presets are M5.
 *
 * Guest rules: prelude globals only.
 */
import { shapes, texts } from '../lib/guards/factory.js';
import { limits } from '../lib/limits.js';
import { messageBytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RowTable, Row } from './rows.js' */
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/** Bytes kept free in a page for the settings, `next` and the envelope. */
const PAGE_SLACK = 4096;

/** @param {Row} row */
const exportable = row =>
  !row.dropped &&
  !row.importing &&
  row.session !== undefined &&
  row.state !== 'creating' &&
  row.state !== 'deleting';

/**
 * @param {object} powers
 * @param {RowTable} powers.rows
 * @param {{ current: () => any }} powers.settings the operator settings
 * @param {(options: any, how: { importing: boolean }) => Promise<any>} powers.create
 *   the factory's creation (factory.js)
 */
export const makeFactoryExport = ({ rows, settings, create }) => {
  /** @param {string} [cursor] the last key of the previous page */
  const exportPage = cursor => {
    const order = rows.all();
    let start = 0;
    if (cursor !== undefined) {
      const after = rows.get(cursor);
      if (after === undefined) throw Error(texts.unknownSession);
      start = order.indexOf(after) + 1;
    }
    /** @type {any[]} */
    const sessions = [];
    let bytes = PAGE_SLACK;
    let more = false;
    for (let i = start; i < order.length; i += 1) {
      const row = order[i];
      if (exportable(row)) {
        const entry = harden({
          session: row.session,
          internal: row.internal,
          key: row.key,
          title: row.title,
          state: row.state,
          userInitiated: row.userInitiated,
        });
        const size = messageBytes(entry);
        if (
          sessions.length >= limits.sessionPageRows ||
          (sessions.length > 0 && bytes + size > limits.frameBytes)
        ) {
          more = true;
          break;
        }
        bytes += size;
        sessions.push(entry);
      }
    }
    /** @type {Record<string, any>} */
    const page = { sessions };
    if (cursor === undefined) page.settings = settings.current();
    if (more) page.next = sessions[sessions.length - 1].key;
    const result = harden(page);
    mustMatch(result, shapes.FactoryExportPage);
    return result;
  };

  /** @param {any} options `shapes.CreateOptions` (checked by the guard) */
  const importSession = options => create(options, { importing: true });

  return harden({ exportPage, importSession });
};
harden(makeFactoryExport);
