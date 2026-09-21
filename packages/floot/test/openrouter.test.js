// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Fail } from '@endo/errors';
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

test.serial('OpenRouter factories never send an output cap', async t => {
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
  // Not from the environment either: a reply is as long as the model makes
  // it, and a cap only ever turned a long answer into a failed turn.
  await createStreamingProvider({ ...env, FLOOT_MAX_TOKENS: '8192' }).chat(
    [],
    [],
  );
  await createProvider({ ...env, LAL_MAX_TOKENS: '8192' }).chat([], []);
  t.is(bodies.length, 5);
  t.true(bodies.every(body => !('max_tokens' in body)));
});

/**
 * What OpenRouter's account-filtered catalog answers, as the reader reads it:
 * the free router and one concrete free model, both text-in, text-out, tools.
 *
 * @param {string[]} keys Where each read's bearer key lands.
 */
const openRouterFetch = keys =>
  /** @type {typeof globalThis.fetch} */ (
    async (url, init) => {
      `${url}` === 'https://openrouter.ai/api/v1/models/user' ||
        Fail`Unexpected request ${url}`;
      keys.push(`${new Headers(init?.headers).get('authorization')}`);
      const model = id => ({
        id,
        name: `Name of ${id}`,
        description: 'From the provider',
        context_length: 200_000,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
        },
        supported_parameters: ['tools'],
      });
      return Response.json({
        data: [model('openrouter/free'), model('vendor/model:free')],
      });
    }
  );

/**
 * @param {{ model: string }} config
 * @param {typeof globalThis.fetch} fetch
 */
const openRouterFactory = (config, fetch) =>
  make(
    Far('OpenRouterFactoryPowers', {
      list: () => harden([]),
      has: () => false,
      lookup: name => {
        if (name === 'llm-provider')
          return harden({
            provider: 'openrouter',
            authToken: 'or-key',
            ...config,
          });
        throw Error('Unknown name');
      },
    }),
    undefined,
    { fetch },
  );

test('the direct provider offers what its OpenRouter account lists, read once and marked by the configured model', async t => {
  /** @type {string[]} */
  const keys = [];
  const factory = await openRouterFactory(
    { model: 'openrouter/free' },
    openRouterFetch(keys),
  );
  const backends = await E(factory).listBackends();
  t.is(backends[0].title, 'Fae');
  const models = await E(factory).listModels('provider');
  t.deepEqual(
    models.map(m => [m.id, m.modelId, m.backendId, m.default, m.title]),
    [
      [
        'openrouter/free',
        'openrouter/free',
        'provider',
        true,
        'Name of openrouter/free',
      ],
      [
        'vendor/model:free',
        'vendor/model:free',
        'provider',
        false,
        'Name of vendor/model:free',
      ],
    ],
  );
  t.deepEqual(models[0].subscriptionIds, ['default']);
  t.deepEqual(models[0].reasoningEfforts, []);
  // Read under Floot's own credential, and held: a second listing reads
  // nothing again.
  t.deepEqual(keys, ['Bearer or-key']);
  await E(factory).listModels('provider');
  t.deepEqual(keys, ['Bearer or-key']);
  const [catalog] = await E(factory).listModelCatalogs();
  t.like(catalog, {
    backendId: 'provider',
    accounts: [{ subscriptionId: 'default', state: 'current', modelCount: 2 }],
  });
  t.is(typeof catalog.accounts[0].observedAt, 'number');
});

test('a configured model the account does not list is not offered, and a pin must be listed', async t => {
  const factory = await openRouterFactory(
    { model: 'vendor/retired' },
    openRouterFetch([]),
  );
  const models = await E(factory).listModels('provider');
  t.deepEqual(
    models.map(m => m.id),
    ['openrouter/free', 'vendor/model:free'],
  );
  t.false(models.some(m => m.default));
  await t.throwsAsync(
    () =>
      E(factory).createSession({
        title: 'Pinned to nothing',
        backendId: 'provider',
        modelId: 'vendor/unknown',
      }),
    { message: /Unknown model "vendor\/unknown" for the provider backend/ },
  );
});

test('failed discovery offers nothing and admits no pin; it is not a list somebody typed', async t => {
  const factory = await openRouterFactory(
    { model: 'openrouter/free' },
    async () => {
      throw Error('provider unreachable');
    },
  );
  t.deepEqual(await E(factory).listModels('provider'), []);
  t.deepEqual(await E(factory).listModelCatalogs(), [
    {
      backendId: 'provider',
      accounts: [
        {
          subscriptionId: 'default',
          state: 'unavailable',
          observedAt: null,
          modelCount: 0,
        },
      ],
    },
  ]);
  await t.throwsAsync(
    () =>
      E(factory).createSession({
        title: 'Pinned while down',
        backendId: 'provider',
        modelId: 'openrouter/free',
      }),
    { message: /Model catalog unavailable for the provider backend/ },
  );
});
