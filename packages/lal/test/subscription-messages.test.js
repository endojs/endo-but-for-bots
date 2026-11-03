// @ts-check
/* eslint-disable no-await-in-loop */
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/marshal';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makePromiseKit } from '@endo/promise-kit';
import {
  makeSubscriptionMessagesProvider,
  claudeMessagesEfforts,
  getEmptyMessagesOutput,
} from '../providers/subscription-messages.js';

const model = 'claude-sonnet-4-6';
const text = { type: 'text', text: 'Hello 😀' };
const thinking = {
  type: 'thinking',
  thinking: 'private',
  signature: 'opaque-signature',
};
const call = {
  type: 'tool_use',
  id: 'call_1',
  name: 'lookup',
  input: { name: 'shell' },
};
const eventsFor = blocks => [
  {
    type: 'message_start',
    message: {
      type: 'message',
      role: 'assistant',
      content: [],
      usage: { input_tokens: 3, cache_read_input_tokens: 2 },
    },
  },
  ...blocks.flatMap((block, index) => [
    {
      type: 'content_block_start',
      index,
      content_block:
        block.type === 'text'
          ? { type: 'text', text: '' }
          : block.type === 'tool_use'
            ? { ...block, input: {} }
            : { ...block, thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index,
      delta:
        block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : block.type === 'tool_use'
            ? {
                type: 'input_json_delta',
                partial_json: JSON.stringify(block.input),
              }
            : { type: 'thinking_delta', thinking: block.thinking },
    },
    ...(block.type === 'thinking'
      ? [
          {
            type: 'content_block_delta',
            index,
            delta: { type: 'signature_delta', signature: block.signature },
          },
        ]
      : []),
    { type: 'content_block_stop', index },
  ]),
  {
    type: 'message_delta',
    delta: {
      stop_reason: blocks.some(b => b.type === 'tool_use')
        ? 'tool_use'
        : 'end_turn',
    },
    usage: { output_tokens: 7 },
  },
  { type: 'message_stop' },
];
const fixture = (events = eventsFor([text]), options = {}) => {
  const requests = [];
  let revoked = 0;
  const endpoint = Far('Endpoint', {
    revoke: async () => {
      revoked += 1;
      await options.revoke?.();
    },
    requestByteStream: request => {
      requests.push(request);
      const bytes = new TextEncoder().encode(
        events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''),
      );
      return harden({
        status: options.status ?? 200,
        contentType: 'text/event-stream',
        reader:
          options.reader ??
          bytesReaderFromIterator(
            (function* chunks() {
              for (let i = 0; i < bytes.length; i += 3)
                yield bytes.slice(i, i + 3);
            })(),
          ),
      });
    },
  });
  const subscription = Far('Subscription', {
    describe: () => harden({ models: options.models ?? [model] }),
    openEndpoint: async spec => {
      await options.gate;
      options.opened?.(spec);
      return endpoint;
    },
  });
  const provider = makeSubscriptionMessagesProvider({
    subscription,
    sessionId: 'test',
    model,
    reasoningEffort: 'medium',
  });
  return { provider, requests, revocations: () => revoked };
};
const history = [
  { role: 'system', content: 'You are Fae.' },
  { role: 'user', content: 'Hello' },
];
test('direct Claude streams UTF-8, retains native content and accounts for usage without credentials', async t => {
  const f = fixture();
  t.teardown(() => f.provider.dispose());
  const deltas = [];
  const result = await f.provider.chatStream(history, [], token =>
    deltas.push(token),
  );
  t.is(result.message.content, text.text);
  t.deepEqual(deltas, [text.text]);
  t.like(result.usage, {
    inputTokens: 3,
    cachedInputTokens: 2,
    outputTokens: 7,
  });
  const req = f.requests[0];
  t.is(req.path, '/v1/messages');
  t.false(Object.hasOwn(req.headers, 'authorization'));
  t.false(Object.hasOwn(req.headers, 'x-api-key'));
  const body = JSON.parse(req.body);
  t.deepEqual(body.output_config, { effort: 'medium' });
  t.true(body.system[0].text.includes('cc_entrypoint=fae'));
  t.is(body.system[1].text, 'You are Fae.');
  t.is(f.revocations(), 1);
});
test('signed thinking and parallel tool outcomes replay exactly on the next round', async t => {
  const f = fixture(eventsFor([thinking, call, { ...call, id: 'call_2' }]));
  t.teardown(() => f.provider.dispose());
  const first = await f.provider.chat(history, []);
  await f.provider.chat(
    [
      ...history,
      first.message,
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'tool', tool_call_id: 'call_2', content: 'failed', failed: true },
    ],
    [],
  );
  const body = JSON.parse(f.requests[1].body);
  t.deepEqual(body.messages[1].content, [
    thinking,
    call,
    { ...call, id: 'call_2' },
  ]);
  t.is(body.messages[2].content.length, 2);
  t.true(body.messages[2].content[1].is_error);
});
for (const [
  name,
  mutate,
] of /** @type {[string, (events: any[]) => any[]][]} */ ([
  ['truncated', e => e.slice(0, -1)],
  ['unfinished block', e => e.filter(x => x.type !== 'content_block_stop')],
  ['duplicate start', e => [e[0], ...e]],
  [
    'mismatched index',
    e =>
      e.map(x => (x.type === 'content_block_delta' ? { ...x, index: 1 } : x)),
  ],
  [
    'token limit',
    e =>
      e.map(x =>
        x.type === 'message_delta'
          ? { ...x, delta: { stop_reason: 'max_tokens' } }
          : x,
      ),
  ],
  [
    'provider error',
    e => [
      ...e.slice(0, -1),
      { type: 'error', error: { message: 'secret-echo' } },
    ],
  ],
  ['after completion', e => [...e, { type: 'ping' }]],
]))
  test(`rejects ${name} without returning executable tools`, async t => {
    const f = fixture(mutate(eventsFor([call])));
    t.teardown(() => f.provider.dispose());
    const err = await t.throwsAsync(f.provider.chat(history, []));
    t.false(err.message.includes('secret-echo'));
    t.is(f.revocations(), 1);
  });
