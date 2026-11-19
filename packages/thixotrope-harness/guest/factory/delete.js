// @ts-check
/**
 * `SessionFactory.deleteSession` (M2 W2.7; `designs/m2-interfaces.md` 7.1,
 * 4.11; R4-9, D-17).
 *
 * `makeDeletions({ admin, rows, onDelete? })` keeps one delete record per
 * session in this vat's heap and runs its steps in order, one answered call
 * per step (each answer arrives in its own crank):
 *
 * 1. the row becomes `deleting` (published as a row change);
 *    `E(internal).deleteSelf()` fences the session (it refuses new work,
 *    cancels its turn, starts no seal); any failure (a lost vat answers
 *    the retired text) skips to step 3;
 * 2. `E(internal).blobPage(cursor)` -> `E(admin).releaseBlobs(blobs)` until
 *    no `next` (the live tail's staged fields, the checkpoint, the waiting
 *    entries); a failure of the session vat skips to step 3;
 * 3. `E(admin).releaseArchive(session)`: the adapter unlinks every blob the
 *    session's segments and mirror name and removes its archive directory;
 * 4. the session's exec vat is retired and its handle closed
 *    (`pool.js` `closeExecHandle`), then the session vat
 *    (`E(facade).retire()`; a facade already gone is fine);
 * 5. the row is dropped: the list feed publishes `row-removed`, and the
 *    delete answers.
 *
 * A failure of the manager (steps 2 and 3) rejects that call of
 * `deleteSession`; the record stays at its step. `resume()` (the start
 * listener, every daemon start) runs every record again from its step, as
 * does another `deleteSession` of the same session. Every step is
 * idempotent: the manager skips handles it forgot, the adapter's archive
 * release tolerates a missing directory, and a retired vat answers the
 * retired text. A newer run makes an older one stop at its next answer.
 *
 * `onDelete` hooks (M9: subagents depth-first; M6: workspaces) run before
 * step 1; the table is empty in M2.
 *
 * Guest rules: prelude globals only; records in a `Map` keyed by the row;
 * one answered send in flight per record.
 */
import { texts } from '../lib/guards/factory.js';
import { closeExecHandle } from './pool.js';

/** @import { StartCount } from './starts.js' */
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { Row, RowTable } from './rows.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Hook table (append-only; M9, M6): `async ({ row, session }) => void`.
 * @type {readonly ((context: { row: Row, session: any }) => Promise<void>)[]}
 */
export const onDelete = harden([]);

/**
 * @typedef {object} DeleteRecord
 * @property {Row} row
 * @property {1 | 2 | 3 | 4 | 5} step the step to run (again) next
 * @property {string | undefined} cursor the next blob page's cursor
 * @property {number} runs runs started; a run stops once a newer one began
 * @property {Promise<void> | undefined} done the latest run
 * @property {number} startedAt the daemon start (`starts.js`) of the latest
 *   run
 */

/**
 * @param {object} powers
 * @param {any} powers.admin the AgentHostAdmin
 * @param {RowTable} powers.rows
 * @param {StartCount} powers.starts the factory's start count (the start
 *   listener raises it before `resume`)
 * @param {typeof onDelete} [powers.hooks]
 */
export const makeDeletions = ({ admin, rows, starts, hooks = onDelete }) => {
  /** @type {Map<Row, DeleteRecord>} */
  const records = new Map();
  const counts = { started: 0, completed: 0, failed: 0, resumed: 0 };

  /** @param {DeleteRecord} record */
  const run = async record => {
    record.runs += 1;
    record.startedAt = starts.current();
    const me = record.runs;
    const { row } = record;
    const live = () => record.runs === me && records.get(row) === record;
    if (record.step === 1) {
      rows.markDeleting(row);
      for (const hook of hooks) {
        // eslint-disable-next-line no-await-in-loop
        await hook({ row, session: row.session });
        if (!live()) return;
      }
      let fenced = true;
      try {
        await E(row.internal).deleteSelf();
      } catch {
        // A lost session vat (the retired text) or an older program.
        fenced = false;
      }
      if (!live()) return;
      record.step = fenced ? 2 : 3;
    }
    while (record.step === 2) {
      /** @type {any} */
      /** @type {{ blobs: any[], next?: string } | undefined} */
      let page;
      try {
        // eslint-disable-next-line no-await-in-loop
        page = await (record.cursor === undefined
          ? E(row.internal).blobPage()
          : E(row.internal).blobPage(record.cursor));
      } catch {
        page = undefined;
      }
      if (!live()) return;
      if (page === undefined) {
        record.step = 3;
      } else {
        if (page.blobs.length > 0) {
          // A failure here (the manager lost) rejects; the record stays.
          // eslint-disable-next-line no-await-in-loop
          await E(admin).releaseBlobs(page.blobs);
          if (!live()) return;
        }
        if (page.next === undefined) record.step = 3;
        else record.cursor = page.next;
      }
    }
    if (record.step === 3) {
      await E(admin).releaseArchive(row.session);
      if (!live()) return;
      record.step = 4;
    }
    if (record.step === 4) {
      if (row.execVat !== undefined) closeExecHandle(row.execVat);
      if (row.facade !== undefined) {
        await E(row.facade)
          .retire()
          .catch(() => undefined);
        if (!live()) return;
      }
      record.step = 5;
    }
    records.delete(row);
    rows.drop(row);
    counts.completed += 1;
  };

  /** @param {DeleteRecord} record */
  const start = record => {
    const done = run(record).catch(error => {
      if (records.get(record.row) === record) counts.failed += 1;
      throw error;
    });
    record.done = done;
    return done;
  };

  /**
   * Delete a ready, errored or lost session (R4-9, D-17). Settles when the
   * delete completed, or rejects with the failure of this run (the record
   * stays and a restart completes it).
   * @param {any} session
   */
  const deleteSession = async session => {
    const row = rows.ofSession(session);
    if (row === undefined || row.dropped) throw Error(texts.unknownSession);
    const known = records.get(row);
    if (known !== undefined) {
      // A run of this start still going: wait for it; else run again.
      if (known.startedAt === starts.current() && known.done !== undefined) {
        const settled = await known.done.then(
          () => true,
          () => false,
        );
        if (settled || records.get(row) !== known) return undefined;
      }
      return start(known);
    }
    /** @type {DeleteRecord} */
    const record = {
      row,
      step: 1,
      cursor: undefined,
      runs: 0,
      done: undefined,
      startedAt: starts.current(),
    };
    records.set(row, record);
    counts.started += 1;
    return start(record);
  };

  /**
   * Every daemon start (the factory's start listener): run every record
   * again from its step. Settles when every run settled.
   */
  const resume = async () => {
    const pending = [...records.values()];
    counts.resumed += pending.length;
    await Promise.all(pending.map(record => start(record).catch(() => {})));
  };

  return harden({
    delete: deleteSession,
    resume,
    /** @param {Row} row */
    isDeleting: row => records.has(row),
    /** Delete records not yet completed (tests, status). */
    pending: () => records.size,
    counts: () => harden({ ...counts, pending: records.size }),
  });
};
harden(makeDeletions);

/** @typedef {ReturnType<typeof makeDeletions>} Deletions */
