// @ts-check
import test from '@endo/ses-ava/test.js';

import {
  makeIronhorseLimits,
  readIronhorseLimits,
} from '../src/ironhorse/ironhorse-limits.js';

test('Ironhorse configuration preserves wide budgets without numeric rounding', t => {
  const limits = readIronhorseLimits({
    get: name =>
      ({
        THIXOTROPE_CRANK_BUDGET: '9007199254740993',
        THIXOTROPE_BOOTSTRAP_BUDGET: '18446744073709551615',
        THIXOTROPE_SLOT_CEILING: '2000000',
        THIXOTROPE_CHUNK_CEILING: '536870912',
        THIXOTROPE_REQUEST_TIMEOUT_MS: '90000',
      })[name],
  });
  t.deepEqual(limits, {
    crankBudget: '9007199254740993',
    bootstrapBudget: '18446744073709551615',
    slotCeiling: 2_000_000,
    chunkCeiling: 536_870_912,
    requestTimeoutMs: 90_000,
  });
  t.is(
    makeIronhorseLimits({ crankBudget: 9_007_199_254_740_993n }).crankBudget,
    limits.crankBudget,
  );
});

test('Ironhorse configuration rejects unsupported quantities rather than clamping', t => {
  for (const options of [
    { crankBudget: 0 },
    { crankBudget: '18446744073709551616' },
    { crankBudget: 9_007_199_254_740_992 },
    { bootstrapBudget: 'unlimited' },
    { slotCeiling: '4294967296' },
    { chunkCeiling: -1 },
    { requestTimeoutMs: 2_147_483_648 },
    { requestTimeoutMs: 1.5 },
  ]) {
    t.throws(() => makeIronhorseLimits(options), { message: /must be/ });
  }
});
