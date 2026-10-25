// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/far';

import { provisionProviderService } from '../provider-setup.js';

/** @import { ProviderSetupConfig } from '../provider-setup.js' */

const SECRET_LOCATOR = `endo://${'a'.repeat(64)}/${'b'.repeat(64)}?type=eval`;
/** @type {ProviderSetupConfig} */
const CLOUD = harden({
  name: 'story-provider',
  kind: 'openai',
  host: 'https://api.openai.com/v1',
  model: 'chosen-model',
});

/** @param {{existing?: string[], failLaunch?: boolean}} [options] */
const makeHost = ({ existing = [], failLaunch = false } = {}) => {
  const names = new Set(existing);
  /** @type {Array<{method: string, args: any[]}>} */
  const calls = [];
  const service = Far('TestProviderService', {
    getInfo: () => harden({ model: 'chosen-model' }),
  });
  const guest = Far('IsolatedProviderGuest', {
    storeLocator: (name, locator) => {
      calls.push({ method: 'storeLocator', args: [name, locator] });
    },
  });
  const host = Far('ProviderAdminHost', {
    has: name => {
      calls.push({ method: 'has', args: [name] });
      return names.has(name);
    },
    provideGuest: (name, options) => {
      calls.push({ method: 'provideGuest', args: [name, options] });
      names.add(name);
      names.add(options.agentName);
      return guest;
    },
    makeUnconfined: (worker, moduleUrl, options) => {
      calls.push({
        method: 'makeUnconfined',
        args: [worker, moduleUrl, options],
      });
      if (failLaunch) throw Error('Provider launch failed');
      names.add(options.resultName);
      return service;
    },
  });
  return { host, calls, service };
};

test('cloud provider receives only its SecretBlob locator in an isolated guest', async t => {
  const { host, calls, service } = makeHost();
  const result = await provisionProviderService(
    host,
    { ...CLOUD, maxTokens: '2048', maxMessages: '40' },
    SECRET_LOCATOR,
  );
  t.is(result, service);
  t.deepEqual(
    calls.filter(call => call.method === 'provideGuest'),
    [
      {
        method: 'provideGuest',
        args: [
          'provider-story-provider-handle',
          { agentName: 'profile-for-provider-story-provider' },
        ],
      },
    ],
  );
  t.deepEqual(
    calls.filter(call => call.method === 'storeLocator'),
    [
      {
        method: 'storeLocator',
        args: ['llm-auth-secret', SECRET_LOCATOR],
      },
    ],
  );
  const launched = calls.find(call => call.method === 'makeUnconfined');
  if (!launched) throw Error('Missing provider launch');
  t.is(launched.args[0], '@node');
  t.true(launched.args[1].endsWith('/provider-service.js'));
  t.deepEqual(launched.args[2], {
    powersName: 'profile-for-provider-story-provider',
    resultName: 'story-provider',
    env: {
      PROVIDER_KIND: 'openai',
      PROVIDER_HOST: 'https://api.openai.com/v1',
      PROVIDER_MODEL: 'chosen-model',
      PROVIDER_MAX_TOKENS: '2048',
      PROVIDER_MAX_MESSAGES: '40',
    },
  });
  t.false(
    JSON.stringify(launched.args).includes(SECRET_LOCATOR),
    'secret locator is not a module parameter or environment value',
  );
  // The fakes expose no lookup/readBase64/secrets-manager method; successful
  // provisioning proves setup does not read or introduce additional authority.
});

test('local provider is authless and canonical configuration reaches the fixed caplet', async t => {
  const { host, calls } = makeHost();
  await provisionProviderService(host, {
    name: 'local-story',
    kind: 'local',
    host: 'http://localhost:11434/v1/',
    model: 'local-model',
    moduleUrl: 'file:///opt/endo/provider-service.js',
  });
  t.is(calls.filter(call => call.method === 'storeLocator').length, 0);
  const launched = calls.find(call => call.method === 'makeUnconfined');
  if (!launched) throw Error('Missing provider launch');
  t.is(launched.args[1], 'file:///opt/endo/provider-service.js');
  t.deepEqual(launched.args[2].env, {
    PROVIDER_KIND: 'local',
    PROVIDER_HOST: 'http://localhost:11434/v1',
    PROVIDER_MODEL: 'local-model',
  });
});

