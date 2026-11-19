// @ts-check
// The session's usage totals (guest/session/usage.js over
// guest/lib/usage-counts.js; R4-33, m2-interfaces.md 12): counts add by
// named key, the context reading is replaced whole, the catalogue window
// wins when the session has one, settles count turns, an import replaces
// the totals; and the totals equal journal-usage.js's independent tally of
// the same settles.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { makeUsageTally } from '../../guest/lib/journal-usage.js';
import {
  addCounts,
  sessionContext,
  zeroCounts,
} from '../../guest/lib/usage-counts.js';
import { makeUsage } from '../../guest/session/usage.js';
/* eslint-enable import/no-relative-packages */

/**
 * @param {number} n
 * @param {{ usedTokens: number, windowTokens: number }} [context]
 */
const reading = (n, context) =>
  harden({
    inputTokens: n,
    outputTokens: 2 * n,
    cachedInputTokens: 3 * n,
    cacheWriteInputTokens: 4 * n,
    reasoningOutputTokens: 5 * n,
    ...(context === undefined ? {} : { context }),
  });

test('addCounts adds the five counts; sessionContext keeps the reading whole', t => {
  const into = zeroCounts();
  addCounts(into, reading(1));
  addCounts(into, reading(2));
  t.deepEqual(into, {
    inputTokens: 3,
    outputTokens: 6,
    cachedInputTokens: 9,
    cacheWriteInputTokens: 12,
    reasoningOutputTokens: 15,
  });
  const r = { usedTokens: 10, windowTokens: 100 };
  t.is(sessionContext(r, undefined), r);
  t.deepEqual(sessionContext(r, 500), { usedTokens: 10, windowTokens: 500 });
});

test('rounds add into the turn and the session; the latest reading wins whole', t => {
  const usage = makeUsage({ contextLength: undefined });
  /** @type {any} */
  const active = { usage: undefined };
  usage.addRound(active, undefined);
  t.is(active.usage, undefined, 'a round without usage changes nothing');
  usage.addRound(active, reading(1, { usedTokens: 50, windowTokens: 100 }));
  usage.addRound(active, reading(2, { usedTokens: 0, windowTokens: 0 }));
  usage.addRound(active, reading(1));
  t.is(active.usage.inputTokens, 4);
  t.deepEqual(active.usage.context, { usedTokens: 0, windowTokens: 0 });
  t.true(Object.isFrozen(active.usage.context));
  usage.settled('completed');
  const totals = usage.totals();
  t.is(totals.inputTokens, 4);
  t.is(totals.reasoningOutputTokens, 20);
  t.deepEqual(totals.context, { usedTokens: 0, windowTokens: 0 });
  t.is(totals.turns, 1);
  t.is(totals.incompleteTurns, 0);
  t.true(Object.isFrozen(totals));
});

test('the catalogue window replaces the reported one, on the turn and the totals', t => {
  const usage = makeUsage({ contextLength: 200_000 });
  t.deepEqual(usage.totals().context, { usedTokens: 0, windowTokens: 0 });
  /** @type {any} */
  const active = { usage: undefined };
  usage.addRound(active, reading(1));
  t.is(active.usage.context, undefined, 'no reading yet on the turn');
  t.deepEqual(usage.totals().context, { usedTokens: 0, windowTokens: 200_000 });
  usage.addRound(active, reading(1, { usedTokens: 70, windowTokens: 8 }));
  t.deepEqual(active.usage.context, { usedTokens: 70, windowTokens: 200_000 });
  t.deepEqual(usage.totals().context, {
    usedTokens: 70,
    windowTokens: 200_000,
  });
});

test('settles count turns and incomplete turns; an import replaces the totals', t => {
  const usage = makeUsage({ contextLength: undefined });
  usage.settled('completed');
  usage.settled('failed');
  usage.settled('outcome-unknown');
  t.is(usage.totals().turns, 3);
  t.is(usage.totals().incompleteTurns, 2);
  const imported = harden({
    ...reading(7),
    context: { usedTokens: 1, windowTokens: 2 },
    turns: 9,
    incompleteTurns: 4,
  });
  usage.replace(imported);
  t.deepEqual(usage.totals(), imported);
});

test('the totals equal the journal-usage tally of the same settled turns', t => {
  const usage = makeUsage({ contextLength: undefined });
  const tally = makeUsageTally();
  const turns = [
    { status: 'completed', rounds: [reading(1), reading(2, { usedTokens: 9, windowTokens: 90 })] },
    { status: 'failed', rounds: [reading(3)] },
    { status: 'completed', rounds: [reading(1, { usedTokens: 4, windowTokens: 40 })] },
  ];
  turns.forEach(({ status, rounds }, i) => {
    /** @type {any} */
    const active = { usage: undefined };
    for (const round of rounds) usage.addRound(active, round);
    usage.settled(status);
    tally.add([
      harden({
        kind: 'turn-settled',
        turnId: `t${i + 1}`,
        status,
        at: i,
        usage: active.usage,
      }),
    ]);
  });
  t.deepEqual(usage.totals(), tally.totals());
});
