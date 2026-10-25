// @ts-check

// Each case asserts its isolated fake provider before the next case.
/* eslint-disable no-await-in-loop */

import '@endo/init/debug.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import test from 'ava';

import { makeDriverProvider } from '../driver.js';
import { make, makeProviderService } from '../provider-service.js';

const cloud = harden({
  kind: /** @type {const} */ ('openai'),
  host: 'https://api.openai.com/v1',
  model: 'explicit-test-model',
});
const messages = harden([{ role: 'user', content: 'Continue the story.' }]);
const noTools = harden([]);
const response = harden({
  message: { role: 'assistant', content: 'A door opens.' },
});

const makeFixture = () => {
  let encoded = btoa('fake-key-one');
  let revoked = false;
  let reads = 0;
  let lookups = 0;
  /** @type {any[]} */
  const calls = [];
  const secret = Far('SecretBlob', {
    readBase64: () => {
      reads += 1;
      if (revoked) throw Error('revoked fake-key-one');
      return encoded;
    },
  });
  const powers = Far('ProviderNamespace', {
    lookup: name => {
      if (name !== 'llm-auth-secret') throw Error('Unexpected lookup');
      lookups += 1;
      return secret;
    },
  });
  const createProvider = env => {
    calls.push(env);
    return { chat: async () => response };
  };
  return {
    powers,
    createProvider,
    calls,
    setEncoded: value => {
      encoded = value;
    },
    revoke: () => {
      revoked = true;
    },
    restore: () => {
      revoked = false;
    },
    reads: () => reads,
    lookups: () => lookups,
  };
};

test('managed provider rereads credentials per request and honors rotation/revocation', async t => {
  const fixture = makeFixture();
  const service = makeProviderService(fixture.powers, cloud, fixture);
  t.deepEqual(await E(service).chat(messages, noTools), response);
  fixture.setEncoded(btoa('fake-key-two'));
  await E(service).chat(messages, noTools);
  t.deepEqual(
    fixture.calls.map(call => call.LAL_AUTH_TOKEN),
    ['fake-key-one', 'fake-key-two'],
  );
  t.is(fixture.lookups(), 2);
  t.is(fixture.reads(), 2);
  fixture.revoke();
  const error = await t.throwsAsync(() => E(service).chat(messages, noTools), {
    message: /credential unavailable or revoked/,
  });
  t.false(String(error).includes('fake-key'));
  t.is(fixture.calls.length, 2);
  fixture.restore();
  await E(service).chat(messages, noTools);
  t.is(fixture.calls.length, 3);
  t.deepEqual(await E(service).getInfo(), { ...cloud, authRequired: true });
  t.deepEqual(
    // eslint-disable-next-line no-underscore-dangle
    (await E(/** @type {any} */ (service)).__getMethodNames__())
      .filter(name => !name.startsWith('__'))
      .sort(),
    ['chat', 'getInfo', 'help'],
  );
});

test('provider services map OpenAI, Anthropic and local public configuration', async t => {
  for (const config of [
    cloud,
    {
      kind: /** @type {const} */ ('anthropic'),
      host: 'https://api.anthropic.com',
      model: 'explicit-anthropic-model',
    },
    {
      kind: /** @type {const} */ ('local'),
      host: 'http://blackquartz.example:8080/v1',
      model: 'explicit-local-model',
    },
  ]) {
    const fixture = makeFixture();
    const service = makeProviderService(
      fixture.powers,
      { ...config, maxTokens: '2048', maxMessages: '60' },
      fixture,
    );
    await E(service).chat(messages, noTools);
    t.deepEqual(fixture.calls[0], {
      LAL_HOST: config.host,
      LAL_MODEL: config.model,
      LAL_AUTH_TOKEN: config.kind === 'local' ? undefined : 'fake-key-one',
      LAL_MAX_TOKENS: '2048',
      LAL_MAX_MESSAGES: '60',
    });
    t.is(fixture.lookups(), config.kind === 'local' ? 0 : 1);
  }
});