test('all invalid configurations fail before any remote call or mutation', async t => {
  /** @type {Array<{config: any, locator?: any}>} */
  const invalid = [
    { config: { ...CLOUD, name: '../provider' }, locator: SECRET_LOCATOR },
    { config: { ...CLOUD, kind: 'unsupported' }, locator: SECRET_LOCATOR },
    { config: { ...CLOUD, model: '' }, locator: SECRET_LOCATOR },
    {
      config: { ...CLOUD, host: 'https://attacker.example/v1' },
      locator: SECRET_LOCATOR,
    },
    {
      config: { ...CLOUD, host: 'https://api.openai.com/v1?key=secret' },
      locator: SECRET_LOCATOR,
    },
    {
      config: { ...CLOUD, host: 'https://secret@api.openai.com/v1' },
      locator: SECRET_LOCATOR,
    },
    { config: { ...CLOUD, authToken: 'raw-secret' }, locator: SECRET_LOCATOR },
    { config: { ...CLOUD, maxTokens: '-1' }, locator: SECRET_LOCATOR },
    { config: { ...CLOUD, maxMessages: 40 }, locator: SECRET_LOCATOR },
    { config: CLOUD },
    { config: CLOUD, locator: 'raw-secret' },
    { config: CLOUD, locator: { readBase64: () => 'raw-secret' } },
    {
      config: { ...CLOUD, kind: 'local', host: 'http://localhost:11434/v1' },
      locator: SECRET_LOCATOR,
    },
    {
      config: {
        ...CLOUD,
        moduleUrl: 'https://attacker.example/provider-service.js',
      },
      locator: SECRET_LOCATOR,
    },
    {
      config: { ...CLOUD, moduleUrl: 'file:///opt/endo/other.js' },
      locator: SECRET_LOCATOR,
    },
  ];
  await Promise.all(
    invalid.map(async ({ config, locator }) => {
      const { host, calls } = makeHost();
      await t.throwsAsync(() =>
        provisionProviderService(host, config, locator),
      );
      t.deepEqual(calls, []);
    }),
  );
});

for (const existing of [
  'story-provider',
  'provider-story-provider-handle',
  'profile-for-provider-story-provider',
]) {
  test(`existing ${existing} is refused without modifying credentials or authority`, async t => {
    const { host, calls } = makeHost({ existing: [existing] });
    await t.throwsAsync(
      () => provisionProviderService(host, CLOUD, SECRET_LOCATOR),
      { message: /already exists/ },
    );
    t.true(calls.every(call => call.method === 'has'));
  });
}

test('concurrent creation cannot mix provider credentials in a shared guest', async t => {
  const { host, calls } = makeHost();
  const first = provisionProviderService(host, CLOUD, SECRET_LOCATOR);
  await t.throwsAsync(
    () => provisionProviderService(host, CLOUD, SECRET_LOCATOR),
    { message: /already being provisioned/ },
  );
  await first;
  t.is(calls.filter(call => call.method === 'provideGuest').length, 1);
  t.is(calls.filter(call => call.method === 'storeLocator').length, 1);
});

test('failed launch leaves an identifiable guest and does not silently reuse its secret', async t => {
  const { host, calls } = makeHost({ failLaunch: true });
  await t.throwsAsync(
    () => provisionProviderService(host, CLOUD, SECRET_LOCATOR),
    { message: /Provider launch failed/ },
  );
  await t.throwsAsync(
    () => provisionProviderService(host, CLOUD, SECRET_LOCATOR),
    { message: /already exists/ },
  );
  t.is(calls.filter(call => call.method === 'storeLocator').length, 1);
});
