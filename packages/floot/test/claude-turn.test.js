// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { setTimeout as delay } from 'node:timers/promises';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

import {
  makeClaudeEventTranslator,
  runClaudeTurn,
  claudeTurnPartialOf,
} from '../src/claude-turn.js';

// A writer that records every ReplyEvent call, in order.
const makeRecordingWriter = () => {
  /** @type {Array<{ kind: string, payload?: unknown }>} */
  const log = [];
  const writer = harden({
    setPhase: phase => log.push({ kind: 'phase', payload: phase }),
    delta: text => log.push({ kind: 'delta', payload: text }),
    final: text => log.push({ kind: 'final', payload: text }),
    toolCall: call => log.push({ kind: 'tool_call', payload: call }),
    toolResult: result => log.push({ kind: 'tool_result', payload: result }),
    usage: totals => log.push({ kind: 'usage', payload: totals }),
    end: () => log.push({ kind: 'end' }),
    abort: reason => log.push({ kind: 'abort', payload: reason }),
  });
  return { writer, log };
};

// A fake ClaudeClient whose send() returns a buffered reader the test feeds.
const makeFakeClient = () => {
  const { push, reader, close, setOnClose } = makeBufferedReader();
  let killed = 0;
  setOnClose(() => {
    killed += 1;
  });
  /** @type {string[]} */
  const prompts = [];
  /** @type {object[]} */
  const options = [];
  const client = harden({
    async interrupt() {
      close();
    },
    async send(prompt, opts) {
      prompts.push(prompt);
      options.push(opts);
      return reader;
    },
  });
  return { client, push, close, prompts, options, killed: () => killed };
};

test('translator maps stream-json events onto the reply wire', async t => {
  const { writer, log } = makeRecordingWriter();
  const translator = makeClaudeEventTranslator(writer);

  translator.handle({ type: 'system', subtype: 'init' });
  translator.handle({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Let me check. ' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } },
      ],
    },
  });
  translator.handle({
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
  });
  translator.handle({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Done.' }] },
  });
  translator.handle({
    type: 'result',
    subtype: 'success',
    result: 'Checked the file: done.',
    num_turns: 2,
    usage: { input_tokens: 11, output_tokens: 7 },
  });

  t.deepEqual(log, [
    { kind: 'phase', payload: 'claude session starting' },
    { kind: 'delta', payload: 'Let me check. ' },
    {
      kind: 'tool_call',
      payload: { id: 'toolu_1', name: 'Read', args: '{"path":"a"}' },
    },
    {
      kind: 'tool_result',
      payload: { id: 'toolu_1', name: 'Read', result: 'file contents' },
    },
    { kind: 'delta', payload: 'Done.' },
  ]);
  t.deepEqual(translator.finish(), {
    finalText: 'Checked the file: done.',
    usage: { inputTokens: 11, outputTokens: 7 },
    errorReason: undefined,
  });
});

test('translator emits partial text without duplicating assistant text', async t => {
  const { writer, log } = makeRecordingWriter();
  const translator = makeClaudeEventTranslator(writer);

  translator.handle({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello ' },
    },
  });
  translator.handle({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'world.' },
    },
  });
  translator.handle({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello world.' }] },
  });

  t.deepEqual(log, [
    { kind: 'delta', payload: 'Hello ' },
    { kind: 'delta', payload: 'world.' },
  ]);
  t.is(translator.finish().finalText, 'Hello world.');
});

test('translator keeps each character once across the CLI record interleaving', async t => {
  const { writer, log } = makeRecordingWriter();
  const translator = makeClaudeEventTranslator(writer);
  const start = id =>
    translator.handle({
      type: 'stream_event',
      event: { type: 'message_start', message: { id } },
    });
  const delta = text =>
    translator.handle({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    });
  const assistant = (id, content) =>
    translator.handle({ type: 'assistant', message: { id, content } });

  // The wire as `claude -p --include-partial-messages` emits it: one
  // assistant record per content block, a thinking record before the text
  // starts, the text record after its deltas, then the tool use.
  start('msg_1');
  assistant('msg_1', [{ type: 'thinking', thinking: '…' }]);
  delta('Let me ');
  delta('check. ');
  // A thinking-only record between a message's deltas and its text record
  // must not un-remember that the text already streamed.
  assistant('msg_1', [{ type: 'thinking', thinking: '…' }]);
  assistant('msg_1', [{ type: 'text', text: 'Let me check. ' }]);
  assistant('msg_1', [
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } },
  ]);
  translator.handle({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }],
    },
  });
  // A second message with no partials at all (an older CLI, or a message
  // that arrived whole) is still spoken.
  start('msg_2');
  assistant('msg_2', [{ type: 'text', text: 'Done.' }]);

  t.deepEqual(
    log.filter(entry => entry.kind === 'delta').map(entry => entry.payload),
    ['Let me ', 'check. ', 'Done.'],
  );
  t.is(translator.finish().finalText, 'Let me check. Done.');
});

