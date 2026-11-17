// @ts-check
/**
 * Session usage totals from the record log (M2 W2.6; R4-33, R4-83;
 * `designs/m2-interfaces.md` 10, 12). Adapted from Fae
 * `session/journal-usage.js` (1315bef86), which projects the totals from a
 * pinned journal cut by tallying each terminal turn: here the terminal turn
 * is a `TurnSettled` record and the tally runs over records (a page at a
 * time for export, import and archived segments).
 *
 * The rules are the session's own (contract 6.3, `guest/session/turn.js`
 * settle and `addUsage`), so `usageOfRecords(all records)` equals what
 * `Session.getUsage()` answers and what the settle's `usage` event carries:
 *
 * - the five counts are summed over every settled turn's `usage` (which is
 *   the sum of its rounds, failed rounds included);
 * - `turns` counts every settled turn and `incompleteTurns` those not
 *   `completed`. Fae counts only completed turns in `turns` (journal-usage
 *   `tally`: `if completed turns += 1 else incompleteTurns += 1`); the
 *   harness contract counts all (a deviation, journaled J-0473);
 * - the context reading is the latest settled turn's that reported one
 *   (the last request's reading, R4-33). Fae keeps the latest non-zero used
 *   and window values independently; the harness keeps the reading whole,
 *   as `addUsage` does.
 *
 * Guest and Node: plain records in, a plain hardened `UsageTotals` out; no
 * keys from data (rule 12.10).
 */

/**
 * @typedef {object} UsageTally
 * @property {(records: readonly any[]) => void} add tally one page of
 *   records (any kinds; only `turn-settled` counts), in log order
 * @property {() => any} totals the `UsageTotals` so far
 */

/** @returns {UsageTally} */
export const makeUsageTally = () => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let reasoningOutputTokens = 0;
  let usedTokens = 0;
  let windowTokens = 0;
  let turns = 0;
  let incompleteTurns = 0;
  /** @param {readonly any[]} records */
  const add = records => {
    for (const record of records) {
      if (record?.kind === 'turn-settled') {
        turns += 1;
        if (record.status !== 'completed') incompleteTurns += 1;
        const { usage } = record;
        if (usage !== undefined && usage !== null) {
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          cachedInputTokens += usage.cachedInputTokens;
          cacheWriteInputTokens += usage.cacheWriteInputTokens;
          reasoningOutputTokens += usage.reasoningOutputTokens;
          if (usage.context !== undefined) {
            usedTokens = usage.context.usedTokens;
            windowTokens = usage.context.windowTokens;
          }
        }
      }
    }
  };
  const totals = () =>
    harden({
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      reasoningOutputTokens,
      context: harden({ usedTokens, windowTokens }),
      turns,
      incompleteTurns,
    });
  return harden({ add, totals });
};
harden(makeUsageTally);

/**
 * The session totals the records imply (`UsageTotals`).
 * @param {readonly any[]} records
 */
export const usageOfRecords = records => {
  const tally = makeUsageTally();
  tally.add(records);
  return tally.totals();
};
harden(usageOfRecords);
