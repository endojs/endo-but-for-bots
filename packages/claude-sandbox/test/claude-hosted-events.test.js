// @ts-check
import '@endo/init';
import test from 'ava';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import {
  makeClaudeHostedTranslator,
  translateClaudeTurn,
} from '../src/claude-hosted-events.js';

const drain = async reader => {
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

test('completed-turn capture follows native result and precedes terminal delivery', async t => {
  const raw = makeBufferedReader();
  const retainedTail = [
    { kind: 'tool-call', id: 't', name: 'Bash', args: '{}' },
    { kind: 'tool-result', id: 't', content: 'ok' },
    { kind: 'message', role: 'assistant', content: 'Done.' },
  ];
  const checkpoint = {
    kind: 'native-context',
    format: 'claude-code-jsonl-v1',
    payload: 'synthetic native payload',
    context: [{ kind: 'compaction', summary: 'Earlier work' }, ...retainedTail],
  };
  raw.push({ type: 'result', subtype: 'success', result: 'Done.' });
  raw.push({ type: 'endo_native_context', checkpoint });
  raw.push({ type: 'end' });
  const events = await drain(translateClaudeTurn(raw.reader));
  t.deepEqual(events.slice(-2), [
    { type: 'native-context', checkpoint },
    { type: 'end' },
  ]);
  t.false(events.some(event => event.type === 'tool-call'));
});

test('malformed capture fails translation without publishing a checkpoint', async t => {
  const raw = makeBufferedReader();
  raw.push({ type: 'endo_native_context', checkpoint: 42 });
  raw.push({ type: 'end' });
  const events = await drain(translateClaudeTurn(raw.reader));
  t.false(events.some(event => event.type === 'native-context'));
  t.is(events.at(-1).type, 'abort');
});

test('translated delivery backpressures bursts and drains in order', async t => {
  t.timeout(10_000);
  const raw = makeBufferedReader();
  for (let i = 0; i < 3000; i += 1) {
    raw.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `${i},` }] },
    });
  }
  raw.push({ type: 'end' });
  const reader = translateClaudeTurn(raw.reader);
  await new Promise(resolve => setTimeout(resolve, 20));
  const events = await drain(reader);
  t.is(
    events
      .filter(e => e.type === 'text-delta')
      .map(e => e.text)
      .join(''),
    Array.from({ length: 3000 }, (_, i) => `${i},`).join(''),
  );
  t.is(events.at(-1).type, 'end');
});

test('closing a backpressured translated reader closes its raw producer', async t => {
  t.timeout(5000);
  let closed = false;
  const raw = makeBufferedReader({
    onClose: () => {
      closed = true;
    },
  });
  for (let i = 0; i < 3000; i += 1) {
    raw.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `${i},` }] },
    });
  }
  const iterator = iterateReader(translateClaudeTurn(raw.reader), {
    buffer: 0,
  });
  await iterator.next();
  await new Promise(resolve => setTimeout(resolve, 20));
  await iterator.return();
  // Closure crosses two credit readers; yield until both have observed it.
  for (let i = 0; i < 100 && !closed; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  t.true(closed);
});

test('translator maps stream-json events onto hosted turn events', t => {
  const translator = makeClaudeHostedTranslator();
  const log = [
    ...translator.handle({ type: 'system', subtype: 'init' }),
    ...translator.handle({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check. ' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'mcp__endo__lookup',
            input: { path: 'a' },
          },
        ],
      },
    }),
    ...translator.handle({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'file contents' }],
          },
        ],
      },
    }),
    ...translator.handle({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Done.' }] },
    }),
    ...translator.handle({
      type: 'result',
      subtype: 'success',
      result: 'Let me check. Done.',
      num_turns: 2,
      usage: { input_tokens: 11, output_tokens: 7 },
    }),
    ...translator.finish(),
  ];
  t.deepEqual(log, [
    { type: 'phase', phase: 'claude session starting' },
    { type: 'phase', phase: 'responding' },
    { type: 'text-delta', text: 'Let me check. ' },
    {
      type: 'tool-call',
      id: 'toolu_1',
      name: 'mcp__endo__lookup',
      args: '{"path":"a"}',
    },
    {
      type: 'tool-result',
      id: 'toolu_1',
      name: 'mcp__endo__lookup',
      result: 'file contents',
    },
    { type: 'text-delta', text: 'Done.' },
    {
      type: 'usage',
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    { type: 'end' },
  ]);
});

