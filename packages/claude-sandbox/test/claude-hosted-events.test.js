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
    { type: 'usage', inputTokens: 11, outputTokens: 7 },
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
    { type: 'usage', inputTokens: 3, outputTokens: 2 },
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
    { type: 'usage', inputTokens: 3, outputTokens: 2 },
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
