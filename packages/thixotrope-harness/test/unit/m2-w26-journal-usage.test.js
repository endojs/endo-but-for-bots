// @ts-check
// M2 W2.6: usage totals from records (guest/lib/journal-usage.js; R4-33,
// R4-83): the session's rules, a page at a time.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  makeUsageTally,
  usageOfRecords,
} from '../../guest/lib/journal-usage.js';
/* eslint-enable import/no-relative-packages */

/**
 * @param {number} input
 * @param {{ usedTokens: number, windowTokens: number }} [context]
 */
const usage = (input, context) => ({
  inputTokens: input,
  outputTokens: 2,
  cachedInputTokens: 3,
  cacheWriteInputTokens: 4,
  reasoningOutputTokens: 5,
  ...(context === undefined ? {} : { context }),
});

/**
 * @param {string} turnId
 * @param {string} status
 * @param {any} [u]
 */
const settled = (turnId, status, u) => ({
  kind: 'turn-settled',
  turnId,
  status,
  at: 1,
  ...(u === undefined ? {} : { usage: u }),
});

const records = [
  { kind: 'turn-started', turnId: 't1', input: 'a', at: 1 },
  settled('t1', 'completed', usage(10, { usedTokens: 20, windowTokens: 0 })),
  { kind: 'turn-started', turnId: 't2', input: 'b', at: 1 },
  settled('t2', 'failed', usage(1)),
  settled('t3', 'cancelled'),
  settled(
    't4',
    'outcome-unknown',
    usage(7, { usedTokens: 9, windowTokens: 100 }),
  ),
  settled('t5', 'completed', usage(0)),
];

test('counts add, every settled turn counts, the latest reported reading wins', t => {
  t.deepEqual(usageOfRecords(records), {
    inputTokens: 18,
    outputTokens: 8,
    cachedInputTokens: 12,
    cacheWriteInputTokens: 16,
    reasoningOutputTokens: 20,
    context: { usedTokens: 9, windowTokens: 100 },
    turns: 5,
    incompleteTurns: 3,
  });
  t.deepEqual(usageOfRecords([]), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    context: { usedTokens: 0, windowTokens: 0 },
    turns: 0,
    incompleteTurns: 0,
  });
});

test('a page at a time gives the same totals', t => {
  const tally = makeUsageTally();
  for (let i = 0; i < records.length; i += 2)
    tally.add(records.slice(i, i + 2));
  t.deepEqual(tally.totals(), usageOfRecords(records));
});