test('startup phase clears on the first tool call rather than the first text', t => {
  const translator = makeClaudeHostedTranslator();
  const log = [
    ...translator.handle({ type: 'system', subtype: 'init' }),
    ...translator.handle({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }],
      },
    }),
    ...translator.handle({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
      },
    }),
  ];
  t.deepEqual(
    log.map(event => event.type),
    ['phase', 'phase', 'tool-call', 'tool-result'],
  );
  t.deepEqual(log[1], { type: 'phase', phase: 'using tools' });
});

test('partial text deltas are not duplicated by the complete assistant event', t => {
  const translator = makeClaudeHostedTranslator();
  const log = [
    ...translator.handle({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello ' },
      },
    }),
    ...translator.handle({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'world.' },
      },
    }),
    ...translator.handle({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world.' }] },
    }),
    ...translator.handle({
      type: 'result',
      subtype: 'success',
      result: 'Hello world.',
    }),
  ];
  t.deepEqual(log, [
    { type: 'text-delta', text: 'Hello ' },
    { type: 'text-delta', text: 'world.' },
  ]);
});

test('a streamed message repeated as one assistant event per block is not duplicated', t => {
  // Two text blocks of one API message stream as deltas, then the CLI repeats
  // the message as two assistant events. Neither repeat may reach the consumer.
  const translator = makeClaudeHostedTranslator();
  const delta = text => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
  const log = [
    ...translator.handle({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_1' } },
    }),
    ...translator.handle(delta('A')),
    ...translator.handle(delta('B')),
    ...translator.handle({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'A' }] },
    }),
    ...translator.handle({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'B' }] },
    }),
    // The next message streams afresh: its own deltas are emitted, its
    // repeat is not.
    ...translator.handle({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_2' } },
    }),
    ...translator.handle(delta('C')),
    ...translator.handle({
      type: 'assistant',
      message: { id: 'msg_2', content: [{ type: 'text', text: 'C' }] },
    }),
    // A message that never streamed (no deltas) is emitted from its
    // assistant event.
    ...translator.handle({
      type: 'assistant',
      message: { id: 'msg_3', content: [{ type: 'text', text: 'D' }] },
    }),
  ];
  t.deepEqual(log, [
    { type: 'text-delta', text: 'A' },
    { type: 'text-delta', text: 'B' },
    { type: 'text-delta', text: 'C' },
    { type: 'text-delta', text: 'D' },
  ]);

  // Without message ids on the wire, "the message currently streaming" still
  // covers every one of its repeats, not only the first.
  const unnamed = makeClaudeHostedTranslator();
  const bare = [
    ...unnamed.handle(delta('A')),
    ...unnamed.handle(delta('B')),
    ...unnamed.handle({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'A' }] },
    }),
    ...unnamed.handle({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'B' }] },
    }),
  ];
  t.deepEqual(bare, [
    { type: 'text-delta', text: 'A' },
    { type: 'text-delta', text: 'B' },
  ]);
});

test('subagent events never reach the hosted stream', t => {
  // A Task/Agent subagent's traffic carries the parent's tool_use id; its text
  // and tools are not the main session's reply.
  const translator = makeClaudeHostedTranslator();
  const log = [
    ...translator.handle({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { content: [{ type: 'text', text: 'subagent thinking' }] },
    }),
    ...translator.handle({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_sub', name: 'Read', input: {} },
        ],
      },
    }),
    ...translator.handle({
      type: 'user',
      parent_tool_use_id: 'toolu_parent',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_sub', content: 'x' },
        ],
      },
    }),
    ...translator.handle({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'The answer.' }] },
    }),
  ];
  t.deepEqual(log, [{ type: 'text-delta', text: 'The answer.' }]);
});