test('secret parser rejects malformed, overlarge, invalid UTF-8 and control characters', async t => {
  for (const encoded of [
    '',
    'not base64!',
    'YQ=',
    '/w==',
    btoa('a'.repeat(8193)),
    btoa('token\n'),
    'YR==',
  ]) {
    const fixture = makeFixture();
    fixture.setEncoded(encoded);
    const service = makeProviderService(fixture.powers, cloud, fixture);
    await t.throwsAsync(() => E(service).chat(messages, noTools), {
      message: /Provider credential must/,
    });
    t.is(fixture.calls.length, 0);
  }
  const fixture = makeFixture();
  fixture.setEncoded(btoa('a'.repeat(8192)));
  await E(makeProviderService(fixture.powers, cloud, fixture)).chat(
    messages,
    noTools,
  );
  t.is(fixture.calls[0].LAL_AUTH_TOKEN.length, 8192);
});

test('provider failures never disclose raw SDK credentials or request metadata', async t => {
  const fixture = makeFixture();
  for (const factoryFailure of [true, false]) {
    const createProvider = () => {
      if (factoryFailure) throw Error('fake-key-one in constructor');
      return {
        chat: async () => {
          throw Error('Authorization: Bearer fake-key-one');
        },
      };
    };
    const service = makeProviderService(fixture.powers, cloud, {
      createProvider,
    });
    const error = await t.throwsAsync(
      () => E(service).chat(messages, noTools),
      { message: /Provider request failed/ },
    );
    t.false(String(error).includes('fake-key-one'));
    t.is(error?.cause, undefined);
  }
});

test('provider failures reveal only fixed numeric status classifications', async t => {
  for (const [status, expected] of [
    [401, /authentication or account access denied/],
    [403, /authentication or account access denied/],
    [404, /selected model or endpoint unavailable/],
    [429, /account quota or rate limit reached/],
    [400, /model rejected the request format/],
    ['401 fake-key-one', /Check the selected model/],
  ]) {
    const fixture = makeFixture();
    const service = makeProviderService(fixture.powers, cloud, {
      createProvider: () => ({
        chat: async () => {
          throw Object.assign(Error('Authorization: fake-key-one'), { status });
        },
      }),
    });
    const error = await t.throwsAsync(() => E(service).chat(messages, noTools));
    t.regex(String(error), /** @type {RegExp} */ (expected));
    t.false(String(error).includes('fake-key-one'));
    t.is(error?.cause, undefined);
  }
});

test('endpoint and model validated before any capability lookup, no raw token config', t => {
  const fixture = makeFixture();
  for (const patch of [
    { host: 'https://attacker.example/v1' },
    { host: 'https://api.openai.com/v1?token=secret' },
    { host: 'https://user:secret@api.openai.com/v1' },
    { host: 'http://api.openai.com/v1' },
    { model: '' },
    { authToken: 'fake-key' },
    { maxTokens: '0' },
  ]) {
    t.throws(() =>
      makeProviderService(fixture.powers, { ...cloud, ...patch }, fixture),
    );
  }
  t.is(fixture.lookups(), 0);
  t.deepEqual(
    make(fixture.powers, undefined, {
      env: {
        PROVIDER_KIND: 'local',
        PROVIDER_HOST: 'http://localhost:8080/v1',
        PROVIDER_MODEL: 'explicit-model',
      },
    }).getInfo(),
    {
      kind: 'local',
      host: 'http://localhost:8080/v1',
      model: 'explicit-model',
      authRequired: false,
    },
  );
});

test('live driver resolves current service each call without bypassing credential ownership', async t => {
  /** @type {any} */
  let current = Far('FirstProvider', { chat: () => response });
  let reads = 0;
  const powers = Far('DriverNamespace', {
    lookup: name => {
      t.is(name, 'llm-provider');
      reads += 1;
      return current;
    },
  });
  const provider = makeDriverProvider(powers);
  t.deepEqual(await provider.chat(messages, noTools), response);
  const switchedResponse = harden({
    message: { role: 'assistant', content: 'New provider.' },
  });
  current = Far('SecondProvider', { chat: () => switchedResponse });
  t.deepEqual(await provider.chat(messages, noTools), switchedResponse);
  current = harden({
    host: 'http://localhost:8080/v1',
    model: 'legacy-model',
    authToken: 'legacy-test-key',
  });
  const error = await t.throwsAsync(() => provider.chat(messages, noTools), {
    message: /requires a chat service capability/,
  });
  t.false(String(error).includes(current.authToken));
  t.is(reads, 3);
});
