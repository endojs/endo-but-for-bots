import test from '@endo/ses-ava/prepare-endo.js';

import {
  createChatProvider,
  detectProviderKind,
  getDefaultModelForHost,
  resolveModelForHost,
} from '@endo/agentry/chat';

const model = harden({
  id: 'test',
  name: 'test/test',
  api: 'faux',
  provider: 'faux',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
});

const response = harden({
  role: 'assistant',
  content: [
    { type: 'text', text: 'done' },
    { type: 'toolCall', id: 'call-1', name: 'finish', arguments: { ok: true } },
  ],
  api: 'faux',
  provider: 'faux',
  model: 'test',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'toolUse',
  timestamp: 0,
});

test('createChatProvider accepts arbitrary Anthropic model ids', t => {
  const provider = createChatProvider({
    LAL_HOST: 'https://api.anthropic.com',
    LAL_MODEL: 'claude-future-model',
    LAL_AUTH_TOKEN: 'test-only',
  });
  t.is(typeof provider.chat, 'function');
});

test('chat adapter translates common messages, tools, and response', async t => {
  let request;
  const provider = createChatProvider(
    { LAL_AUTH_TOKEN: 'secret' },
    {
      model,
      complete: async (_model, context, options) => {
        request = { context, options };
        return response;
      },
    },
  );
  const result = await provider.chat(
    [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ],
    [
      {
        type: 'function',
        function: {
          name: 'finish',
          description: 'Finish',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  );
  t.is(request.context.systemPrompt, 'system');
  t.is(request.context.messages[0].role, 'user');
  t.is(request.context.tools[0].name, 'finish');
  t.is(request.options.apiKey, 'secret');
  t.deepEqual(result.message.tool_calls, [
    {
      id: 'call-1',
      type: 'function',
      function: { name: 'finish', arguments: '{"ok":true}' },
    },
  ]);
});

test('streaming adapter forwards text deltas', async t => {
  const deltas = [];
  const provider = createChatProvider(
    {},
    {
      model,
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', contentIndex: 0, delta: 'do' };
          yield { type: 'text_delta', contentIndex: 0, delta: 'ne' };
        },
        result: async () => response,
      }),
    },
  );
  const result = await provider.chatStream([], [], delta => deltas.push(delta));
  t.deepEqual(deltas, ['do', 'ne']);
  t.is(result.message.content, 'done');
});

test('detectProviderKind recognizes Gemini OpenAI-compatible endpoint', t => {
  t.is(
    detectProviderKind(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    ),
    'google',
  );
});

test('getDefaultModelForHost returns Gemini default model', t => {
  t.is(
    getDefaultModelForHost(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    ),
    'gemini-2.5-pro',
  );
});

test('resolveModelForHost upgrades legacy qwen3 placeholder for Gemini', t => {
  t.is(
    resolveModelForHost(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
      'qwen3',
    ),
    'gemini-2.5-pro',
  );
});

test('resolveModelForHost preserves explicit non-default OpenAI-compatible models', t => {
  t.is(resolveModelForHost('https://api.openai.com/v1', 'gpt-4o'), 'gpt-4o');
});
