// @ts-check
// prefer-endo-primitives-exempt: wire fixtures exercise native byte decoding and AbortSignal.

import test from '@endo/ses-ava/prepare-endo.js';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { Far } from '@endo/marshal';

import {
  assertBrokeredMessagesRecipe,
  makeBrokeredMessagesProvider,
} from '../providers/brokered-messages.js';
import { spawnWorkerLoop } from '../agent.js';

const events = [
  {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Done ' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'now' },
  },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'call-1', name: 'lookup' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"name":"shell"}' },
  },
  { type: 'message_delta', usage: { output_tokens: 3 } },
  { type: 'message_stop' },
];

const fixture = (status = 200) => {
  const requests = [];
  const encoded = new TextEncoder().encode(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  );
  const inference = Far('AgentInference', {
    requestByteStream: message => {
      requests.push(message);
      return harden({
        status,
        contentType: 'text/event-stream',
        reader: bytesReaderFromIterator(
          (function* chunks() {
            for (let at = 0; at < encoded.length; at += 5) {
              yield encoded.slice(at, at + 5);
            }
          })(),
        ),
      });
    },
  });
  return { inference, requests };
};

test('brokered Messages streams Anthropic events without a URL or credential', async t => {
  const subject = fixture();
  const provider = makeBrokeredMessagesProvider({
    inference: subject.inference,
    model: 'claude-test',
    maxTokens: 128,
  });
  t.teardown(() => provider.dispose());
  const deltas = [];
  const usages = [];
  const result = await provider.chatStream(
    [
      { role: 'system', content: 'Be terse' },
      { role: 'user', content: 'Do it' },
    ],
    [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'look up a name',
          parameters: { type: 'object' },
        },
      },
    ],
    text => deltas.push(text),
    undefined,
    usage => usages.push(usage),
  );
  t.deepEqual(deltas, ['Done ', 'now']);
  t.is(result.message.content, 'Done now');
  t.deepEqual(result.message.tool_calls, [
    {
      id: 'call-1',
      function: { name: 'lookup', arguments: '{"name":"shell"}' },
    },
  ]);
  t.deepEqual(result.usage, {
    inputTokens: 4,
    outputTokens: 3,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    reasoningOutputTokens: 0,
    context: { usedTokens: 10, windowTokens: 0 },
  });
  t.deepEqual(usages, [result.usage]);
  const request = subject.requests[0];
  t.deepEqual(Object.keys(request).sort(), ['body', 'method', 'path']);
  t.is(request.path, '/v1/messages');
  const body = JSON.parse(request.body);
  t.is(body.model, 'claude-test');
  t.is(body.max_tokens, 128);
  t.true(body.stream);
  t.false(JSON.stringify(request).includes('api-key'));
});

test('brokered Messages recipes reject authority-bearing fields', t => {
  const { inference } = fixture();
  for (const extra of [
    { authToken: 'secret' },
    { apiKey: 'secret' },
    { host: 'https://evil.example' },
  ]) {
    t.throws(
      () =>
        assertBrokeredMessagesRecipe(
          harden({
            kind: 'brokered-messages',
            inference,
            model: 'claude-test',
            ...extra,
          }),
        ),
      { message: /Invalid brokered Messages recipe/ },
    );
  }
});

test('brokered Lal rejects ambient host and token configuration', async t => {
  const { inference } = fixture();
  for (const authority of [
    { LAL_AUTH_TOKEN: 'secret' },
    { LAL_HOST: 'https://api.anthropic.com' },
  ]) {
    // Validation happens before any guest power is consulted.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      spawnWorkerLoop(null, null, {
        LAL_INFERENCE: inference,
        LAL_MODEL: 'claude-test',
        ...authority,
      }),
      { message: /cannot contain key material or a host/ },
    );
  }
});

for (const [status, message] of /** @type {Array<[number, string]>} */ ([
  [401, 'Anthropic authentication failed'],
  [429, 'Anthropic rate limit reached'],
])) {
  test(`brokered Messages maps upstream ${status} without exposing a body`, async t => {
    const subject = fixture(status);
    const provider = makeBrokeredMessagesProvider({
      inference: subject.inference,
      model: 'claude-test',
    });
    t.teardown(() => provider.dispose());
    await t.throwsAsync(
      provider.chat([{ role: 'user', content: 'hello' }], []),
      { message },
    );
  });
}

test('a harness abort cancels a pending broker request', async t => {
  let requested = false;
  const inference = Far('PendingAgentInference', {
    requestByteStream: async () => {
      requested = true;
      await new Promise(() => {});
    },
  });
  const provider = makeBrokeredMessagesProvider({
    inference,
    model: 'claude-test',
  });
  t.teardown(() => provider.dispose());
  const controller = new AbortController();
  const pending = provider.chat(
    [{ role: 'user', content: 'hello' }],
    [],
    controller.signal,
  );
  for (let turn = 0; turn < 10 && !requested; turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  controller.abort(Error('stop now'));
  await t.throwsAsync(pending, { message: 'stop now' });
});
