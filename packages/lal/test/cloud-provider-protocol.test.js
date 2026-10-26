// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeAnthropicProvider } from '../providers/anthropic.js';
import { makeLlamaCppProvider } from '../providers/llamacpp.js';

const tools = harden([
  {
    type: /** @type {const} */ ('function'),
    function: {
      name: 'exec',
      description: 'Run confined story operations.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          finishTurn: { type: 'boolean' },
        },
        required: ['code'],
      },
    },
  },
]);
const messages = harden([
  {
    role: /** @type {const} */ ('user'),
    content: 'Open the next page with exec.',
  },
]);

test('canonical OpenAI Luna uses completion token budget and nonreasoning tool calls', async t => {
  /** @type {any} */
  let request;
  const provider = makeLlamaCppProvider(
    {
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-6-luna',
      apiKey: 'fake-test-key',
      maxTokens: 2048,
    },
    {
      createCompletion: async value => {
        request = value;
        return {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call1',
                    function: {
                      name: 'exec',
                      arguments: '{"code":"return 1;","finishTurn":true}',
                    },
                  },
                ],
              },
            },
          ],
        };
      },
    },
  );
  const response = await provider.chat([...messages], [...tools]);
  t.is(request.max_completion_tokens, 2048);
  t.false(Object.hasOwn(request, 'max_tokens'));
  t.is(request.reasoning_effort, 'none');
  t.deepEqual(request.tools, tools);
  t.deepEqual(response.message.tool_calls, [
    {
      id: 'call1',
      type: 'function',
      function: {
        name: 'exec',
        arguments: '{"code":"return 1;","finishTurn":true}',
      },
    },
  ]);
});

test('local compatible endpoints keep max_tokens and no cloud-only reasoning controls', async t => {
  for (const baseURL of [
    'http://blackquartz.example:8080/v1',
    'https://api.openai.com.attacker.example/v1',
  ]) {
    const provider = makeLlamaCppProvider(
      { baseURL, model: 'gpt-6-luna', maxTokens: 1024 },
      {
        createCompletion: async request => {
          t.is(request.max_tokens, 1024);
          t.false(Object.hasOwn(request, 'max_completion_tokens'));
          t.false(Object.hasOwn(request, 'reasoning_effort'));
          return { choices: [{ message: { content: 'Ready.' } }] };
        },
      },
    );
    // eslint-disable-next-line no-await-in-loop
    await provider.chat([...messages], [...tools]);
  }
});

test('Haiku 5.5 disables implicit thinking, honors budget and preserves tool round-trip IDs', async t => {
  /** @type {any[]} */
  const requests = [];
  const provider = makeAnthropicProvider(
    { apiKey: 'fake-test-key', model: 'claude-haiku-5-5', maxTokens: 2048 },
    {
      createMessage: async request => {
        requests.push(request);
        return {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'exec',
              input: { code: 'return 1;' },
            },
          ],
        };
      },
    },
  );
  const response = await provider.chat([...messages], [...tools]);
  t.deepEqual(requests[0].thinking, { type: 'disabled' });
  t.is(requests[0].max_tokens, 2048);
  t.deepEqual(requests[0].tools, [
    {
      name: 'exec',
      description: tools[0].function.description,
      input_schema: tools[0].function.parameters,
    },
  ]);
  t.deepEqual(response.message.tool_calls, [
    {
      id: 'tool1',
      function: { name: 'exec', arguments: '{"code":"return 1;"}' },
    },
  ]);
  await provider.chat(
    [
      ...messages,
      response.message,
      { role: 'tool', content: '1', tool_call_id: 'tool1' },
    ],
    [...tools],
  );
  t.deepEqual(requests[1].messages.at(-1), {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool1', content: '1' }],
  });
});
