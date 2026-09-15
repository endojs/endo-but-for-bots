// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeOpenRouterProvider, createProvider } from '../providers/index.js';
import { detectProviderKind } from '../providers/config.js';

const options = { apiKey: 'test-not-a-key', model: 'vendor/model' };

test('OpenRouter requires a key and explicit qualified model', t => {
  t.is(detectProviderKind('https://openrouter.ai/api/v1'), 'openrouter');
  t.not(detectProviderKind('https://openrouter.ai.evil/api/v1'), 'openrouter');
  t.throws(() => createProvider({ LAL_HOST: 'https://openrouter.ai/api/v1' }), {
    message: /key/,
  });
  t.throws(() => makeOpenRouterProvider({ ...options, model: '' }), {
    message: /organization/,
  });
  t.throws(() => makeOpenRouterProvider({ ...options, maxTokens: NaN }), {
    message: /positive integer/,
  });
});

test('OpenRouter round trips tool calls, reports usage, and honors cancellation', async t => {
  const controller = new AbortController();
  const call = {
    id: 'call1',
    type: 'function',
    function: { name: 'lookup', arguments: '{"name":"a"}' },
  };
  const provider = makeOpenRouterProvider({
    ...options,
    fetchImpl: async (url, init) => {
      t.is(url, 'https://openrouter.ai/api/v1/chat/completions');
      t.is(init.redirect, 'error');
      t.is(init.headers.Authorization, 'Bearer test-not-a-key');
      const body = JSON.parse(init.body);
      t.deepEqual(body.messages[0].tool_calls, [call]);
      t.is(body.messages[1].tool_call_id, 'call1');
      controller.abort();
      t.true(init.signal.aborted);
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Done' },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
      );
    },
  });
  const deltas = [];
  const result = await provider.chatStream(
    [
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', content: 'found', tool_call_id: 'call1' },
    ],
    [],
    text => deltas.push(text),
    controller.signal,
  );
  t.deepEqual(deltas, ['Done']);
  t.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
});

test('OpenRouter preserves tool calls and reasoning details across tool rounds', async t => {
  const tool = {
    id: 'call',
    type: 'function',
    function: { name: 'lookup', arguments: '{}' },
  };
  const details = [{ type: 'reasoning.encrypted', data: 'opaque' }];
  let round = 0;
  const provider = makeOpenRouterProvider({
    ...options,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      round += 1;
      if (round === 1) {
        t.is(body.tools[0].function.name, 'lookup');
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [tool],
                  reasoning_details: details,
                },
              },
            ],
          }),
        );
      }
      t.deepEqual(body.messages[0].reasoning_details, details);
      t.deepEqual(body.messages[0].tool_calls, [tool]);
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
    },
  });
  const { message } = await provider.chat(
    [],
    [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
  );
  t.deepEqual(message.tool_calls, [tool]);
  await provider.chat(
    [message, { role: 'tool', tool_call_id: 'call', content: 'result' }],
    [],
  );
});

/** @type {Array<[string, object, number]>} */
const failures = [
  ['HTTP failure', { error: 'test-not-a-key' }, 401],
  ['API failure', { error: { message: 'test-not-a-key' } }, 200],
  ['empty choices', { choices: [] }, 200],
  [
    'truncation',
    { choices: [{ finish_reason: 'length', message: { role: 'assistant' } }] },
    200,
  ],
  [
    'bad tools',
    { choices: [{ message: { role: 'assistant', tool_calls: [{}] } }] },
    200,
  ],
];
for (const [name, body, status] of failures) {
  test(`OpenRouter rejects ${name} without exposing response bodies`, async t => {
    const provider = makeOpenRouterProvider({
      ...options,
      fetchImpl: async () => new Response(JSON.stringify(body), { status }),
    });
    const error = await t.throwsAsync(() => provider.chat([], []));
    t.false(error.message.includes('test-not-a-key'));
  });
}
