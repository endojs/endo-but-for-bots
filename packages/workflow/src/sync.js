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
export const makeWorkflowSyncClient = (observer, options = {}) => {
  const { onEvent, onError } = options;
  /** @type {RunState | undefined} */
  let runState;
  let lastSeq = 0;
  let stopped = false;
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
    while (!stopped) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const reader = await E(observer).history(lastSeq + 1);
        // eslint-disable-next-line no-await-in-loop
        for await (const record of reader) {
          if (stopped) {
            await reader.return?.(undefined);
            break;
          }
          apply(/** @type {JournalRecord} */ (record));
        }
        if (!stopped) {
          return; // reader completed cleanly
        }
      } catch (error) {
        if (onError !== undefined) {
          onError(/** @type {Error} */ (error));
        }
        if (stopped) {
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
    },
    done: run,
  });
};
harden(makeWorkflowSyncClient);
