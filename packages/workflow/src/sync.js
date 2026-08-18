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
  let broken = false;
  // Disposal goes through the LOCAL iterator's `return()` (the remote
  // reader exposes no `return` method); it signals the responder so the
  // service-side follower is released promptly.
  /** @type {any} */
  let iterator;

  const consumed = (async () => {
    await null;
    try {
      const reader = await E(run).follow({ since: 0n });
      iterator = iterateEntries(reader);
      if (stopped) {
        // stop() ran while follow() was in flight; close what we made.
        await iterator.return?.(undefined);
        return;
      }
      for await (const entry of iterator) {
        if (stopped) {
          return;
        }
        try {
          applyEntry(fold, entry);
          log.push(entry);
        } catch (error) {
          // A malformed entry breaks the mirror, not the caller; the
          // fold freezes and `broken` marks the divergence.
          broken = true;
          if (onError !== undefined) {
            onError(error);
          }
          return;
        }
        if (onEntry !== undefined) {
          try {
            onEntry(entry);
          } catch {
            // A listener throw must not kill the mirror.
          }
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
    /** True when a malformed entry froze the mirror. */
    isBroken: () => broken,
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
      if (iterator !== undefined && typeof iterator.return === 'function') {
        Promise.resolve(iterator.return(undefined)).catch(() => {});
      }
    },
  });
};
harden(makeRunSyncClient);
