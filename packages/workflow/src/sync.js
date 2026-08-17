// @ts-check

/**
 * The client half of the State Syncing contract.
 *
 * All observation reduces to one primitive: `status()` hands out the
 * resume token (`throughSeq`), `history(fromSeq)` is a gapless record
 * stream, and every view is the shared fold over a prefix. This client
 * consumes an observer facet, maintains a locally folded run state, and
 * resumes from `lastSeq + 1` when its reader dies — apply is idempotent
 * by seq comparison, so crash-looping clients converge.
 *
 * Authority-free: usable in the browser (the Chat space) and the CLI
 * alike.
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';

import { applyEvent } from './fold.js';

/** @import { JournalRecord, RunState } from './types.js' */

/**
 * @param {import('@endo/eventual-send').ERef<any>} observer a run's
 *   observer facet
 * @param {object} [options]
 * @param {(runState: RunState, record: JournalRecord) => void} [options.onEvent]
 * @param {(error: Error) => void} [options.onError]
 */
// After this many consecutive `history()` failures with no intervening
// success the client gives up rather than retrying forever. The retries
// are timer-free (this module stays authority-free / browser-portable),
// so an unbounded loop would spin the microtask queue; a bounded count
// absorbs a transient hiccup and then surfaces the failure via onError.
const MAX_CONSECUTIVE_ERRORS = 10;

// Sentinel a stop-signal race resolves to, distinct from any reader
// result, so a parked `next()` can be preempted by `stop()`.
const STOPPED = harden({ stopped: true });

export const makeWorkflowSyncClient = (observer, options = {}) => {
  const { onEvent, onError } = options;
  /** @type {RunState | undefined} */
  let runState;
  let lastSeq = 0;
  let stopped = false;
  /** @type {((value?: unknown) => void) | undefined} */
  let signalStop;
  // Resolves when `stop()` is called; racing every await against it makes
  // stop preemptive even when the reader is parked on an idle/finished
  // run that will never emit another record.
  const stopSignal = new Promise(resolve => {
    signalStop = resolve;
  });
  const stopRace = stopSignal.then(() => STOPPED);
  /** @type {JournalRecord[]} */
  const records = [];

  /** @param {JournalRecord} record */
  const apply = record => {
    if (record.seq <= lastSeq) {
      return; // idempotent resume: overlap is discarded exactly
    }
    runState = applyEvent(runState, record);
    lastSeq = record.seq;
    records.push(record);
    if (onEvent !== undefined && runState !== undefined) {
      onEvent(runState, record);
    }
  };

  const run = (async () => {
    await null;
    let consecutiveErrors = 0;
    while (!stopped) {
      /** @type {any} */
      let reader;
      try {
        // Racing history() against the stop signal means a stop during
        // connection setup exits promptly too.
        // eslint-disable-next-line no-await-in-loop
        reader = await Promise.race([
          E(observer).history(lastSeq + 1),
          stopRace,
        ]);
      } catch (error) {
        if (onError !== undefined) {
          onError(/** @type {Error} */ (error));
        }
        consecutiveErrors += 1;
        if (stopped || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          return;
        }
        // eslint-disable-next-line no-continue
        continue;
      }
      if (reader === STOPPED) {
        return;
      }
      try {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const result = await Promise.race([reader.next(), stopRace]);
          if (result === STOPPED || stopped) {
            // eslint-disable-next-line no-await-in-loop
            await reader.return?.(undefined);
            return;
          }
          if (result.done) {
            return; // reader completed cleanly
          }
          apply(/** @type {JournalRecord} */ (result.value));
          consecutiveErrors = 0; // progress resets the failure budget
        }
      } catch (error) {
        if (onError !== undefined) {
          onError(/** @type {Error} */ (error));
        }
        consecutiveErrors += 1;
        if (stopped || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          return;
        }
        // Resume from the last applied seq on the next iteration.
      }
    }
  })();

  return harden({
    get state() {
      return runState;
    },
    get lastSeq() {
      return lastSeq;
    },
    get records() {
      return harden([...records]);
    },
    /**
     * Fold the locally synced prefix through a seq — the space's
     * time-travel scrubber, instant and offline.
     *
     * @param {number} throughSeq
     */
    stateAt: throughSeq => {
      /** @type {RunState | undefined} */
      let folded;
      for (const record of records) {
        if (record.seq > throughSeq) {
          break;
        }
        folded = applyEvent(folded, record);
      }
      return folded;
    },
    stop: () => {
      stopped = true;
      // Wake a parked next()/history() so `done` settles promptly and
      // the underlying reader is returned rather than leaked.
      signalStop?.();
    },
    done: run,
  });
};
harden(makeWorkflowSyncClient);
