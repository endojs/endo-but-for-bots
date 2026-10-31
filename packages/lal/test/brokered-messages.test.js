// @ts-check
// prefer-endo-primitives-exempt: wire fixtures exercise native byte decoding and AbortSignal.

import test from '@endo/ses-ava/prepare-endo.js';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { Far } from '@endo/marshal';

import {
  assertBrokeredMessagesRecipe,
  makeBrokeredMessagesProvider,
  makeBrokeredMessagesStream,
} from '../providers/brokered-messages.js';
import { spawnWorkerLoop } from '../agent.js';
import { makeMockPowers } from '../tools/mock-powers.js';

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
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 3 },
  },
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

test('a cancel before the broker responds closes the late reader', async t => {
  /** @type {((response: any) => void) | undefined} */
  let respond;
  let closed = false;
  const inference = Far('LateAgentInference', {
    requestByteStream: () =>
      new Promise(resolve => {
        respond = resolve;
      }),
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
  for (let turn = 0; turn < 10 && respond === undefined; turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  controller.abort(Error('stop now'));
  await t.throwsAsync(pending, { message: 'stop now' });
  /** @type {(response: any) => void} */ (respond)(
    harden({
      status: 200,
      contentType: 'text/event-stream',
      reader: bytesReaderFromIterator(
        /** @type {any} */ ({
          next: async () => {
            await new Promise(() => {});
          },
          return: async () => {
            closed = true;
            return harden({ done: true, value: undefined });
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        }),
      ),
    }),
  );
  for (let turn = 0; turn < 50 && !closed; turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  t.true(closed);
});

/** @param {any} stream */
const drain = async stream => {
  const seen = [];
  for await (const event of stream) seen.push(event.type);
  return { seen, message: await stream.result() };
};

test('the pi stream sends the pi-ai context system prompt and tools', async t => {
  const subject = fixture();
  const streamFn = makeBrokeredMessagesStream({
    inference: subject.inference,
    model: 'claude-test',
  });
  await drain(
    streamFn(undefined, {
      systemPrompt: 'Be terse',
      messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
      tools: [{ name: 'lookup', description: 'look up', parameters: {} }],
    }),
  );
  const body = JSON.parse(subject.requests[0].body);
  t.is(body.system, 'Be terse');
  t.deepEqual(
    body.tools.map(tool => tool.name),
    ['lookup'],
  );
  t.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
});

test('the pi stream translates harness history and reports a tool-use turn', async t => {
  const subject = fixture();
  const streamFn = makeBrokeredMessagesStream({
    inference: subject.inference,
    model: 'claude-test',
  });
  const { seen, message } = await drain(
    streamFn(undefined, {
      messages: [
        {
          role: 'system',
          content: 'Be terse',
          toolsAdded: [
            { name: 'lookup', description: 'look up', parameters: {} },
            { name: 'retired', description: 'gone', parameters: {} },
          ],
          toolsRemoved: [{ name: 'retired' }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'image', data: 'ignored' },
            { type: 'text', text: 'second' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            {
              type: 'toolCall',
              id: 'call-0',
              name: 'lookup',
              arguments: { name: 'a' },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-0',
          content: [{ type: 'text', text: 'found a' }],
        },
      ],
    }),
  );
  t.deepEqual(seen, ['start', 'done']);
  t.is(message.stopReason, 'toolUse');
  t.deepEqual(message.content, [
    { type: 'text', text: 'Done now' },
    {
      type: 'toolCall',
      id: 'call-1',
      name: 'lookup',
      arguments: { name: 'shell' },
    },
  ]);
  t.like(message.usage, {
    input: 4,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 10,
  });
  const body = JSON.parse(subject.requests[0].body);
  t.is(body.max_tokens, 4096);
  t.is(body.system, 'Be terse');
  t.deepEqual(
    body.tools.map(tool => tool.name),
    ['lookup'],
  );
  t.deepEqual(body.messages, [
    { role: 'user', content: 'first\nsecond' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        {
          type: 'tool_use',
          id: 'call-0',
          name: 'lookup',
          input: { name: 'a' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-0', content: 'found a' },
      ],
    },
  ]);
});

test('the pi stream reports broker failures as an error event', async t => {
  const subject = fixture(401);
  const streamFn = makeBrokeredMessagesStream({
    inference: subject.inference,
    model: 'claude-test',
  });
  const { seen, message } = await drain(
    streamFn(undefined, { messages: [{ role: 'user', content: 'hello' }] }),
  );
  t.deepEqual(seen, ['error']);
  t.is(message.stopReason, 'error');
  t.is(message.errorMessage, 'Anthropic authentication failed');
  t.deepEqual(message.content, []);
});

test('the pi stream refuses unsupported history before contacting the broker', async t => {
  const subject = fixture();
  const streamFn = makeBrokeredMessagesStream({
    inference: subject.inference,
    model: 'claude-test',
  });
  const { message } = await drain(
    streamFn(undefined, { messages: [{ role: 'developer', content: 'x' }] }),
  );
  t.is(message.errorMessage, 'Unsupported brokered Messages history');
  t.is(subject.requests.length, 0);
});

test('the pi stream marks an aborted turn as aborted', async t => {
  const inference = Far('PendingAgentInference', {
    requestByteStream: () => new Promise(() => {}),
  });
  const streamFn = makeBrokeredMessagesStream({
    inference,
    model: 'claude-test',
  });
  const controller = new AbortController();
  const stream = streamFn(
    undefined,
    { messages: [{ role: 'user', content: 'hello' }] },
    { signal: controller.signal },
  );
  controller.abort(Error('stop now'));
  const { seen, message } = await drain(stream);
  t.deepEqual(seen, ['error']);
  t.is(message.stopReason, 'aborted');
  t.is(message.errorMessage, 'stop now');
});

test('disposal cancels a pending broker request and refuses later turns', async t => {
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
  const pending = provider.chat([{ role: 'user', content: 'hello' }], []);
  for (let turn = 0; turn < 10 && !requested; turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  await provider.dispose();
  await t.throwsAsync(pending, {
    message: 'Brokered Messages provider disposed',
  });
  await t.throwsAsync(provider.chat([{ role: 'user', content: 'again' }], []), {
    message: 'Brokered Messages provider disposed',
  });
});

/**
 * A broker whose response bytes are supplied verbatim, so each test can shape
 * the Server-Sent Events framing, status, and content type independently.
 *
 * @param {object} options
 * @param {() => Iterable<Uint8Array>} [options.chunks]
 * @param {number} [options.status]
 * @param {string} [options.contentType]
 */
const rawFixture = ({
  chunks = () => [],
  status = 200,
  contentType = 'text/event-stream',
}) => {
  const requests = [];
  const inference = Far('RawAgentInference', {
    requestByteStream: message => {
      requests.push(message);
      return harden({
        status,
        contentType,
        reader: bytesReaderFromIterator(chunks()[Symbol.iterator]()),
      });
    },
  });
  return { inference, requests };
};

/** @param {string} text */
const textChunks = text => () => [new TextEncoder().encode(text)];

/**
 * @param {any[]} list
 * @param {string} [newline]
 */
const sse = (list, newline = '\n') =>
  list
    .map(event => `data: ${JSON.stringify(event)}${newline}${newline}`)
    .join('');

const textStart = {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
};
const toolStart = {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'tool_use', id: 'call-1', name: 'lookup' },
};
const endTurn = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
const stop = { type: 'message_stop' };

/** @param {any} broker */
const chatWith = async broker => {
  await null;
  const provider = makeBrokeredMessagesProvider({
    inference: broker.inference,
    model: 'claude-test',
  });
  try {
    return await provider.chat([{ role: 'user', content: 'hello' }], []);
  } finally {
    await provider.dispose();
  }
};

test('brokered Messages accepts carriage-return framed events', async t => {
  const result = await chatWith(
    rawFixture({
      chunks: textChunks(
        sse(
          [
            textStart,
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'cr' },
            },
            endTurn,
            stop,
          ],
          '\r',
        ),
      ),
    }),
  );
  t.is(result.message.content, 'cr');
});

for (const [
  title,
  options,
  message,
] of /** @type {Array<[string, any, RegExp]>} */ ([
  [
    'a response past the transport bound',
    {
      // Each chunk is one complete ignored line, so parsing stays linear.
      chunks: function* oversized() {
        const chunk = new TextEncoder().encode(`:${'x'.repeat(65_534)}\n`);
        for (let count = 0; count <= 256; count += 1) yield chunk;
      },
    },
    /exceeds transport bound/,
  ],
  [
    'a truncated event',
    { chunks: textChunks(`${sse([textStart])}data: {"type":"mess`) },
    /Truncated Anthropic Messages stream event/,
  ],
  [
    'a stream that ends without message_stop',
    { chunks: textChunks(sse([textStart])) },
    /ended without message_stop/,
  ],
  [
    'an in-stream error event',
    {
      chunks: textChunks(
        sse([
          textStart,
          { type: 'error', error: { type: 'overloaded_error', message: 'x' } },
        ]),
      ),
    },
    /^Anthropic Messages inference failed$/,
  ],
  [
    'an event that is not JSON',
    { chunks: textChunks('data: {not json\n\n') },
    /Invalid Anthropic Messages stream event/,
  ],
  [
    'an unsupported content block type',
    {
      chunks: textChunks(
        sse([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking' },
          },
        ]),
      ),
    },
    /Unsupported Anthropic content block/,
  ],
  [
    'an invalid content block index',
    {
      chunks: textChunks(sse([{ ...textStart, index: -1 }])),
    },
    /Invalid Anthropic content block/,
  ],
  [
    'a repeated content block index',
    { chunks: textChunks(sse([textStart, textStart])) },
    /Invalid Anthropic content block/,
  ],
  [
    'a delta for an absent content block',
    {
      chunks: textChunks(
        sse([
          {
            type: 'content_block_delta',
            index: 3,
            delta: { type: 'text_delta', text: 'x' },
          },
        ]),
      ),
    },
    /delta has no content block/,
  ],
  [
    'a delta that does not match its block',
    {
      chunks: textChunks(
        sse([
          textStart,
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        ]),
      ),
    },
    /Invalid Anthropic content delta/,
  ],
  [
    'malformed tool input JSON',
    {
      chunks: textChunks(
        sse([
          toolStart,
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"name":' },
          },
          stop,
        ]),
      ),
    },
    /Invalid Anthropic tool input/,
  ],
  [
    'a refusal stop reason',
    {
      chunks: textChunks(
        sse([
          textStart,
          { type: 'message_delta', delta: { stop_reason: 'refusal' } },
          stop,
        ]),
      ),
    },
    /Unsupported Anthropic stop reason/,
  ],
  [
    'a stream with no stop reason',
    { chunks: textChunks(sse([textStart, stop])) },
    /Unsupported Anthropic stop reason/,
  ],
  [
    'a tool_use stop with no tool call',
    {
      chunks: textChunks(
        sse([
          textStart,
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          stop,
        ]),
      ),
    },
    /stop reason does not match its content/,
  ],
  [
    'an upstream 500',
    { status: 500, chunks: textChunks('{"error":"secret detail"}') },
    /^Anthropic Messages inference failed$/,
  ],
  [
    'a non-event-stream content type',
    { contentType: 'application/json', chunks: textChunks(sse([stop])) },
    /^Anthropic Messages inference failed$/,
  ],
])) {
  test(`brokered Messages rejects ${title}`, async t => {
    await t.throwsAsync(chatWith(rawFixture(options)), { message });
  });
}

test('brokered Messages recipes require a string model', t => {
  const { inference } = fixture();
  for (const model of [undefined, ['claude-test'], { toString: () => 'x' }]) {
    t.throws(
      () =>
        assertBrokeredMessagesRecipe(
          harden({ kind: 'brokered-messages', inference, model }),
        ),
      { message: /Invalid brokered Messages recipe/ },
    );
  }
});

test('brokered Messages recipes reject an unsafe maxTokens', t => {
  const { inference } = fixture();
  for (const maxTokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '64']) {
    t.throws(
      () =>
        assertBrokeredMessagesRecipe(
          harden({
            kind: 'brokered-messages',
            inference,
            model: 'claude-test',
            maxTokens,
          }),
        ),
      { message: /Invalid brokered Messages recipe/ },
      `maxTokens ${String(maxTokens)}`,
    );
  }
});

test('brokered Lal drives a turn through the broker with no API key', async t => {
  const subject = rawFixture({
    chunks: textChunks(
      sse([
        textStart,
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
        endTurn,
        stop,
      ]),
    ),
  });
  const { powers } = makeMockPowers({
    initialMessage: {
      number: 1,
      from: '@host',
      to: 'lal-self-id',
      strings: ['Say hello.'],
      names: [],
      ids: [],
    },
  });
  await spawnWorkerLoop(powers, null, {
    LAL_INFERENCE: subject.inference,
    LAL_MODEL: 'claude-test',
    LAL_MAX_TOKENS: '77',
  });
  t.is(subject.requests.length, 1);
  const [request] = subject.requests;
  t.deepEqual(Object.keys(request).sort(), ['body', 'method', 'path']);
  const body = JSON.parse(request.body);
  t.is(body.model, 'claude-test');
  t.is(body.max_tokens, 77);
  t.false(/api[-_]?key|authorization/i.test(JSON.stringify(request)));
});

const brokeredTurn = async env => {
  const subject = rawFixture({
    chunks: textChunks(sse([textStart, endTurn, stop])),
  });
  const { powers } = makeMockPowers({
    initialMessage: {
      number: 1,
      from: '@host',
      to: 'lal-self-id',
      strings: ['Say hello.'],
      names: [],
      ids: [],
    },
  });
  await spawnWorkerLoop(powers, null, {
    LAL_INFERENCE: subject.inference,
    ...env,
  });
  return subject;
};

test('brokered Lal defaults max_tokens to 4096', async t => {
  const subject = await brokeredTurn({ LAL_MODEL: 'claude-test' });
  t.is(JSON.parse(subject.requests[0].body).max_tokens, 4096);
});

test('brokered Lal rejects a missing model', async t => {
  await t.throwsAsync(brokeredTurn({ LAL_MAX_TOKENS: '77' }), {
    message: /Invalid brokered Messages recipe/,
  });
});

test('the pi stream reports a max_tokens stop as a truncation', async t => {
  const encoded = new TextEncoder().encode(
    [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'cut' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
      .map(event => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
  );
  const inference = Far('AgentInference', {
    requestByteStream: () =>
      harden({
        status: 200,
        contentType: 'text/event-stream',
        reader: bytesReaderFromIterator([encoded][Symbol.iterator]()),
      }),
  });
  const streamFn = makeBrokeredMessagesStream({
    inference,
    model: 'claude-test',
  });
  t.teardown(() => streamFn.dispose());
  const { message } = await drain(
    streamFn(undefined, {
      messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
    }),
  );
  t.is(message.stopReason, 'length');
});
