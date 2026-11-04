// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { encodeBase64 } from '@endo/base64';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import {
  make,
  makeAnthropicApiKeyIssuerFactory,
} from '../src/anthropic-api-key-issuer.js';

const SecretInterface = M.interface('IssuerTestSecret', {
  readBase64: M.callWhen().returns(M.string()),
});

test('Anthropic issuer injects its key and version behind an InferenceEndpoint', async t => {
  const requests = [];
  const fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).includes('/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              type: 'model',
              id: 'claude-test',
              display_name: 'Claude Test',
            },
          ],
          has_more: false,
          last_id: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const secret = makeExo('IssuerTestSecret', SecretInterface, {
    readBase64: async () => encodeBase64(encodeUtf8('anthropic-canary')),
  });
  const made = makeAnthropicApiKeyIssuerFactory({ fetch });
  t.teardown(() => made.dispose());
  const provider = harden({
    providerId: 'provider-one',
    kind: 'anthropic',
    defaultModel: 'claude-test',
  });
  const models = await made.factory.discoverModels(provider, secret);
  t.deepEqual(
    models.models.map(model => model.id),
    ['claude-test'],
  );
  const endpoint = await made.factory.openEndpoint(provider, secret, {
    sessionId: 'grant-one',
  });
  const message = harden({
    method: 'POST',
    path: '/v1/messages',
    body: '{"model":"claude-test","max_tokens":1,"messages":[]}',
  });
  const response = await endpoint.request(message);
  t.is(response.status, 200);
  const dispatch = requests.find(row => row.input.includes('/v1/messages'));
  t.truthy(dispatch);
  t.is(dispatch.init.headers['x-api-key'], 'anthropic-canary');
  t.is(dispatch.init.headers['anthropic-version'], '2023-06-01');
  t.false(JSON.stringify(message).includes('anthropic-canary'));
  await made.factory.disposeProvider('provider-one');
  await t.throwsAsync(() => endpoint.request(message), {
    message: /Inference endpoint revoked/,
  });
});

for (const send of /** @type {const} */ (['request', 'requestByteStream'])) {
  test(`${send} tells each upstream refusal apart, and no more than that`, async t => {
    for (const [status, message] of /** @type {const} */ ([
      [401, 'Provider credential rejected'],
      [429, 'Provider rate limited'],
      [404, 'Provider model not found'],
      [500, 'Provider request failed'],
    ])) {
      const made = makeAnthropicApiKeyIssuerFactory({
        fetch: async () => new Response('body-canary', { status }),
      });
      t.teardown(() => made.dispose());
      const secret = makeExo('IssuerTestSecret', SecretInterface, {
        readBase64: async () => encodeBase64(encodeUtf8('anthropic-canary')),
      });
      // eslint-disable-next-line no-await-in-loop
      const endpoint = await made.factory.openEndpoint(
        harden({
          providerId: 'provider-one',
          kind: 'anthropic',
          defaultModel: 'claude-test',
        }),
        secret,
        { sessionId: 'grant-one' },
      );
      // eslint-disable-next-line no-await-in-loop
      const refusal = await t.throwsAsync(
        () =>
          endpoint[send](
            harden({
              method: 'POST',
              path: '/v1/messages',
              body: '{"model":"claude-test","max_tokens":1,"messages":[]}',
            }),
          ),
        { message },
      );
      t.false(String(refusal?.stack).includes('body-canary'));
    }
  });
}

test('a provider keeps one issuer and refuses a changed secret', async t => {
  const makeSecret = () =>
    makeExo('IssuerTestSecret', SecretInterface, {
      readBase64: async () => encodeBase64(encodeUtf8('anthropic-canary')),
    });
  const secret = makeSecret();
  const made = makeAnthropicApiKeyIssuerFactory({
    fetch: async () => {
      throw Error('no network in this test');
    },
  });
  t.teardown(() => made.dispose());
  const provider = harden({
    providerId: 'provider-one',
    kind: 'anthropic',
    defaultModel: 'claude-test',
  });
  const first = await made.factory.openEndpoint(provider, secret, {
    sessionId: 'grant-one',
  });
  const second = await made.factory.openEndpoint(provider, secret, {
    sessionId: 'grant-two',
  });
  t.not(first, second);
  await t.throwsAsync(
    () =>
      made.factory.openEndpoint(provider, makeSecret(), {
        sessionId: 'grant-three',
      }),
    { message: /Anthropic provider secret changed/ },
  );
  await made.dispose();
  const message = harden({
    method: 'POST',
    path: '/v1/messages',
    body: '{"model":"claude-test","max_tokens":1,"messages":[]}',
  });
  await t.throwsAsync(() => first.request(message), {
    message: /Inference endpoint revoked/,
  });
});

test('the module entry point disposes its issuers with the formula context', async t => {
  const hooks = [];
  const context = makeExo(
    'IssuerTestContext',
    M.interface('IssuerTestContext', {
      addDisposalHook: M.call(M.any()).returns(),
    }),
    {
      addDisposalHook: hook => {
        hooks.push(hook);
      },
    },
  );
  const factory = await make(undefined, context);
  t.is(hooks.length, 1);
  t.truthy(factory.openEndpoint);
  await hooks[0]();
  t.truthy(await make(undefined, undefined));
});
