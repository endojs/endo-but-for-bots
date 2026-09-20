// @ts-check
import test from 'ava';

import {
  contextPercentOf,
  trafficOf,
  usageLabel,
  usageRows,
} from '../src/usage-label.js';

test('the header counts every kind of input and output, and the context', t => {
  const usage = {
    inputTokens: 1200,
    cachedInputTokens: 48_000,
    cacheWriteInputTokens: 800,
    outputTokens: 300,
    reasoningOutputTokens: 700,
    context: { usedTokens: 50_000, windowTokens: 200_000 },
  };
  t.deepEqual(trafficOf(usage), { input: 50_000, output: 1000, cached: 48_000 });
  t.is(usageLabel(usage), '↑50.0k ↓1.0k · ctx 25%');
  t.deepEqual(usageRows(usage), [
    ['Tokens', '↑50000 (48000 from cache) ↓1000'],
    ['Context', '25% — 50.0k of 200.0k tokens'],
  ]);
});

test('a daemon that reports two counts still gets a label', t => {
  const usage = { inputTokens: 12, outputTokens: 3 };
  t.is(usageLabel(usage), '↑12 ↓3');
  t.deepEqual(usageRows(usage), [['Tokens', '↑12 ↓3']]);
  t.is(contextPercentOf(usage), null);
});

test('nothing used says nothing; an unsized window says so', t => {
  t.is(usageLabel(null), '');
  t.is(usageLabel({ inputTokens: 0, outputTokens: 0 }), '');
  t.deepEqual(usageRows(null), [['Tokens', '—']]);
  const unsized = { inputTokens: 5, context: { usedTokens: 900, windowTokens: 0 } };
  t.is(usageLabel(unsized), '↑5 ↓0');
  t.deepEqual(usageRows(unsized)[1], [
    'Context',
    '900 tokens; window size not reported',
  ]);
  // A conversation past the size the backend gave reads as full.
  t.is(contextPercentOf({ context: { usedTokens: 300, windowTokens: 200 } }), 100);
  // The component's own figure wins when it sent one.
  t.is(contextPercentOf({ contextPercent: 41 }), 41);
});
