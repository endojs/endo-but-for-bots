// @ts-check

/**
 * A client-side mirror of one workflow run, built by consuming the run
 * facet's `follow` stream and applying the same journal fold the engine
 * uses. For UI spaces and remote observers: `current()` is always the
 * state as of the last received entry, `stateAt(seq)` refolds any
 * historical prefix (time travel over the audit log), and `verify()`
 * checks the journal's hash chain client-side.
 */

import { E } from '@endo/eventual-send';
import {
  applyEntry,
  initialFoldState,
  foldJournal,
  verifyJournalChain,
} from './journal.js';

const snapshotOf = fold =>
  harden({
    state:
      fold.configuration === undefined ? undefined : fold.configuration.state,
    configuration: fold.configuration,
    context: fold.context,
    seq: fold.nextSeq,
    paused: fold.paused,
    done: fold.done,
    ...(fold.outcome !== undefined ? { outcome: fold.outcome } : {}),
    ...(fold.output !== undefined ? { output: fold.output } : {}),
    ...(fold.reason !== undefined ? { reason: fold.reason } : {}),
    pending: harden([...fold.pending.values()]),
  });

/**
 * @param {any} run - a `WorkflowRun` facet (or presence)
 * @param {object} [options]
 * @param {(reader: any) => AsyncIterable<any>} [options.iterateEntries] -
 *   seam for consuming the follow reader; defaults to treating it as an
 *   async iterable (tests) — over CapTP pass `iterateReader` from
 *   `@endo/exo-stream`.
 * @param {(entry: any) => void} [options.onEntry] - called after each
 *   entry is applied
 * @param {(error: any) => void} [options.onError]
 */
export const makeRunSyncClient = (
  run,
  {
    iterateEntries = reader => reader,
    onEntry = undefined,
    onError = undefined,
  } = {},
) => {
  const fold = initialFoldState();
  /** @type {any[]} */
  const log = [];
  let stopped = false;
  /** @type {any} */
  let reader;

  const consumed = (async () => {
    await null;
    try {
      reader = await E(run).follow({ since: 0n });
      for await (const entry of iterateEntries(reader)) {
        if (stopped) {
          return;
        }
        applyEntry(fold, entry);
        log.push(entry);
        if (onEntry !== undefined) {
          onEntry(entry);
        }
      }
    } catch (error) {
      if (!stopped && onError !== undefined) {
        onError(error);
      }
    }
  })();

  return harden({
    /** The mirrored state as of the last received entry. */
    current: () => snapshotOf(fold),
    /** The journal entries received so far. */
    entries: () => harden([...log]),
    /**
     * The run's state just before `seq` — a refold of the received
     * prefix.
     *
     * @param {bigint} seq
     */
    stateAt: seq =>
      snapshotOf(
        foldJournal(
          log.filter(entry => /** @type {bigint} */ (entry.seq) < seq),
        ),
      ),
    /** Verify the received journal's hash chain. */
    verify: () => verifyJournalChain(log),
    /** Resolves when the follow stream ends (run terminal or stopped). */
    done: () => consumed,
    stop: () => {
      stopped = true;
      if (reader !== undefined) {
        E(reader)
          .return(undefined)
          .catch(() => {});
      }
    },
  });
};
harden(makeRunSyncClient);