test('a result with text and no streamed reply surfaces the result text once', t => {
  const translator = makeClaudeHostedTranslator();
  const log = [
    ...translator.handle({
      type: 'result',
      subtype: 'success',
      result: 'The thing is done.',
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
    ...translator.finish(),
  ];
  t.deepEqual(log, [
    { type: 'text-delta', text: 'The thing is done.' },
    {
      type: 'usage',
      inputTokens: 3,
      outputTokens: 2,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    { type: 'end' },
  ]);
});

test('a failed result finishes as an abort, not a success', t => {
  const translator = makeClaudeHostedTranslator();
  // error_max_turns carries no `result` text — the failure is signalled only
  // by is_error, which must not read as a successful (empty) answer.
  translator.handle({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
  });
  t.deepEqual(translator.finish(), [
    { type: 'abort', reason: 'claude turn failed: error_max_turns' },
  ]);

  const withText = makeClaudeHostedTranslator();
  withText.handle({
    type: 'result',
    subtype: 'error_during_execution',
    result: 'credential expired',
    is_error: true,
  });
  t.deepEqual(withText.finish(), [
    { type: 'abort', reason: 'claude turn failed: credential expired' },
  ]);
});

test('translateClaudeTurn streams a full turn and ends it', async t => {
  const { push, reader } = makeBufferedReader();
  const hosted = translateClaudeTurn(reader);
  push({ type: 'system', subtype: 'init' });
  push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'On it.' }] },
  });
  push({
    type: 'result',
    subtype: 'success',
    result: 'On it.',
    usage: { input_tokens: 3, output_tokens: 2 },
  });
  push({ type: 'end' });
  const events = await drain(hosted);
  t.deepEqual(events, [
    { type: 'phase', phase: 'claude session starting' },
    { type: 'phase', phase: 'responding' },
    { type: 'text-delta', text: 'On it.' },
    {
      type: 'usage',
      inputTokens: 3,
      outputTokens: 2,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    { type: 'end' },
  ]);
});

test('an in-band abort from the client passes through with its reason', async t => {
  const { push, reader } = makeBufferedReader();
  const hosted = translateClaudeTurn(reader);
  push({ type: 'abort', reason: 'claude exited with code 1' });
  const events = await drain(hosted);
  t.deepEqual(events, [{ type: 'abort', reason: 'claude exited with code 1' }]);
});

for (const terminal of ['end', 'abort']) {
  test(`structured Claude errors survive ${terminal}`, async t => {
    const { push, reader } = makeBufferedReader();
    const hosted = translateClaudeTurn(reader);
    push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [
        'Model access refused',
        null,
        { private: 'do not stringify' },
        '',
        'Account diagnostic',
      ],
    });
    push({ type: terminal, reason: 'claude exited with code 1' });
    t.deepEqual(await drain(hosted), [
      {
        type: 'abort',
        reason: `claude turn failed: Model access refused\nAccount diagnostic${terminal === 'abort' ? '\nclaude exited with code 1' : ''}`,
      },
    ]);
  });
}

test('result text and structured errors are both preserved', t => {
  const translator = makeClaudeHostedTranslator();
  translator.handle({
    type: 'result',
    is_error: true,
    result: 'Summary',
    errors: ['Detail'],
  });
  t.deepEqual(translator.finish('transport failed'), [
    {
      type: 'abort',
      reason: 'claude turn failed: Summary\nDetail\ntransport failed',
    },
  ]);
});

