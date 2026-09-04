// @ts-check

import { Fail, q } from '@endo/errors';

const OUTCOME_TYPES = harden(['completed', 'aborted', 'failed']);

/**
 * @typedef {{ baseCheckpoint: string | null, checkpoint?: string, status: 'started' | 'completed' }} TurnRecord
 * @typedef {{ type: 'completed', checkpoint: string } | { type: 'aborted', reason: string } | { type: 'failed', reason: string }} TurnOutcome
 * @typedef {{ settled: TurnOutcome | undefined }} InFlightTurn
 */

/**
 * The durability protocol every hosted backend needs, in one place.
 *
 * A hosted turn is not durable because the provider says it finished. The
 * consumer commits its own conversation only on a terminal event and
 * acknowledges afterwards, so between dispatch and acknowledgement the backend
 * owes three things, and every backend that omits one of them is broken the
 * same way:
 *
 * 1. **Write-ahead.** Record what is about to be dispatched *before*
 *    dispatching it, so a crash leaves a marker naming the checkpoint the
 *    provider's history must be rolled back to.
 * 2. **Exactly one terminal outcome.** A turn settles once. A provider that
 *    keeps talking after a failure — a `completed` notification already in
 *    flight when the session was quarantined — must not be able to rewrite a
 *    settled turn's durable marker or deliver a second terminal event to a
 *    consumer that has already seen the first.
 * 3. **Reconciliation.** Until the consumer acknowledges, the recorded turn is
 *    unacknowledged: either it is rolled out of the provider's history or the
 *    session is quarantined. Answering "is anything outstanding?" must not
 *    depend on remembering to clear a flag on every path.
 *
 * The ledger owns all three so a backend adapter is left with the parts that
 * are genuinely provider-specific: how to dispatch, how to read the latest
 * checkpoint, and how to revert.
 *
 * Its guards run *before* the first `await` on purpose, which is why several
 * methods here draw `safe-await-separator`: latching an outcome or claiming
 * the in-flight slot a microtask later would reopen exactly the race this
 * module exists to close.
 *
 * @param {object} options
 * @param {(record: TurnRecord | undefined) => Promise<void>} options.persist -
 *   Durably record (or clear) the marker. Must not resolve before the write is
 *   durable: the whole protocol rests on it.
 * @param {(event: string, detail: Record<string, string>) => Promise<void>} [options.audit]
 * @param {TurnRecord} [options.recovery] - A marker loaded from durable state,
 *   which means a previous turn was dispatched and never acknowledged.
 */
