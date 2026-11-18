// @ts-check
/**
 * The session's usage totals (contract 6.3; R4-33; `designs/m2-interfaces.md`
 * 10 and 12): the per-turn sum on the active turn and the session's
 * `UsageTotals`, by the rules of `guest/lib/usage-counts.js`. Part of the
 * turn runner (`turn.js` calls it in the round and settle cranks); it sends
 * nothing.
 *
 * Guest rules.
 */
import {
  addCounts,
  sessionContext,
  zeroCounts,
} from '../lib/usage-counts.js';

/** @import { ActiveTurn } from './turn-types.js' */

/**
 * @param {object} options
 * @param {number | undefined} options.contextLength the catalogue's window,
 *   stored at creation (`SessionConfig.contextLength`)
 */
export const makeUsage = ({ contextLength }) => {
  const totals = {
    ...zeroCounts(),
    context: { usedTokens: 0, windowTokens: 0 },
    turns: 0,
    incompleteTurns: 0,
  };

  return harden({
    /** The session's `UsageTotals` (a hardened copy). */
    totals: () => harden({ ...totals, context: harden({ ...totals.context }) }),
    /**
     * A round reported `usage` (roundFinal or roundFailed): add it to the
     * turn's sum (`active.usage`) and the session's totals.
     * @param {ActiveTurn} active
     * @param {any} usage
     */
    addRound: (active, usage) => {
      if (usage === undefined) return;
      /** @type {any} */
      const sum = active.usage ?? zeroCounts();
      addCounts(sum, usage);
      addCounts(totals, usage);
      if (usage.context !== undefined) {
        sum.context = harden({ ...usage.context });
        totals.context = { ...usage.context };
      }
      if (contextLength !== undefined) {
        totals.context = sessionContext(totals.context, contextLength);
        if (sum.context !== undefined) {
          sum.context = harden(sessionContext(sum.context, contextLength));
        }
      }
      active.usage = sum;
    },
    /**
     * A turn settled with this status.
     * @param {string} status
     */
    settled: status => {
      totals.turns += 1;
      if (status !== 'completed') totals.incompleteTurns += 1;
    },
    /** @param {any} imported UsageTotals of an imported session */
    replace: imported => {
      totals.inputTokens = imported.inputTokens;
      totals.outputTokens = imported.outputTokens;
      totals.cachedInputTokens = imported.cachedInputTokens;
      totals.cacheWriteInputTokens = imported.cacheWriteInputTokens;
      totals.reasoningOutputTokens = imported.reasoningOutputTokens;
      totals.context = { ...imported.context };
      totals.turns = imported.turns;
      totals.incompleteTurns = imported.incompleteTurns;
    },
  });
};
harden(makeUsage);