test('structured error remains visible when raw producer closes without terminal', async t => {
  t.timeout(5000);
  const { push, reader, close } = makeBufferedReader();
  const iterator = iterateReader(translateClaudeTurn(reader));
  push({
    type: 'result',
    is_error: true,
    errors: ['Provider refused model'],
    usage: {},
  });
  t.is((await iterator.next()).value.type, 'usage');
  close();
  const remaining = [];
  for await (const event of iterator) remaining.push(event);
  t.deepEqual(remaining, [
    {
      type: 'abort',
      reason:
        'claude turn failed: Provider refused model\nclaude turn ended without a terminal event',
    },
  ]);
});

test('closing the hosted reader closes the raw reader (kills the turn)', async t => {
  let killed = 0;
  const { push, reader, setOnClose } = makeBufferedReader();
  setOnClose(() => {
    killed += 1;
  });
  const hosted = translateClaudeTurn(reader);
  const iterator = iterateReader(hosted);
  push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'working' }] },
  });
  const first = await iterator.next();
  t.deepEqual(first, {
    value: { type: 'text-delta', text: 'working' },
    done: false,
  });
  await iterator.return();
  for (let tries = 0; killed === 0 && tries < 100; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.is(killed, 1, 'the raw reader was closed, which kills claude -p');
});

test('a raw reader closed by its producer ends the turn as an abort, not a reply', async t => {
  // The client's interrupt() and terminate() close the reply reader without an
  // in-band terminal. Whatever streamed before that is a truncated reply; it
  // must not finish as a clean `end` a consumer would persist as the answer.
  const { push, reader, close } = makeBufferedReader();
  const hosted = translateClaudeTurn(reader);
  const iterator = iterateReader(hosted);
  push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'half an ans' }] },
  });
  const first = await iterator.next();
  t.deepEqual(first, {
    value: { type: 'text-delta', text: 'half an ans' },
    done: false,
  });
  // The producer closes the raw reader (interrupt/terminate): no terminal.
  close();
  const rest = [];
  for await (const event of iterator) rest.push(event);
  t.deepEqual(rest, [
    { type: 'abort', reason: 'claude turn ended without a terminal event' },
  ]);
});

test('usage counts the cache reads and writes, and reports the last request as context', t => {
  const translator = makeClaudeHostedTranslator();
  const usageEvents = [
    // First request of the turn.
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-main',
          usage: {
            input_tokens: 4,
            cache_read_input_tokens: 30_000,
            cache_creation_input_tokens: 500,
            output_tokens: 1,
          },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: 120 } },
    },
    // The complete message repeats what message_start already reported.
    {
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-main',
        content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} }],
        usage: {
          input_tokens: 4,
          cache_read_input_tokens: 30_000,
          output_tokens: 1,
        },
      },
    },
    // A subagent's request is another window and is ignored.
    {
      type: 'assistant',
      parent_tool_use_id: 'toolu_9',
      message: {
        id: 'msg_sub',
        content: [{ type: 'text', text: 'sub' }],
        usage: { input_tokens: 999_999, output_tokens: 1 },
      },
    },
    // Second request.
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_2',
          model: 'claude-main',
          usage: {
            input_tokens: 6,
            cache_read_input_tokens: 30_500,
            cache_creation_input_tokens: 200,
            output_tokens: 1,
          },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: 40 } },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 60_500,
        cache_creation_input_tokens: 700,
        output_tokens: 160,
      },
      modelUsage: {
        'claude-small': { inputTokens: 900_000, contextWindow: 100_000 },
        'claude-main': { inputTokens: 10, contextWindow: 200_000 },
      },
    },
  ]
    .flatMap(event => translator.handle(event))
    .filter(event => event.type === 'usage');
  t.deepEqual(usageEvents, [
    { type: 'usage', context: { usedTokens: 30_624, windowTokens: 0 } },
    { type: 'usage', context: { usedTokens: 30_746, windowTokens: 0 } },
    {
      type: 'usage',
      inputTokens: 10,
      outputTokens: 160,
      cachedInputTokens: 60_500,
      cacheWriteInputTokens: 700,
      reasoningOutputTokens: 0,
      context: { usedTokens: 30_746, windowTokens: 200_000 },
    },
  ]);
});