export const makeTurnLedger = ({
  persist,
  audit = async (_event, _detail) => {},
  recovery: loaded,
}) => {
  typeof persist === 'function' || Fail`Turn ledger requires a persist hook`;

  /** @type {TurnRecord | undefined} */
  let record = loaded;
  // A loaded marker is by definition unacknowledged: the process that wrote it
  // did not live to clear it.
  let needsReconciliation = Boolean(loaded);
  /** @type {InFlightTurn | undefined} */
  let inFlight;

  return harden({
    /**
     * Write-ahead a turn and take the in-flight slot.
     *
     * @param {object} request
     * @param {string | null} request.baseCheckpoint - The provider checkpoint
     *   this turn builds on; `null` when there is nothing before it.
     * @returns {Promise<TurnHandle>}
     */
    async begin({ baseCheckpoint }) {
      inFlight === undefined ||
        Fail`A turn is already in flight; settle it before beginning another`;
      baseCheckpoint === null ||
        (typeof baseCheckpoint === 'string' && baseCheckpoint !== '') ||
        Fail`Base checkpoint must be a non-empty string or null, not ${q(baseCheckpoint)}`;
      /** @type {InFlightTurn} */
      const turn = { settled: undefined };
      // The slot is taken before the await so two concurrent `begin` calls
      // cannot both pass the guard above.
      inFlight = turn;
      const next = harden({
        baseCheckpoint,
        status: /** @type {const} */ ('started'),
      });
      try {
        await persist(next);
      } catch (error) {
        inFlight = undefined;
        throw error;
      }
      record = next;
      needsReconciliation = true;

      /**
       * @typedef {object} TurnHandle
       * @property {(outcome: TurnOutcome) => Promise<{ accepted: boolean, outcome: TurnOutcome }>} settle
       * @property {(checkpoint: string) => Promise<void>} observe
       * @property {() => TurnOutcome | undefined} settledOutcome
       */
      return harden({
        /**
         * Settle this turn. The first call wins and is the only one that
         * changes durable state or is reported as accepted; a later call — a
         * provider notification that was already in flight when the session
         * failed, say — is reported as a duplicate carrying the outcome that
         * did win, so the caller can decline to deliver a second terminal
         * event to its consumer.
         *
         * @param {TurnOutcome} outcome
         */
        async settle(outcome) {
          (outcome && typeof outcome === 'object') ||
            Fail`Turn outcome must be a record`;
          if (turn.settled !== undefined) {
            return harden({ accepted: false, outcome: turn.settled });
          }
          const type = /** @type {string} */ (
            /** @type {any} */ (outcome).type
          );
          OUTCOME_TYPES.includes(type) || Fail`Unknown turn outcome ${q(type)}`;
          // Narrow on `outcome.type`, not on the string extracted from it: a
          // discriminant read into a local no longer discriminates the union,
          // so `outcome.checkpoint` was an unchecked property access here.
          if (outcome.type === 'completed') {
            (typeof outcome.checkpoint === 'string' &&
              outcome.checkpoint !== '') ||
              Fail`A completed turn must name its checkpoint`;
          }
          // Latch before the first await: an outcome arriving while this one is
          // being persisted must lose, not interleave with it.
          turn.settled = harden(outcome);
          if (inFlight === turn) inFlight = undefined;
          if (outcome.type === 'completed') {
            const committed = harden({
              baseCheckpoint: /** @type {TurnRecord} */ (record).baseCheckpoint,
              checkpoint: outcome.checkpoint,
              status: /** @type {const} */ ('completed'),
            });
            record = committed;
            await persist(committed);
          }
          // An aborted or failed turn keeps the write-ahead marker: it is
          // exactly what reconciliation needs to roll the provider back.
          return harden({ accepted: true, outcome: turn.settled });
        },
        /**
         * Record the provider's identifier for this turn as soon as it is
         * known, while it is still running.
         *
         * Reconciliation can then tell "the turn I dispatched is still the
         * newest thing in history" from "something else has been appended
         * since", which a base checkpoint alone cannot distinguish. Refused
         * once the turn has settled: the marker then describes a finished
         * turn and must not be edited underneath it.
         *
         * @param {string} checkpoint
         */
        async observe(checkpoint) {
          (typeof checkpoint === 'string' && checkpoint !== '') ||
            Fail`An observed checkpoint must be a non-empty string`;
          turn.settled === undefined ||
            Fail`Turn already settled as ${q(turn.settled.type)}`;
          const noted = harden({
            baseCheckpoint: /** @type {TurnRecord} */ (record).baseCheckpoint,
            checkpoint,
            status: /** @type {const} */ ('started'),
          });
          await persist(noted);
          // A settlement that won the latch while this write was in flight
          // owns the record; do not overwrite what it persisted.
          if (turn.settled === undefined) record = noted;
        },
        settledOutcome: () => turn.settled,
      });
    },

    /**
     * Clear the marker for a checkpoint the consumer has durably committed.
     *
     * Idempotent when nothing is outstanding — a consumer that acknowledges
     * twice after a crash must not be told it did something wrong — but a
     * checkpoint that is not the one awaiting acknowledgement is refused,
     * because clearing the marker for it would strand a real turn.
     *
     * @param {string} checkpoint
     */
    async acknowledge(checkpoint) {
      await null;
      if (!record) {
        await audit('turn-commit-already-acknowledged', { checkpoint });
        return;
      }
      (record.status === 'completed' && record.checkpoint === checkpoint) ||
        Fail`Checkpoint ${q(checkpoint)} is not awaiting acknowledgement`;
      await persist(undefined);
      record = undefined;
      needsReconciliation = false;
      await audit('turn-committed', { checkpoint });
    },

    /**
     * Roll an unacknowledged turn out of the provider's history.
     *
     * The shape is the same for every provider — compare the latest checkpoint
     * against the recorded base, revert, verify the revert actually restored
     * it — so only the two provider calls are injected. A mismatch is not
     * recovered from: it means the history moved under an unacknowledged turn,
     * and continuing would silently build on state the consumer never saw.
     *
     * @param {object} operations
     * @param {() => Promise<string | null>} operations.readLatestCheckpoint
     * @param {(beforeCheckpoint: string) => Promise<void>} operations.revertBefore
     * @returns {Promise<boolean>} whether a revert was performed
     */
    async reconcile({ readLatestCheckpoint, revertBefore }) {
      await null;
      if (!needsReconciliation || !record) return false;
      const { baseCheckpoint } = record;
      const latest = await readLatestCheckpoint();
      await audit('history-reconciliation-started', {
        baseCheckpoint: baseCheckpoint || '',
        latestCheckpoint: latest || '',
      });
      if (latest === baseCheckpoint) {
        // A crash between dispatch and the provider recording the turn, or a
        // revert whose marker was never cleared. Either way there is nothing
        // to undo, which makes this path idempotent.
        await audit('history-reconciled', {
          strategy: 'checkpoint-already-restored',
        });
        await persist(undefined);
        record = undefined;
        needsReconciliation = false;
        return false;
      }
      !(record.checkpoint && latest !== record.checkpoint) ||
        Fail`Provider history advanced beyond the unacknowledged turn; session quarantined`;
      latest !== null ||
        Fail`Provider history lost the unacknowledged turn; session quarantined`;
      await revertBefore(/** @type {string} */ (latest));
      const restored = await readLatestCheckpoint();
      restored === baseCheckpoint ||
        Fail`Revert did not restore the durable checkpoint`;
      await audit('history-reconciled', { strategy: 'checkpointed-revert' });
      await persist(undefined);
      record = undefined;
      needsReconciliation = false;
      return true;
    },

    /**
     * Drop the marker without reconciling, because the history it named is
     * gone: a provider conversation the backend has abandoned (a tool-set
     * rotation starting a fresh thread, say) cannot be reverted and has no
     * bearing on the new one.
     *
     * Deliberately not a way to clear an *outstanding* turn on a live
     * conversation — that is `reconcile` or `acknowledge`.
     */
    forget() {
      inFlight === undefined ||
        Fail`A turn is in flight; it cannot be forgotten`;
      record = undefined;
      needsReconciliation = false;
    },

    /** The marker a backend must persist alongside its own session state. */
    getRecord: () => record,

    status: () =>
      harden({
        inFlight: inFlight !== undefined,
        needsReconciliation,
        ...(record ? { record } : {}),
      }),
  });
};
harden(makeTurnLedger);