test('translator falls back to streamed text without a result summary', async t => {
  const { writer } = makeRecordingWriter();
  const translator = makeClaudeEventTranslator(writer);
  translator.handle({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello ' }] },
  });
  translator.handle({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'world' }] },
  });
  t.deepEqual(translator.finish(), {
    finalText: 'Hello world',
    usage: undefined,
    errorReason: undefined,
  });
});

test('runClaudeTurn streams a full turn end to end', async t => {
  const { writer, log } = makeRecordingWriter();
  const { client, push, prompts } = makeFakeClient();

  const turn = runClaudeTurn({ client, text: 'do the thing', writer });
  push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'On it.' }] },
  });
  push({
    type: 'result',
    subtype: 'success',
    result: 'The thing is done.',
    usage: { input_tokens: 3, output_tokens: 2 },
  });
  push({ type: 'end' });

  const { finalContent, usage } = await turn;
  t.deepEqual(prompts, ['do the thing']);
  t.is(finalContent, 'The thing is done.');
  t.deepEqual(usage, { inputTokens: 3, outputTokens: 2 });
  t.deepEqual(log, [{ kind: 'delta', payload: 'On it.' }]);
});

test('an in-band abort event rejects the turn', async t => {
  const { writer } = makeRecordingWriter();
  const { client, push } = makeFakeClient();
  const turn = runClaudeTurn({ client, text: 'hi', writer });
  push({ type: 'abort', reason: 'claude exploded' });
  await t.throwsAsync(() => turn, { message: /claude exploded/ });
});

test('a failed result raises instead of completing as success', async t => {
  const { writer } = makeRecordingWriter();
  const { client, push } = makeFakeClient();
  const turn = runClaudeTurn({ client, text: 'hi', writer });
  // error_max_turns carries no `result` text — the failure is signalled only
  // by is_error, which must not read as a successful (empty) answer.
  push({ type: 'result', subtype: 'error_max_turns', is_error: true });
  push({ type: 'end' });
  await t.throwsAsync(() => turn, { message: /error_max_turns/ });
});

test('a failed result with text reports that text as the reason', async t => {
  const { writer } = makeRecordingWriter();
  const { client, push } = makeFakeClient();
  const turn = runClaudeTurn({ client, text: 'hi', writer });
  push({
    type: 'result',
    subtype: 'error_during_execution',
    result: 'credential expired',
    is_error: true,
  });
  push({ type: 'end' });
  await t.throwsAsync(() => turn, { message: /credential expired/ });
});

test('the model option reaches the client', async t => {
  const { writer } = makeRecordingWriter();
  const { client, push, options } = makeFakeClient();
  const turn = runClaudeTurn({
    client,
    text: 'hi',
    writer,
    model: 'claude-opus-4-8',
  });
  push({ type: 'end' });
  await turn;
  t.deepEqual(options, [{ model: 'claude-opus-4-8' }]);
});

test('aborting the signal closes the reader and kills the turn', async t => {
  const { writer } = makeRecordingWriter();
  const { client, push, killed } = makeFakeClient();
  const controller = new AbortController();

  const turn = runClaudeTurn({
    client,
    text: 'hi',
    writer,
    signal: controller.signal,
  });
  push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'partial' }] },
  });
  // Let the turn consume the delta, then stop pulling — the producer is idle,
  // which is exactly the case the live close watcher exists for.
  await delay(10);
  controller.abort();

  const { finalContent } = await turn;
  t.is(finalContent, 'partial');
  t.is(killed(), 1);
});

test('native tool observation is durable before display and carries paired results', async t => {
  t.timeout(5000);
  const { writer, log } = makeRecordingWriter();
  const { client, push } = makeFakeClient();
  const records = [];
  let release = () => {};
  let observed = () => {};
  const gate = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const started = new Promise(resolve => {
    observed = () => resolve(undefined);
  });
  t.teardown(release);
  const turn = runClaudeTurn({
    client,
    text: 'read',
    writer,
    recordToolEvent: async event => {
      records.push(event);
      observed();
      await gate;
    },
  });
  push({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'native-1',
          name: 'Read',
          input: { file: 'a' },
        },
      ],
    },
  });
  await started;
  t.deepEqual(log, []);
  release();
  push({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'native-1', content: 'contents' },
      ],
    },
  });
  push({ type: 'end' });
  const result = await turn;
  t.deepEqual(records, [
    {
      type: 'observed-tool-call',
      callId: 'native-1',
      name: 'Read',
      args: '{"file":"a"}',
    },
    { type: 'observed-tool-result', callId: 'native-1', result: 'contents' },
  ]);
  t.deepEqual(result.toolCalls, [
    { id: 'native-1', name: 'Read', args: '{"file":"a"}', result: 'contents' },
  ]);
  t.deepEqual(
    log.map(entry => entry.kind),
    ['tool_call', 'tool_result'],
  );
});

