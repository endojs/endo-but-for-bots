// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  USAGE_COUNT_KEYS,
  addUsage,
  mergeContext,
  contextFraction,
  disjointFromInclusive,
  priceableUsage,
  projectContext,
  projectUsage,
  tokenCount,
  totalTokens,
} from '../src/token-usage.js';

test('a count is a non-negative safe integer, and anything else is 0', t => {
  t.is(tokenCount(12.9), 12);
  t.is(tokenCount('40'), 40);
  t.is(tokenCount(7n), 7);
  t.is(tokenCount(-3), 0);
  t.is(tokenCount(NaN), 0);
  t.is(tokenCount(Infinity), 0);
  t.is(tokenCount(undefined), 0);
  t.is(tokenCount({}), 0);
  t.is(tokenCount(true), 0);
  t.is(tokenCount('0x10'), 0);
  t.is(tokenCount([5]), 0);
  t.is(tokenCount(Symbol('n')), 0);
  t.is(tokenCount(2 ** 60), Number.MAX_SAFE_INTEGER);
});

test('a record from before the newer counts reads them as 0', t => {
  t.deepEqual(projectUsage({ inputTokens: 5, outputTokens: 2, turns: 9 }), {
    inputTokens: 5,
    outputTokens: 2,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  });
  t.deepEqual(Object.keys(projectUsage(undefined)), [...USAGE_COUNT_KEYS]);
});

test('counts add and the latest context wins', t => {
  const first = {
    inputTokens: 10,
    cachedInputTokens: 100,
    outputTokens: 4,
    context: { usedTokens: 114, windowTokens: 1000 },
  };
  const second = {
    inputTokens: 3,
    cachedInputTokens: 114,
    reasoningOutputTokens: 6,
    outputTokens: 1,
    context: { usedTokens: 124, windowTokens: 1000 },
  };
  const sum = addUsage(addUsage(undefined, first), second);
  t.deepEqual(sum, {
    inputTokens: 13,
    outputTokens: 5,
    cachedInputTokens: 214,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 6,
    context: { usedTokens: 124, windowTokens: 1000 },
  });
  t.is(totalTokens(sum), 238);
  // A later event without a reading keeps the one already held.
  t.deepEqual(addUsage(sum, { outputTokens: 1 }).context, sum.context);
  t.true(Object.isFrozen(sum));
  // A reading that does not know the window keeps the size already known.
  t.deepEqual(addUsage(sum, { context: { usedTokens: 300 } }).context, {
    usedTokens: 300,
    windowTokens: 1000,
  });
});

test('a context with nothing read is no context', t => {
  t.is(projectContext(undefined), undefined);
  t.is(projectContext({ usedTokens: 0, windowTokens: 0 }), undefined);
  t.is(projectContext('full'), undefined);
  t.deepEqual(projectContext({ usedTokens: 9 }), {
    usedTokens: 9,
    windowTokens: 0,
  });
});

test('the fraction needs a window and never exceeds 1', t => {
  t.is(contextFraction({ usedTokens: 250, windowTokens: 1000 }), 0.25);
  t.is(contextFraction({ usedTokens: 1200, windowTokens: 1000 }), 1);
  t.is(contextFraction({ usedTokens: 250 }), null);
  t.is(contextFraction(undefined), null);
});

test('inclusive counts become disjoint and never negative', t => {
  t.deepEqual(
    disjointFromInclusive({
      inputTokens: 1000,
      cachedInputTokens: 900,
      outputTokens: 50,
      reasoningOutputTokens: 30,
    }),
    {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 900,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 30,
    },
  );
  // Cache writes are reported beside the input unless the caller knows they
  // are inside it.
  t.is(
    disjointFromInclusive({
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 300,
    }).inputTokens,
    400,
  );
  t.is(
    disjointFromInclusive({
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 300,
      cacheWriteInsideInput: true,
    }).inputTokens,
    100,
  );
  // A provider whose subsets exceed their totals yields 0, not a negative.
  const odd = disjointFromInclusive({
    inputTokens: 10,
    cachedInputTokens: 50,
    outputTokens: 1,
    reasoningOutputTokens: 9,
  });
  t.is(odd.inputTokens, 0);
  t.is(odd.outputTokens, 0);
});

test('usage is priced with cache writes as input and reasoning as output', t => {
  t.deepEqual(
    priceableUsage({
      inputTokens: 10,
      cacheWriteInputTokens: 5,
      cachedInputTokens: 1000,
      outputTokens: 7,
      reasoningOutputTokens: 3,
      context: { usedTokens: 1, windowTokens: 2 },
    }),
    { inputTokens: 15n, cachedInputTokens: 1000n, outputTokens: 10n },
  );
  t.deepEqual(priceableUsage(undefined), {
    inputTokens: 0n,
    cachedInputTokens: 0n,
    outputTokens: 0n,
  });
});

test('a reading merges over the last one field by field', t => {
  const known = { usedTokens: 150_000, windowTokens: 200_000 };
  // A turn that failed may report the window and no request: the occupancy
  // already known stands.
  t.deepEqual(
    mergeContext(known, { usedTokens: 0, windowTokens: 200_000 }),
    known,
  );
  // A mid-turn reading that does not know the window keeps its size.
  t.deepEqual(mergeContext(known, { usedTokens: 160_000, windowTokens: 0 }), {
    usedTokens: 160_000,
    windowTokens: 200_000,
  });
  t.deepEqual(mergeContext(undefined, known), known);
  t.deepEqual(mergeContext(known, undefined), known);
  t.is(mergeContext(undefined, undefined), undefined);
});
