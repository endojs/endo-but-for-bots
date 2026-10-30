import test from '@endo/ses-ava/prepare-endo.js';
import { parseModelPrices } from '../src/inference-provider-registry-module.js';

test('model prices parse a JSON object of per-million prices', t => {
  t.deepEqual(parseModelPrices(undefined), {});
  t.deepEqual(
    parseModelPrices(
      '{"claude-test":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0.3}}',
    ),
    {
      'claude-test': {
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadPerMillion: 0.3,
      },
    },
  );
});

test('malformed model prices fail with context', t => {
  t.throws(() => parseModelPrices('{'), { message: /is not JSON/ });
  t.throws(() => parseModelPrices('[]'), { message: /must be an object/ });
  for (const price of [
    '{"m":{"inputPerMillion":3}}',
    '{"m":{"inputPerMillion":-1,"outputPerMillion":1}}',
    '{"m":{"inputPerMillion":"3","outputPerMillion":1}}',
    '{"m":{"inputPerMillion":3,"outputPerMillion":1,"surcharge":1}}',
  ]) {
    t.throws(
      () => parseModelPrices(price),
      { message: /invalid price for "m"/ },
      price,
    );
  }
});
