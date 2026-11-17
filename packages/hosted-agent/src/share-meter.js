// @ts-check

import { Fail } from '@endo/errors';

import { tokenCount } from './token-usage.js';

/**
 * The meter of a share: how much of the budget its grantor chose has been
 * spent in the current period, with what is in flight reserved against it.
 *
 * **Reserve, then settle.** A request reserves an estimate at admission and
 * is refused if that does not fit; at the end of its response the reservation
 * is replaced by what the response actually cost. The worst overshoot is one
 * estimate's error per concurrent request, not one whole request each.
 *
 * **A restart cannot refill it.** What is durable is a ceiling, written ahead
 * in steps: nothing is admitted until `spent + reserved` fits under a ceiling
 * that is already in the store. A share that revives mid-period starts from
 * that ceiling, so the step not yet used and every reservation that was open
 * are taken as spent. The store is written once per step of growth, not once
 * per request, and written back down when a large reservation settles small,
 * so that a restart does not also charge for what was reserved and never used.
 *
 * The budget is rate-card-weighted tokens per fixed period, anchored at the
 * share's creation and tied to no provider window: a pool has several and
 * OpenRouter has none. It is a limit on a capability that was handed out,
 * not on its grantor's own use.
 */

/**
 * Cached input is priced near a tenth of fresh input; the rest at par.
 * @param usage
 */
export const weightedTokens = usage => {
  if (usage === null || typeof usage !== 'object') return 0;
  return Math.ceil(
    tokenCount(usage.inputTokens) +
      tokenCount(usage.outputTokens) +
      tokenCount(usage.reasoningOutputTokens) +
      tokenCount(usage.cacheWriteInputTokens) +
      tokenCount(usage.cachedInputTokens) / 10,
  );
};
harden(weightedTokens);

/**
 * @typedef {object} MeterRecord What is kept between incarnations.
 * @property {number} period Index of the period the ceiling belongs to.
 * @property {number} ceiling
 */

/**
 * @param {object} powers
 * @param {() => { tokens: number, periodSeconds: number } | undefined} powers.budget
 *   The grantor's budget now; undefined means the share is not metered.
 * @param {number} powers.anchorMs When the share was created.
 * @param {() => number} powers.now
 * @param {MeterRecord | undefined} powers.initial What a previous incarnation kept.
 * @param {(record: MeterRecord) => Promise<void>} powers.keep
 */