test('failed native tool recording stops the reader before displaying the event', async t => {
  t.timeout(5000);
  const { writer, log } = makeRecordingWriter();
  const { client, push, killed } = makeFakeClient();
  const turn = runClaudeTurn({
    client,
    text: 'read',
    writer,
    recordToolEvent: async () => {
      throw Error('journal failed');
    },
  });
  push({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'native-1', name: 'Read', input: {} }],
    },
  });
  const error = await t.throwsAsync(turn, { message: /journal failed/ });
  t.is(killed(), 1);
  t.deepEqual(log, []);
  t.is(claudeTurnPartialOf(error).toolCalls[0].result, null);
});

test('a terminal with unsettled native tools cannot report success and retains partial usage', async t => {
  const { writer } = makeRecordingWriter();
  const { client, push } = makeFakeClient();
  const turn = runClaudeTurn({ client, text: 'read', writer });
  push({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'native-1', name: 'Read', input: {} },
      ],
    },
  });
  push({
    type: 'result',
    result: 'reported done',
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  push({ type: 'end' });
  const error = await t.throwsAsync(turn, {
    message: /unsettled native tool calls/,
  });
  t.like(claudeTurnPartialOf(error), {
    delivered: true,
    finalContent: 'reported done',
    usage: { inputTokens: 3, outputTokens: 4 },
  });
  t.is(claudeTurnPartialOf(error).toolCalls[0].result, null);
});

test('an uncorrelated native result is rejected instead of claiming success', async t => {
  const { writer } = makeRecordingWriter();
  const { client, push } = makeFakeClient();
  const turn = runClaudeTurn({ client, text: 'read', writer });
  push({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'missing', content: 'done' },
      ],
    },
  });
  await t.throwsAsync(turn, { message: /unknown or settled identity/ });
});

test('clean EOF after text is unknown rather than success', async t => {
  t.timeout(5000);
  const { writer, log } = makeRecordingWriter();
  const { client, push, close } = makeFakeClient();
  const turn = runClaudeTurn({ client, text: 'read', writer });
  push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'partial' }] },
  });
  while (!log.length) {
    // eslint-disable-next-line no-await-in-loop
    await delay(1);
  }
  close();
  const error = await t.throwsAsync(turn, {
    message: /without a terminal event/,
  });
  t.like(claudeTurnPartialOf(error), {
    finalContent: 'partial',
    outcomeUnknown: true,
  });
});

test('failed cancellation is surfaced and retains uncertain partial outcome', async t => {
  t.timeout(5000);
  const { writer, log } = makeRecordingWriter();
  const { client, push } = makeFakeClient();
  const controller = new AbortController();
  const broken = harden({
    send: client.send,
    async interrupt() {
      throw Error('unreachable producer');
    },
  });
  const turn = runClaudeTurn({
    client: broken,
    text: 'read',
    writer,
    signal: controller.signal,
  });
  push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'partial' }] },
  });
  while (!log.length) {
    // eslint-disable-next-line no-await-in-loop
    await delay(1);
  }
  const rejected = t.throwsAsync(turn, {
    message: /Hosted turn cancellation failed:/,
  });
  controller.abort();
  const error = await rejected;
  t.is(claudeTurnPartialOf(error).outcomeUnknown, true);
});

test('a rejected send is stopped and recorded as uncertain dispatch', async t => {
  const { writer } = makeRecordingWriter();
  let stops = 0;
  const client = harden({
    async send() {
      throw Error('lost send response');
    },
    async interrupt() {
      stops += 1;
    },
  });
  const error = await t.throwsAsync(
    runClaudeTurn({ client, text: 'do work', writer }),
    { message: /lost send response/ },
  );
  t.is(stops, 1);
  t.like(claudeTurnPartialOf(error), {
    delivered: false,
    outcomeUnknown: true,
  });
});

test('canceling a pending send interrupts promptly and closes its late reader', async t => {
  t.timeout(5000);
  const { writer } = makeRecordingWriter();
  const { reader, setOnClose } = makeBufferedReader();
  let closed = 0;
  setOnClose(() => {
    closed += 1;
  });
  let release = () => {};
  let started = () => {};
  const pending = new Promise(resolve => {
    release = () => resolve(reader);
  });
  const sending = new Promise(resolve => {
    started = () => resolve(undefined);
  });
  t.teardown(release);
  let stops = 0;
  const client = harden({
    async send() {
      started();
      return pending;
    },
    async interrupt() {
      stops += 1;
    },
  });
  const controller = new AbortController();
  const turn = runClaudeTurn({
    client,
    text: 'do work',
    writer,
    signal: controller.signal,
  });
  await sending;
  controller.abort();
  const result = await turn;
  t.is(stops, 1);
  t.true(result.outcomeUnknown);
  t.is(closed, 0);
  release();
  while (!closed) {
    // eslint-disable-next-line no-await-in-loop
    await delay(1);
  }
  t.is(closed, 1);
});