test('rejects unsigned thinking and duplicate tool identities', async t => {
  for (const blocks of [
    [{ ...thinking, signature: '' }, call],
    [call, call],
  ]) {
    const f = fixture(eventsFor(blocks));
    t.teardown(() => f.provider.dispose());
    await t.throwsAsync(f.provider.chat(history, []));
  }
});
test('cancellation returns promptly and disposal waits for late endpoint revocation', async t => {
  t.timeout(2000);
  const gate = makePromiseKit();
  let opened = false;
  const f = fixture(undefined, {
    gate: gate.promise,
    opened: () => {
      opened = true;
    },
  });
  const abort = new AbortController();
  const pending = f.provider.chat(history, [], abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort(Error('cancelled'));
  await t.throwsAsync(pending, { message: 'cancelled' });
  t.false(opened);
  gate.resolve(undefined);
  await f.provider.dispose();
  t.is(f.revocations(), 1);
});
test('model admission and effort are fail closed', async t => {
  const f = fixture(undefined, { models: [] });
  t.teardown(() => f.provider.dispose());
  await t.throwsAsync(f.provider.chat(history, []), { message: /catalog/ });
  t.is(f.requests.length, 0);
  t.deepEqual(claudeMessagesEfforts('claude-sonnet-4-6'), [
    'low',
    'medium',
    'high',
    'max',
  ]);
  t.deepEqual(claudeMessagesEfforts('claude-opus-5-5'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  t.deepEqual(claudeMessagesEfforts('unknown'), []);
});

test('abort during revocation rejects promptly while disposal retains the cleanup', async t => {
  t.timeout(2000);
  const gate = makePromiseKit();
  const revoking = makePromiseKit();
  const f = fixture(undefined, {
    revoke: () => {
      revoking.resolve(undefined);
      return gate.promise;
    },
  });
  const abort = new AbortController();
  const result = f.provider.chat(history, [], abort.signal);
  await revoking.promise;
  abort.abort(Error('cancelled during cleanup'));
  await t.throwsAsync(result, { message: 'cancelled during cleanup' });
  gate.resolve(undefined);
  await f.provider.dispose();
  t.is(f.revocations(), 1);
});

test('failed revocation fences further inference and disposal retries it', async t => {
  let fail = true;
  const f = fixture(undefined, {
    revoke: () => {
      if (fail) throw Error('revoke failed');
    },
  });
  await t.throwsAsync(f.provider.chat(history, []), {
    message: 'revoke failed',
  });
  await t.throwsAsync(f.provider.chat(history, []), {
    message: /cleanup pending/,
  });
  fail = false;
  await f.provider.dispose();
  t.is(f.revocations(), 2);
});

test('only validated empty completions carry terminal evidence for explicit mailbox replies', async t => {
  const f = fixture(eventsFor([thinking]));
  t.teardown(() => f.provider.dispose());
  const error = await t.throwsAsync(f.provider.chat(history, []));
  t.deepEqual(getEmptyMessagesOutput(error).message.messagesOutput.content, [
    thinking,
  ]);
  t.is(
    getEmptyMessagesOutput(Error('Empty Messages assistant output')),
    undefined,
  );
  const truncated = fixture(eventsFor([thinking]).slice(0, -1));
  t.teardown(() => truncated.provider.dispose());
  t.is(
    getEmptyMessagesOutput(
      await t.throwsAsync(truncated.provider.chat(history, [])),
    ),
    undefined,
  );
});

test('image tool outcomes become native Messages image blocks', async t => {
  const { encodeImageResult } =
    await import('@endo/hosted-agent/image-result.js');
  const f = fixture(eventsFor([call]));
  t.teardown(() => f.provider.dispose());
  const first = await f.provider.chat(history, []);
  await f.provider.chat(
    [
      ...history,
      first.message,
      {
        role: 'tool',
        tool_call_id: call.id,
        content: encodeImageResult({
          mimeType: 'image/png',
          data: 'iVBORw0KGgo=',
        }),
      },
    ],
    [],
  );
  const result = JSON.parse(f.requests[1].body).messages.at(-1).content[0];
  t.is(result.type, 'tool_result');
  t.deepEqual(result.content, [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    },
  ]);
});
