// @ts-check

import '@endo/init/debug.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import test from 'ava';
import { makeSubscriptionProviderService } from '../subscription-provider-service.js';

const config = harden({
  kind: /** @type {const} */ ('claude'),
  model: 'claude-test',
  sessionId: 'storybook-test',
});
const tools = harden([
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Run code',
      parameters: { type: 'object', properties: { code: { type: 'string' } } },
    },
  },
]);
const messages = harden([
  { role: 'system', content: 'Tell a story' },
  { role: 'user', content: 'Begin' },
]);

/** @param {any} [options] */
const fixture = (options = {}) => {
  let revoked = 0;
  let opened = 0;
  const requests = [];
  const endpoint = Far('Endpoint', {
    request: request => {
      requests.push(request);
      if (options.error) throw Error('private-token-internal');
      return harden({
        status: options.status ?? 200,
        body: JSON.stringify(
          options.response ?? {
            content: [
              {
                type: 'tool_use',
                id: 'call1',
                name: 'exec',
                input: { code: 'return 1' },
              },
            ],
          },
        ),
      });
    },
    revoke: () => {
      revoked += 1;
    },
  });
  const subscription = Far('Subscription', {
    describe: () => harden({ models: options.models ?? [] }),
    openEndpoint: spec => {
      if (spec.sessionId !== config.sessionId)
        throw Error('Unexpected session');
      opened += 1;
      return endpoint;
    },
  });
  const powers = Far('ProviderNamespace', {
    lookup: name => {
      if (name !== 'llm-subscription') throw Error('Unexpected power lookup');
      return subscription;
    },
  });
  return {
    powers,
    subscription,
    requests,
    opened: () => opened,
    revoked: () => revoked,
  };
};

test('Claude subscription preserves tool identities and releases each inference endpoint', async t => {
  const f = fixture();
  const service = makeSubscriptionProviderService(f.powers, config);
  const result = await E(service).chat(messages, tools);
  t.deepEqual(result.message.tool_calls, [
    {
      id: 'call1',
      type: 'function',
      function: { name: 'exec', arguments: '{"code":"return 1"}' },
    },
  ]);
  await E(service).chat(
    harden([
      ...messages,
      result.message,
      { role: 'tool', tool_call_id: 'call1', content: '1' },
    ]),
    tools,
  );
  const request = JSON.parse(f.requests[1].body);
  t.is(request.messages[1].content[0].id, 'call1');
  t.is(request.messages[2].content[0].tool_use_id, 'call1');
  t.deepEqual(request.tools[0].input_schema, tools[0].function.parameters);
  t.deepEqual(request.thinking, { type: 'disabled' });
  t.is(request.system, 'Tell a story');
  t.is(f.requests[0].path, '/v1/messages');
  t.is(f.opened(), 2);
  t.is(f.revoked(), 2);
  t.deepEqual(await E(service).getInfo(), {
    kind: 'claude-subscription',
    model: 'claude-test',
    authRequired: false,
  });
});

test('Claude subscription retains disjoint token usage for upstream accounting', async t => {
  const f = fixture({
    response: {
      content: [{ type: 'text', text: 'Ready' }],
      usage: {
        input_tokens: 19,
        output_tokens: 7,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 5,
        private_provider_field: 'must not cross the service boundary',
      },
    },
  });
  const response = await E(
    makeSubscriptionProviderService(f.powers, config),
  ).chat(messages, tools);
  t.deepEqual(response.usage, {
    inputTokens: 19,
    outputTokens: 7,
    cachedInputTokens: 11,
    cacheWriteInputTokens: 5,
    reasoningOutputTokens: 0,
    context: { usedTokens: 42, windowTokens: 0 },
  });
  t.is(f.revoked(), 1);
});

test('subscription failures are sanitized and acquired endpoints are revoked', async t => {
  const f = fixture({ error: true });
  const service = makeSubscriptionProviderService(f.powers, config);
  const error = await t.throwsAsync(() => E(service).chat(messages, tools));
  t.false(String(error).includes('private-token'));
  t.regex(String(error), /Subscription inference failed/);
  t.is(f.revoked(), 1);
});

test('published subscription catalog constrains model choice before endpoint admission', async t => {
  const f = fixture({ models: ['other-model'] });
  await t.throwsAsync(() =>
    E(makeSubscriptionProviderService(f.powers, config)).chat(messages, tools),
  );
  t.is(f.opened(), 0);
});

test('Codex delegates common protocol to hosted adapter and disposes it', async t => {
  await null;
  const f = fixture();
  let disposed = 0;
  let calls = 0;
  const service = makeSubscriptionProviderService(
    f.powers,
    { ...config, kind: 'codex', model: 'gpt-test' },
    {
      makeResponsesProvider: options => {
        t.is(options.subscription, f.subscription);
        t.is(options.model, 'gpt-test');
        t.is(options.sessionId, config.sessionId);
        return {
          chat: async (input, schemas) => {
            calls += 1;
            t.deepEqual(input, messages);
            t.deepEqual(schemas, tools);
            return { message: { role: 'assistant', content: 'Ready' } };
          },
          dispose: async () => {
            disposed += 1;
          },
        };
      },
    },
  );
  t.is((await E(service).chat(messages, tools)).message.content, 'Ready');
  t.is(calls, 1);
  t.is(disposed, 1);
});

test('subscription bridge rejects ambient routing or credential configuration', t => {
  const f = fixture();
  t.throws(() =>
    makeSubscriptionProviderService(
      f.powers,
      /** @type {any} */ ({ ...config, authToken: 'forbidden' }),
    ),
  );
  t.throws(() =>
    makeSubscriptionProviderService(f.powers, {
      ...config,
      sessionId: '../unsafe',
    }),
  );
  t.throws(() =>
    makeSubscriptionProviderService(f.powers, { ...config, maxTokens: 0 }),
  );
});

test('Codex inference and cleanup errors never expose underlying broker details', async t => {
  const f = fixture();
  let disposed = 0;
  const service = makeSubscriptionProviderService(
    f.powers,
    { ...config, kind: 'codex' },
    {
      makeResponsesProvider: () => ({
        chat: async () => {
          throw Error('private-inference-token');
        },
        dispose: () => {
          disposed += 1;
          throw Error('private-cleanup-token');
        },
      }),
    },
  );
  const error = await t.throwsAsync(() => E(service).chat(messages, tools));
  t.false(String(error).includes('private-'));
  t.regex(String(error), /Subscription endpoint cleanup failed/);
  t.is(disposed, 1);
});
