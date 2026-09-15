// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { E } from '@endo/eventual-send';
import { make } from '../agent.js';
import { createStreamingProvider } from '../providers/index.js';

test('OpenRouter selection fails early without credentials', t => {
  t.throws(
    () =>
      createStreamingProvider({
        FLOOT_PROVIDER: 'openrouter',
        FLOOT_MODEL: 'vendor/model',
      }),
    { message: /key/ },
  );
});

test('Floot offers the configured OpenRouter model, not Anthropic models', async t => {
  const powers = Far('OpenRouterFactoryPowers', {
    list: () => harden([]),
    has: () => false,
    lookup: name => {
      if (name === 'llm-provider')
        return harden({ provider: 'openrouter', model: 'vendor/model:free' });
      throw Error('Unknown name');
    },
  });
  const factory = make(powers);
  const backends = await E(factory).listBackends();
  t.is(backends[0].title, 'OpenRouter');
  const models = await E(factory).listModels('provider');
  t.is(models.length, 1);
  t.is(models[0].modelId, 'vendor/model:free');
  t.true(models[0].default);
});
