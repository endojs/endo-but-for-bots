// @ts-check
/**
 * The turn runner's outbox (contract 5; one publish per crank): the events
 * of this crank in order, a `pending` event owed by a queue change, and the
 * merged row patch. The runner decides where a crank's work ends and calls
 * `flushTo(ports)` there; this module only collects and sends.
 *
 * - `flushTo(ports)`: the row patch (`RowReporter.changed`, sendOnly), then
 *   the events: through the turn's publisher (`live.inTurn`, sendOnly) with
 *   ports, else outside a turn (`live.outside`, answered). A crank with no
 *   event publishes nothing.
 * - `schedule(flush)`: `flush` once at the end of this crank's synchronous
 *   work (a queue change reported from outside the runner).
 *
 * Guest rules; no record keys from data.
 */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { LivePublishing } from './live.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {object} options
 * @param {LivePublishing} options.live
 * @param {any} options.rowReporter
 * @param {() => any} options.pendingView the queue's `view()`, read at flush
 */
export const makeOutbox = ({ live, rowReporter, pendingView }) => {
  /**
   * events of this crank, in order
   * @type {any[]}
   */
  let events = [];
  /** a `pending` event is owed (added last, with the queue's view at flush) */
  let pendingOwed = false;
  /**
   * the merged row patch of this crank
   * @type {Record<string, any> | undefined}
   */
  let rowPatch;
  let flushScheduled = false;

  const takeEvents = () => {
    const taken = events;
    events = [];
    if (pendingOwed) {
      pendingOwed = false;
      taken.push(harden({ type: 'pending', pending: pendingView() }));
    }
    return taken;
  };

  const flushRow = () => {
    if (rowPatch === undefined) return;
    const patch = harden({ ...rowPatch });
    rowPatch = undefined;
    E.sendOnly(rowReporter).changed(patch);
  };

  return harden({
    /** @param {any} event */
    emit: event => {
      events.push(harden(event));
    },
    /** @param {Record<string, any>} patch RowPatch fields */
    report: patch => {
      rowPatch = { ...(rowPatch ?? {}), ...patch };
    },
    /** A `pending` event is owed at the next flush. */
    owePending: () => {
      pendingOwed = true;
    },
    flushRow,
    /**
     * Publish the outbox to these ports (sendOnly) or, without ports,
     * outside a turn (answered); send the row patch first.
     * @param {any} ports
     */
    flushTo: ports => {
      flushRow();
      const taken = takeEvents();
      if (taken.length === 0) return;
      if (ports !== undefined) {
        live.inTurn(ports, taken);
      } else {
        void live.outside(taken);
      }
    },
    /**
     * Run `flush` at the end of this crank's synchronous work, once.
     * @param {() => void} flush
     */
    schedule: flush => {
      if (flushScheduled) return;
      flushScheduled = true;
      void Promise.resolve().then(() => {
        flushScheduled = false;
        flush();
      });
    },
  });
};
harden(makeOutbox);
