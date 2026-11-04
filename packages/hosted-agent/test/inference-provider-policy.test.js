import test from '@endo/ses-ava/prepare-endo.js';
import {
  DEFAULT_PROVIDER_LIMITS,
  validateInferenceLimits,
} from '../src/inference-provider-policy.js';

test('limits proposing both daily budget kinds are refused', t => {
  t.throws(
    () => validateInferenceLimits({ dailyDollars: 1, dailyTokens: 1000 }),
    { message: /exactly one daily budget/ },
  );
});

test('a token budget cannot escape a dollar-only deployment ceiling', t => {
  const ceilings = harden({ dailyDollars: 5 });
  t.throws(
    () =>
      validateInferenceLimits(
        { dailyTokens: 1_000_000_000 },
        DEFAULT_PROVIDER_LIMITS,
        ceilings,
      ),
    { message: /deployment ceiling/ },
  );
  t.like(
    validateInferenceLimits(
      { dailyDollars: 4 },
      DEFAULT_PROVIDER_LIMITS,
      ceilings,
    ),
    { dailyDollars: 4 },
  );
  t.like(
    validateInferenceLimits(
      { dailyTokens: 1000 },
      DEFAULT_PROVIDER_LIMITS,
      harden({ dailyDollars: 5, dailyTokens: 2000 }),
    ),
    { dailyTokens: 1000 },
  );
});
