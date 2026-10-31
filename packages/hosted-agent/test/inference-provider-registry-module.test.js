import test from '@endo/ses-ava/prepare-endo.js';
import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { make } from '../src/inference-provider-registry-module.js';
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

const makeFakePowers = factory => {
  const names = new Map();
  const secrets = new Map();
  const importer = {
    provideBase64: async (name, description, bytesBase64) => {
      if (!secrets.has(name)) {
        if (bytesBase64 === undefined) throw Error('KEY_NEEDED');
        secrets.set(name, {
          readBase64: async () => bytesBase64,
          getDescription: async () => description,
        });
      }
    },
  };
  return {
    list: async prefix =>
      prefix === 'secrets' ? [...secrets.keys()] : [...names.keys()],
    has: async (...path) =>
      path.length === 1 ? secrets.size > 0 : secrets.has(path[1]),
    lookup: async path => {
      if (path === 'issuer-factory') return factory;
      if (Array.isArray(path) && path[0] === 'secrets') {
        return secrets.get(path[1]);
      }
      if (Array.isArray(path) && path.join('/') === '@secrets/create') {
        return importer;
      }
      return names.get(path);
    },
    storeValue: async (value, name) => {
      names.set(name, value);
    },
    remove: async name => {
      names.delete(name);
    },
  };
};

const moduleProviderRequest = (overrides = {}) =>
  harden({
    idempotencyKey: 'create-0000000001',
    displayName: 'Claude',
    kind: 'anthropic',
    defaultModel: 'claude-test',
    limits: { concurrentTurns: 1, dailyTokens: 1000 },
    keyBase64: encodeBase64(encodeUtf8('canary-secret')),
    ...overrides,
  });

test('the module projects auth fields and refuses unavailable OAuth before factory lookup', async t => {
  const seen = [];
  const factory = {
    discoverModels: async provider => {
      seen.push(provider);
      return harden({ models: [{ id: 'claude-test' }] });
    },
  };
  const powers = makeFakePowers(factory);
  const root = await make(powers, undefined, {
    env: { INFERENCE_PROVIDER_ISSUER_FACTORY: 'issuer-factory' },
  });
  const directory = await E(root).directoryFor('owner-alice');

  const apiKey = await E(directory).create(moduleProviderRequest());
  const apiKeyAdmin = await E(directory).adminFor(apiKey.providerId);
  t.like(await E(apiKeyAdmin).discoverModels(), { catalogState: 'current' });
  t.deepEqual(seen, [
    {
      providerId: apiKey.providerId,
      kind: 'anthropic',
      authMode: 'api-key',
      defaultModel: 'claude-test',
    },
  ]);

  const oauth = await E(directory).create(
    moduleProviderRequest({
      idempotencyKey: 'create-oauth-0001',
      authMode: 'oauth',
      oauthProvider: 'claude-subscription',
      accountRef: 'account-one',
    }),
  );
  const oauthAdmin = await E(directory).adminFor(oauth.providerId);
  t.like(await E(oauthAdmin).discoverModels(), {
    catalogState: 'unavailable',
  });
  t.is(seen.length, 1, 'OAuth refusal precedes the issuer factory');
});