test('without partial messages the assistant event is the per-request usage', t => {
  const translator = makeClaudeHostedTranslator();
  const usageEvents = [
    {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 95,
          output_tokens: 10,
        },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'hi',
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 95,
        output_tokens: 10,
      },
      // One unnamed entry: it is the window.
      modelUsage: { 'claude-x': { contextWindow: 1000 } },
    },
  ]
    .flatMap(event => translator.handle(event))
    .filter(event => event.type === 'usage');
  t.deepEqual(usageEvents.at(0), {
    type: 'usage',
    context: { usedTokens: 110, windowTokens: 0 },
  });
  t.deepEqual(usageEvents.at(-1)?.context, {
    usedTokens: 110,
    windowTokens: 1000,
  });
});

test('a failed turn reports the window without erasing what was read', t => {
  const translator = makeClaudeHostedTranslator();
  const usageEvents = [
    // The CLI's own placeholder around an API error: not a request.
    {
      type: 'assistant',
      message: {
        id: 'msg_synthetic',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: { 'claude-main': { contextWindow: 200_000 } },
    },
  ]
    .flatMap(event => translator.handle(event))
    .filter(event => event.type === 'usage');
  // No request was read, so no occupancy is claimed: a consumer that merges
  // this over an earlier reading keeps that reading's occupancy.
  t.deepEqual(usageEvents, [
    {
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      context: { usedTokens: 0, windowTokens: 200_000 },
    },
  ]);
});

test('the window is the main model’s, through a variant suffix and past side models', t => {
  const windowAfter = (model, modelUsage) => {
    const translator = makeClaudeHostedTranslator();
    return [
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          model,
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'hi',
        usage: { input_tokens: 10, output_tokens: 1 },
        modelUsage,
      },
    ]
      .flatMap(event => translator.handle(event))
      .filter(event => event.type === 'usage')
      .at(-1)?.context?.windowTokens;
  };
  // A side model that read far more input does not decide the window.
  t.is(
    windowAfter('claude-x', {
      'claude-x[1m]': { contextWindow: 1_000_000, inputTokens: 10 },
      'claude-small': { contextWindow: 200_000, inputTokens: 5000 },
    }),
    1_000_000,
  );
  // An unnamed model falls back to the largest window listed.
  t.is(
    windowAfter(undefined, {
      'claude-small': { contextWindow: 200_000, inputTokens: 5000 },
      'claude-big': { contextWindow: 500_000, inputTokens: 1 },
    }),
    500_000,
  );
  t.is(windowAfter('claude-x', undefined), 0);
});

test('a message is read once, however many content blocks repeat it', t => {
  const translator = makeClaudeHostedTranslator();
  const message = {
    id: 'msg_1',
    model: 'claude-main',
    usage: { input_tokens: 5, cache_read_input_tokens: 95, output_tokens: 10 },
  };
  const usageEvents = [
    {
      type: 'assistant',
      message: { ...message, content: [{ type: 'text', text: 'a' }] },
    },
    {
      type: 'assistant',
      message: {
        ...message,
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
      },
    },
  ]
    .flatMap(event => translator.handle(event))
    .filter(event => event.type === 'usage');
  t.is(usageEvents.length, 1);
});

test('a request that does not say its usage is not completed with the last one’s', t => {
  const translator = makeClaudeHostedTranslator();
  const usageEvents = [
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-main',
          usage: { input_tokens: 1000, output_tokens: 1 },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: 50 } },
    },
    // The next request starts without usage; its delta must not be spliced
    // onto the first request's input.
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_2' } },
    },
    {
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: 7 } },
    },
  ]
    .flatMap(event => translator.handle(event))
    .filter(event => event.type === 'usage');
  t.deepEqual(usageEvents, [
    { type: 'usage', context: { usedTokens: 1050, windowTokens: 0 } },
  ]);
});