export const makeShareMeter = ({ budget, anchorMs, now, initial, keep }) => {
  let period = -1;
  let spent = 0;
  let reserved = 0;
  let ceiling = 0;
  /** @type {Promise<unknown>} */
  let writing = Promise.resolve();

  /** @param {{ periodSeconds: number }} limits */
  const periodNow = limits =>
    Math.max(0, Math.floor((now() - anchorMs) / (limits.periodSeconds * 1000)));

  /** @param {{ tokens: number, periodSeconds: number }} limits */
  const roll = limits => {
    const current = periodNow(limits);
    if (current === period) return;
    if (period === -1 && initial !== undefined && initial.period === current) {
      // Revived inside the period it was keeping: all of the ceiling is
      // taken as spent.
      spent = Math.max(0, Number(initial.ceiling) || 0);
      ceiling = spent;
    } else {
      // A new period. What is still in flight settles into it.
      spent = 0;
      ceiling = 0;
    }
    period = current;
  };

  /** @param {{ tokens: number }} limits */
  const stepOf = limits => Math.max(1, Math.ceil(limits.tokens / 50));

  /**
   * Raise the durable ceiling to cover `need`, before anything that depends
   * on it happens. One writer at a time.
   *
   * @param {{ tokens: number, periodSeconds: number }} limits
   * @param {number} need
   */
  const cover = (limits, need) => {
    const result = writing.then(async () => {
      roll(limits);
      if (need <= ceiling) return;
      const next = Math.max(
        need,
        Math.min(limits.tokens, need + stepOf(limits)),
      );
      await keep(harden({ period, ceiling: next }));
      ceiling = next;
    });
    writing = result.catch(() => {});
    return result;
  };

  /**
   * Bring the durable ceiling back down when it stands well above what is
   * spent and reserved: a large reservation that settled small would
   * otherwise be charged in full by the next restart. Memory first, then the
   * store: between the two, admission is gated on the lower figure, so the
   * store is never below what has been admitted.
   *
   * @param {{ tokens: number, periodSeconds: number }} limits
   */
  const trim = limits => {
    const result = writing.then(async () => {
      roll(limits);
      const step = stepOf(limits);
      // Never below what is spent and reserved, whatever the budget says
      // now: a grantor who lowers the budget under what was already spent
      // must not thereby let a restart forget the difference.
      const target = Math.max(
        spent + reserved,
        Math.min(limits.tokens, spent + reserved + step),
      );
      // Only when it is worth a write: within a couple of steps it stays.
      if (ceiling - target <= 2 * step) return;
      ceiling = target;
      await keep(harden({ period, ceiling: target }));
    });
    writing = result.catch(() => {});
    return result;
  };

  return harden({
    /**
     * Reserve an estimate. Answers a settle function, or throws when it does
     * not fit (`Provider share exhausted`) or cannot be made durable.
     *
     * @param {number} estimate
     */
    reserve: async estimate => {
      const limits = budget();
      if (limits === undefined) {
        // Not metered: nothing to reserve, nothing to settle.
        return harden({ settle: () => {} });
      }
      const amount = Math.max(1, Math.ceil(estimate));
      roll(limits);
      spent + reserved + amount <= limits.tokens ||
        Fail`Provider share exhausted`;
      // Held from here, so two requests admitted together cannot both fit
      // in room for one.
      reserved += amount;
      let open = true;
      const release = () => {
        if (!open) return false;
        open = false;
        reserved -= amount;
        return true;
      };
      try {
        await cover(limits, spent + reserved);
      } catch (error) {
        release();
        throw error;
      }
      return harden({
        /**
         * Replace the reservation by the charge.
         *
         * - refused before any response (`began: false`): nothing;
         * - a response read to its end that said what it cost: that;
         * - anything else that began (cancelled, abandoned, timed out, or
         *   silent about its cost): the reservation, or more where more is
         *   known (what it had said so far, or `floor`, what its size
         *   implies), never less. A response cut short is not cheaper than
         *   one that was not.
         *
         * Anything that is not a settlement reads as the last case.
         *
         * @param {{ usage: unknown, began: boolean, complete?: boolean } | undefined} settlement
         * @param {number} [floor]
         */
        settle: (settlement, floor = 0) => {
          if (!release()) return;
          const known =
            settlement !== null &&
            typeof settlement === 'object' &&
            typeof settlement.began === 'boolean';
          const said =
            known && settlement.usage !== null && settlement.usage !== undefined
              ? weightedTokens(settlement.usage)
              : undefined;
          let charge;
          if (known && !settlement.began) charge = 0;
          else if (
            known &&
            settlement.complete === true &&
            said !== undefined &&
            said > 0
          ) {
            charge = said;
          } else {
            // Including a response that claims to be complete and to have
            // cost nothing: that is one that did not say.
            charge = Math.max(
              amount,
              said ?? 0,
              Number.isFinite(floor) ? Math.ceil(floor) : 0,
            );
          }
          const current = budget();
          if (current !== undefined) roll(current);
          spent += charge;
          if (current !== undefined && spent + reserved > ceiling) {
            // The response cost more than was reserved. It is spent already;
            // the store is told as soon as it can be.
            void cover(current, spent + reserved).catch(() => {});
          } else if (current !== undefined) {
            void trim(current).catch(() => {});
          }
        },
      });
    },
    /** What a status shows. */
    read: () => {
      const limits = budget();
      if (limits === undefined) return undefined;
      roll(limits);
      const periodMs = limits.periodSeconds * 1000;
      return harden({
        tokens: limits.tokens,
        periodSeconds: limits.periodSeconds,
        spent: Math.min(spent, Number.MAX_SAFE_INTEGER),
        reserved,
        remaining: Math.max(0, limits.tokens - spent - reserved),
        periodEndsAt: new Date(
          anchorMs + (period + 1) * periodMs,
        ).toISOString(),
      });
    },
    /** Settled writes, for a caller that must know the store has them. */
    flushed: () => writing,
  });
};
harden(makeShareMeter);
