import test from '@endo/ses-ava/prepare-endo.js';
import { parseInferenceProviderModelPrices } from '../src/inference-provider-model-prices.js';

test('model prices parse micro-dollar prices per million tokens', t => {
  t.deepEqual(parseInferenceProviderModelPrices(undefined), {});
  t.deepEqual(
    parseInferenceProviderModelPrices(
      '{"claude-test":{"inputPerMillion":3000000,"outputPerMillion":15000000,"cacheReadPerMillion":300000}}',
    ),
    {
      'claude-test': {
        inputPerMillion: 3_000_000,
        outputPerMillion: 15_000_000,
        cacheReadPerMillion: 300_000,
      },
    },
  );
});

test('malformed model prices fail with context', t => {
  t.throws(() => parseInferenceProviderModelPrices('{'), {
    message: /is not JSON/,
  });
  t.throws(() => parseInferenceProviderModelPrices('[]'), {
    message: /must be an object/,
  });
  for (const price of [
    '{"m":{"inputPerMillion":3}}',
    '{"m":{"inputPerMillion":-1,"outputPerMillion":1}}',
    '{"m":{"inputPerMillion":"3","outputPerMillion":1}}',
    '{"m":{"inputPerMillion":3,"outputPerMillion":1,"surcharge":1}}',
    '{"m":{"inputPerMillion":3,"outputPerMillion":15}}',
  ]) {
    t.throws(
      () => parseInferenceProviderModelPrices(price),
      { message: /invalid micro-dollar price for "m"/ },
      price,
    );
  }
});
