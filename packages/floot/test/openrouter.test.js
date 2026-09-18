// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { E } from '@endo/eventual-send';
import { createProvider } from '@endo/lal/providers/index.js';
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

test.serial(
  'OpenRouter factories omit default output caps and retain explicit caps',
  async t => {
    const originalFetch = globalThis.fetch;
    t.teardown(() => {
      globalThis.fetch = originalFetch;
    });
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Done' },
            },
          ],
        }),
      );
    };
    const env = {
      LAL_HOST: 'https://openrouter.ai/api/v1',
      LAL_MODEL: 'openrouter/free',
      LAL_AUTH_TOKEN: 'test-not-a-key',
    };
    await createProvider(env).chat([], []);
    await createStreamingProvider(env).chat([], []);
    await createStreamingProvider({
      ...env,
      FLOOT_PROVIDER: 'openrouter',
    }).chat([], []);
    t.true(bodies.every(body => !('max_tokens' in body)));
    await createStreamingProvider({ ...env, FLOOT_MAX_TOKENS: '8192' }).chat(
      [],
      [],
    );
    t.is(bodies[3].max_tokens, 8192);
  },
);

test('configured free router appears once and remains the default', async t => {
  const factory = make(
    Far('FreeRouterPowers', {
      list: () => harden([]),
      has: () => false,
      lookup: () =>
        harden({ provider: 'openrouter', model: 'openrouter/free' }),
    }),
  );
  const models = await E(factory).listModels('provider');
  t.is(models.length, 3);
  t.is(models.filter(m => m.id === 'openrouter/free').length, 1);
  t.is(models.find(m => m.default)?.id, 'openrouter/free');
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
  t.is(backends[0].title, 'Fae');
  const models = await E(factory).listModels('provider');
  t.is(models.length, 4);
  t.is(models[0].modelId, 'vendor/model:free');
  t.true(models[0].default);
  t.true(models.some(m => m.id === 'openrouter/free'));
  t.true(models.every(m => m.backendId === 'provider'));
});
