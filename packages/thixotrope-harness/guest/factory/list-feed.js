// @ts-check
/**
 * The session list feed, factory side (M1b W1b.5; architecture D-8, 3.1;
 * `designs/m1b-interfaces.md` sections 3.5, 6.7 and 10.2).
 *
 * The factory never holds viewers. It collects the rows a crank changed and
 * publishes them as one batch, `E.sendOnly(listPublisher).publish({ rev,
 * events })`, to the agent-host adapter's list channel
 * (`AH/list-channel.js`), which fans out to viewers in process. `rev` counts
 * published batches (one more per batch); `listSessions().rev` and
 * `sessionListFeed().rev` report it, so a viewer that sees a rev gap
 * re-reads `listSessions`.
 *
 * Events: `{ type: 'row', row }` for a listed row that changed (its state at
 * flush time, so several changes in one crank are one event) and
 * `{ type: 'row-removed', session, key }` for a row that had been published
 * and is gone. A batch holds at most `publishBatchEvents` events and
 * `frameBytes` bytes; more rows split into more batches, each its own rev,
 * at most `MAX_BATCHES_PER_FLUSH` per flush; the rest go out in the crank
 * a publisher refresh answers in.
 *
 * When it flushes: on a microtask after the first change of a crank (so the
 * crank's later changes join it), and when the factory calls `flush()`.
 *
 * The publisher belongs to one adapter incarnation: after a restart it is a
 * tombstone (sendOnly to it drops silently, fact 5). `refresh()` (the start
 * listener) asks the manager for the current one with
 * `E(admin).listPublisher()`. While none is known (before the first
 * refresh answers, or a manager without the method) batches are still
 * numbered but not sent.
 *
 * Guest rules: prelude globals only; pending rows in a `Map` keyed by the
 * row object; sendOnly only; events are fixed-key records.
 */
import { shapes } from '../lib/guards/factory.js';
import { limits } from '../lib/limits.js';
import { messageBytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { Row } from './rows.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/** Batches one flush sends at most (well under `sendsPerCrank`). */
export const MAX_BATCHES_PER_FLUSH = 16;
/** Bytes kept free in a batch for `rev`, `events` and the envelope. */
const BATCH_OVERHEAD_BYTES = 512;

/**
 * @param {object} powers
 * @param {any} powers.admin the AgentHostAdmin (`listPublisher()`)
 * @param {(row: Row) => any} powers.listed the published form of a row
 *   (`shapes.SessionRow`; rows.js `listed`)
 * @param {(row: Row) => boolean} powers.isListed whether a row is listed
 */
export const makeListFeed = ({ admin, listed, isListed }) => {
  /** @type {any} */
  let publisher;
  let rev = 0;
  /** @type {Map<Row, 'row' | 'removed'>} rows changed since the last flush */
  const pending = new Map();
  /** Rows published as listed (a later removal is published for them). */
  const published = new WeakSet();
  let scheduled = false;
  const counts = { batches: 0, events: 0, sent: 0, refreshes: 0 };

  /** @param {Row} row */
  const eventOf = row => {
    if (pending.get(row) === 'removed' || row.dropped) {
      return published.has(row)
        ? harden({ type: 'row-removed', session: row.session, key: row.key })
        : undefined;
    }
    if (!isListed(row)) return undefined;
    return harden({ type: 'row', row: listed(row) });
  };

  /** @param {readonly any[]} events */
  const send = events => {
    rev += 1;
    counts.batches += 1;
    counts.events += events.length;
    const batch = harden({ rev, events });
    mustMatch(batch, shapes.ListPublishBatch);
    if (publisher !== undefined) {
      counts.sent += 1;
      E.sendOnly(publisher).publish(batch);
    }
  };

  const flush = () => {
    scheduled = false;
    if (pending.size === 0) return;
    /** @type {any[]} */
    let events = [];
    let bytes = BATCH_OVERHEAD_BYTES;
    let batches = 0;
    for (const row of [...pending.keys()]) {
      if (batches >= MAX_BATCHES_PER_FLUSH) break;
      const event = eventOf(row);
      pending.delete(row);
      if (event !== undefined) {
        if (event.type === 'row') published.add(row);
        else published.delete(row);
        const size = messageBytes(event);
        if (
          events.length > 0 &&
          (events.length >= limits.publishBatchEvents ||
            bytes + size > limits.frameBytes)
        ) {
          send(events);
          batches += 1;
          events = [];
          bytes = BATCH_OVERHEAD_BYTES;
        }
        events.push(event);
        bytes += size;
      }
    }
    if (events.length > 0) send(events);
    if (pending.size > 0) {
      // Over this crank's batches (M1b QC advisory): the rest go out in a
      // later crank, the one the manager's answer arrives in, which also
      // fetches the current publisher.
      scheduled = true;
      void refresh().then(flush);
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(flush);
  };

  /**
   * Fetch the current adapter incarnation's publisher (every start).
   * Settles either way; a manager without `listPublisher` leaves the
   * feed unpublished.
   */
  const refresh = async () => {
    counts.refreshes += 1;
    try {
      publisher = await E(admin).listPublisher();
    } catch {
      publisher = undefined;
    }
  };

  return harden({
    /**
     * A row changed (any field, its state, its listing).
     * @param {Row} row
     */
    changed: row => {
      if (pending.get(row) !== 'removed') pending.set(row, 'row');
      schedule();
    },
    /**
     * A row is gone (a rolled-back creation; M2 deletions).
     * @param {Row} row
     */
    removed: row => {
      pending.set(row, 'removed');
      schedule();
    },
    flush,
    /** The rev of the last batch numbered. */
    rev: () => rev,
    refresh,
    /** Counters (tests, diagnostics). */
    counts: () => harden({ ...counts, pending: pending.size }),
  });
};
harden(makeListFeed);

/** @typedef {ReturnType<typeof makeListFeed>} ListFeed */
