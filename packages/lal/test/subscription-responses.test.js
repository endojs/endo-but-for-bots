// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { Far } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSubscriptionResponsesProvider } from '../providers/subscription-responses.js';
import { abortableDelay } from '../providers/delay.js';
// Exercise the real internal broker without exporting its constructor as API.
// eslint-disable-next-line import/no-relative-packages
import { makeBrokerSubscription } from '../../hosted-agent/src/broker-subscription.js';

const MODEL = 'test-luna';
const textItem = text => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});
const callItem = {
  type: 'function_call',
  call_id: 'call1',
  name: 'lookup',
  arguments: '{"name":"shell"}',
  status: 'completed',
};
/** @param {any[]} [output] */
const completion = (output = [textItem('Done')]) => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    output,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 60 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 10 },
    },
  },
});

/**
 * @param {any[]} events
 * @param {any} [options]
 */
const fixture = (events, options = {}) => {
  const requests = [];
  let opened = 0;
  let revoked = 0;
  let postRevocationRequests = 0;
  const encoded = events
    .map(event => `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join('');
  const bytes =
    options.bytes ?? new TextEncoder().encode(options.text ?? encoded);
  const endpoint = Far('TestEndpoint', {
    requestByteStream: message => {
      if (revoked > 0) postRevocationRequests += 1;
      requests.push(message);
      return harden({
        status: options.status ?? 200,
        contentType: 'text/event-stream',
        reader:
          options.reader ??
          bytesReaderFromIterator(
            (function* chunkIterator() {
              for (let at = 0; at < Number(bytes.length); at += 7)
                yield bytes.slice(at, at + 7);
            })(),
          ),
      });
    },
    revoke: async () => {
      revoked += 1;
      if (options.revoke) await options.revoke();
    },
  });
  const subscription = Far('TestSubscription', {
    describe: async () =>
      options.describe
        ? options.describe()
        : harden({
            models: [MODEL],
          }),
    openEndpoint: async spec => {
      opened += 1;
      if (options.openEndpoint) return options.openEndpoint(spec, endpoint);
      return endpoint;
    },
  });
  const provider = makeSubscriptionResponsesProvider({
    subscription,
    model: MODEL,
    sessionId: 'session1',
    reasoningEffort: 'high',
    contextLength: 1000,
  });
  return {
    provider,
    subscription,
    endpoint,
    requests,
    revocations: () => revoked,
    postRevocationRequests: () => postRevocationRequests,
    openings: () => opened,
  };
};

test('subscription Responses streams text and reports disjoint usage without a credential', async t => {
  const subject = fixture([
    { type: 'response.output_text.delta', delta: 'Done 😀' },
    completion([textItem('Done 😀')]),
  ]);
  t.teardown(() => subject.provider.dispose());
  const deltas = [];
  const usages = [];
  const result = await subject.provider.chatStream(
    [
      { role: 'system', content: 'Instructions' },
      { role: 'user', content: 'Hello' },
    ],
    [],
    text => deltas.push(text),
    undefined,
    usage => usages.push(usage),
  );
  t.is(result.message.content, 'Done 😀');
  t.deepEqual(deltas, ['Done 😀']);
  t.deepEqual(result.usage, {
    inputTokens: 40,
    cachedInputTokens: 60,
    outputTokens: 20,
    reasoningOutputTokens: 10,
    cacheWriteInputTokens: 0,
    context: { usedTokens: 130, windowTokens: 1000 },
  });
  t.deepEqual(usages, [result.usage]);
  const request = subject.requests[0];
  t.deepEqual(Object.keys(request).sort(), ['body', 'method', 'path']);
  const body = JSON.parse(request.body);
  t.false(body.store);
  t.true(body.stream);
  t.deepEqual(body.include, ['reasoning.encrypted_content']);
  t.is(body.instructions, 'Instructions');
  t.deepEqual(body.reasoning, { effort: 'high' });
  t.is(subject.revocations(), 1);
});

test('subscription Responses preserves opaque reasoning and call identities across tool rounds', async t => {
  const opaque = {
    type: 'reasoning',
    id: 'reason1',
    encrypted_content: 'opaque',
    summary: [],
  };
  const subject = fixture([completion([opaque, callItem])]);
  t.teardown(() => subject.provider.dispose());
  const first = await subject.provider.chat(
    [{ role: 'user', content: 'Use shell' }],
    [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'lookup',
          parameters: { type: 'object' },
        },
      },
    ],
  );
  t.deepEqual(first.message.tool_calls, [
    {
      id: 'call1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"name":"shell"}' },
    },
  ]);
  await subject.provider.chat(
    [first.message, { role: 'tool', tool_call_id: 'call1', content: 'found' }],
    [],
  );
  t.deepEqual(JSON.parse(subject.requests[1].body).input, [
    opaque,
    callItem,
    { type: 'function_call_output', call_id: 'call1', output: 'found' },
  ]);
  t.is(subject.revocations(), 2);
});

test('subscription item completion retains native context when terminal output is empty', async t => {
  const opaque = {
    type: 'reasoning',
    id: 'reason1',
    encrypted_content: 'opaque',
    summary: [],
  };
  // Item completions can interleave; output_index defines the retained order.
  const subject = fixture([
    { type: 'response.output_item.added', output_index: 0, item: opaque },
    { type: 'response.output_item.added', output_index: 1, item: callItem },
    { type: 'response.output_item.done', output_index: 1, item: callItem },
    { type: 'response.output_item.done', output_index: 0, item: opaque },
    completion([]),
  ]);
  t.teardown(() => subject.provider.dispose());
  const first = await subject.provider.chat(
    [{ role: 'user', content: 'Use shell' }],
    [],
  );
  t.is(first.message.tool_calls?.[0].id, 'call1');
  t.deepEqual(first.message.responsesOutput.items, [opaque, callItem]);
  await subject.provider.chat(
    [first.message, { role: 'tool', tool_call_id: 'call1', content: 'found' }],
    [],
  );
  t.deepEqual(JSON.parse(subject.requests[1].body).input, [
    opaque,
    callItem,
    { type: 'function_call_output', call_id: 'call1', output: 'found' },
  ]);
});

/** @type {Array<[string, any, string]>} */
const diagnosticCases = [
  [
    'top-level error',
    {
      type: 'error',
      code: 'invalid_encrypted_content',
      param: 'input[12].encrypted_content',
      message: 'Private echoed prompt and encrypted context',
    },
    'Subscription inference ended unsuccessfully (error; code=invalid_encrypted_content, param=input[12].encrypted_content) Retained reasoning could not be validated.',
  ],
  [
    'nested error',
    {
      type: 'error',
      error: { code: 429, type: 'rate_limit_error', message: 'Private body' },
    },
    'Subscription inference ended unsuccessfully (error; code=429, type=rate_limit_error)',
  ],
  [
    'failed response',
    {
      type: 'response.failed',
      response: {
        error: { code: 'server_error', message: 'Private provider response' },
      },
    },
    'Subscription inference ended unsuccessfully (response.failed; code=server_error) Provider reported a server error.',
  ],
  [
    'incomplete response',
    {
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    },
    'Subscription inference ended unsuccessfully (response.incomplete; reason=max_output_tokens) Output token limit reached.',
  ],
];
for (const [label, event, expected] of diagnosticCases) {
  test(`subscription Responses retains safe ${label} diagnostics`, async t => {
    const subject = fixture([event]);
    t.teardown(() => subject.provider.dispose());
    await t.throwsAsync(
      subject.provider.chat([{ role: 'user', content: 'Hello' }], []),
      { message: expected },
    );
    t.is(subject.requests.length, 1);
    t.is(subject.revocations(), 1);
  });
}

for (const bad of [
  'sk_test_secret',
  'bearer_secret',
  'eyJhbGciOiJIUzI1NiJ9',
  'a'.repeat(1024),
  'error\nforged log',
  '\u001b[31merror',
  { toString: 'Do not coerce' },
  ['server_error'],
  -1,
  100_000,
]) {
  test(`subscription Responses omits unsafe error fields ${JSON.stringify(bad).slice(0, 60)}`, async t => {
    const subject = fixture([
      {
        type: 'response.incomplete',
        response: {
          error: {
            code: bad,
            type: bad,
            param: bad,
            message: 'PRIVATE_PROMPT',
          },
          incomplete_details: { reason: bad },
          id: 'PRIVATE_REQUEST_ID',
        },
      },
    ]);
    t.teardown(() => subject.provider.dispose());
    await t.throwsAsync(
      subject.provider.chat([{ role: 'user', content: 'Hello' }], []),
      {
        message:
          'Subscription inference ended unsuccessfully (response.incomplete)',
      },
    );
    t.is(subject.revocations(), 1);
  });
}

test('subscription Responses does not interpret inherited explanation names', async t => {
  const subject = fixture([{ type: 'error', code: 'constructor' }]);
  t.teardown(() => subject.provider.dispose());
  await t.throwsAsync(
    subject.provider.chat([{ role: 'user', content: 'Hello' }], []),
    {
      message:
        'Subscription inference ended unsuccessfully (error; code=constructor)',
    },
  );
});

/** @type {Array<[string, any[], RegExp]>} */
const refusals = [
  [
    'missing completion',
    [{ type: 'response.output_text.delta', delta: 'partial' }],
    /without completion/,
  ],
  ['failed completion', [{ type: 'response.failed' }], /unsuccessfully/],
  [
    'incomplete completion',
    [{ type: 'response.incomplete' }],
    /unsuccessfully/,
  ],
  ['empty completion', [completion([])], /Empty/],
  [
    'unfinished call',
    [completion([{ ...callItem, status: 'in_progress' }])],
    /Unfinished/,
  ],
  [
    'broken arguments',
    [completion([{ ...callItem, arguments: '{' }])],
    /arguments/,
  ],
  ['duplicate call', [completion([callItem, callItem])], /Duplicate/],
  ['duplicate completion', [completion(), completion()], /completion/],
  [
    'unfinished added item',
    [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: textItem('Done'),
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...callItem, status: 'in_progress', arguments: '' },
      },
      completion([]),
    ],
    /Unfinished/,
  ],
  [
    'changed item identity',
    [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...textItem(''), id: 'first' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { ...textItem('Done'), id: 'second' },
      },
      completion([]),
    ],
    /identity changed/,
  ],
  [
    'duplicate native identity in terminal output',
    [
      completion([
        { ...textItem('Done'), id: 'same' },
        { ...textItem('Done'), id: 'same' },
      ]),
    ],
    /Duplicate/,
  ],
  [
    'duplicate native identity in item completions',
    [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { ...textItem('Done'), id: 'same' },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { ...textItem('Done'), id: 'same' },
      },
      completion([]),
    ],
    /Duplicate/,
  ],
  [
    'duplicate completed item',
    [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: textItem('Done'),
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: textItem('Done'),
      },
      completion([]),
    ],
    /Duplicate/,
  ],
  [
    'missing completed item index',
    [
      { type: 'response.output_item.done', output_index: 1, item: callItem },
      completion([]),
    ],
    /Incomplete/,
  ],
  [
    'terminal item disagreement',
    [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: textItem('Other'),
      },
      completion(),
    ],
    /disagrees/,
  ],
  [
    'invalid completed item index',
    [
      { type: 'response.output_item.done', output_index: -1, item: callItem },
      completion([]),
    ],
    /Invalid/,
  ],
];
for (const [title, events, message] of refusals) {
  test(`subscription Responses refuses ${title} without replay`, async t => {
    const subject = fixture(events);
    t.teardown(() => subject.provider.dispose());
    await t.throwsAsync(() => subject.provider.chat([], []), { message });
    t.is(subject.requests.length, 1);
    t.is(subject.revocations(), 1);
  });
}

test('subscription Responses rejects incompatible history and unsettled tools before inference', async t => {
  const subject = fixture([completion()]);
  t.teardown(() => subject.provider.dispose());
  await t.throwsAsync(
    () =>
      subject.provider.chat(
        [
          {
            role: 'assistant',
            content: 'old',
            responsesOutput: { model: 'another', items: [textItem('old')] },
          },
        ],
        [],
      ),
    { message: /Incompatible/ },
  );
  await t.throwsAsync(
    () =>
      subject.provider.chat(
        [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call1', function: { name: 'lookup', arguments: '{}' } },
            ],
          },
        ],
        [],
      ),
    { message: /unresolved/ },
  );
  t.is(subject.requests.length, 0);
});

test('subscription Responses reports HTTP refusal without consuming or echoing its body', async t => {
  const subject = fixture([], { status: 429 });
  t.teardown(() => subject.provider.dispose());
  await t.throwsAsync(() => subject.provider.chat([], []), {
    message: /HTTP 429/,
  });
  t.is(subject.requests.length, 1);
  t.is(subject.revocations(), 1);
});

test('cancellation during endpoint acquisition retains and revokes a late endpoint', async t => {
  t.timeout(5000);
  const late = makePromiseKit();
  const entered = makePromiseKit();
  const controller = new AbortController();
  const subject = fixture([], {
    openEndpoint: () => {
      entered.resolve(undefined);
      return late.promise;
    },
  });
  t.teardown(() => subject.provider.dispose());
  const call = subject.provider.chat([], [], controller.signal);
  await entered.promise;
  controller.abort(Error('cancelled by test'));
  await t.throwsAsync(call, { message: /cancelled by test/ });
  late.resolve(subject.endpoint);
  await subject.provider.dispose();
  t.is(subject.revocations(), 1);
  t.is(subject.requests.length, 0);
  await t.throwsAsync(() => subject.provider.chat([], []), {
    message: /disposed/,
  });
  // Keep the test stub's endpoint reachable until its cleanup is observed.
  t.deepEqual(await E(subject.subscription).describe(), {
    models: [MODEL],
  });
});

test('disposal cancels a pending catalog lookup without acquiring an endpoint', async t => {
  t.timeout(5000);
  const catalog = makePromiseKit();
  const entered = makePromiseKit();
  const subject = fixture([], {
    describe: () => {
      entered.resolve(undefined);
      return catalog.promise;
    },
  });
  t.teardown(() => {
    catalog.resolve(harden({ models: [] }));
    return subject.provider.dispose();
  });
  const call = subject.provider.chat([], []);
  await entered.promise;
  await subject.provider.dispose();
  await t.throwsAsync(call, { message: /disposed/ });
  t.is(subject.openings(), 0);
});

test('unsupported models and malformed tool schemas acquire no endpoint', async t => {
  const subject = fixture([], { describe: async () => harden({ models: [] }) });
  t.teardown(() => subject.provider.dispose());
  await t.throwsAsync(() => subject.provider.chat([], []), {
    message: /absent.*catalog/,
  });
  t.is(subject.openings(), 0);
  const valid = fixture([]);
  t.teardown(() => valid.provider.dispose());
  await t.throwsAsync(
    () =>
      valid.provider.chat(
        [],
        [{ type: 'function', function: { name: 'lookup' } }],
      ),
    { message: /tool schema/ },
  );
  t.is(valid.openings(), 0);
});

test('valid refusal content is an assistant reply, not an empty success or malformed frame', async t => {
  const subject = fixture([
    completion([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot do that.' }],
      },
    ]),
  ]);
  t.teardown(() => subject.provider.dispose());
  t.is(
    (await subject.provider.chat([], [])).message.content,
    'I cannot do that.',
  );
});

test('SSE framing accepts multiline data and rejects malformed, truncated, and invalid UTF-8 frames', async t => {
  const multiline = fixture([], {
    text: `event: response.completed\ndata: {"type":"response.completed",\ndata: "response":${JSON.stringify(completion().response)}}\n\ndata: [DONE]\n\n`,
  });
  t.teardown(() => multiline.provider.dispose());
  t.is((await multiline.provider.chat([], [])).message.content, 'Done');
  for (const options of [
    { text: 'data: {broken}\n\n' },
    { text: 'data: {"type":"response.completed"}' },
    { bytes: new Uint8Array([0xff]) },
  ]) {
    const subject = fixture([], options);
    t.teardown(() => subject.provider.dispose());
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => subject.provider.chat([], []));
    t.is(subject.requests.length, 1);
    t.is(subject.revocations(), 1);
  }
});

test('SSE CR-only framing dispatches its final CR at EOF', async t => {
  const subject = fixture([], {
    text: `data: ${JSON.stringify(completion())}\r\r`,
  });
  t.teardown(() => subject.provider.dispose());
  t.is((await subject.provider.chat([], [])).message.content, 'Done');
});

test('the real broker Subscription contract supplies model ids, not picker descriptors', async t => {
  const subject = fixture([completion()]);
  const { subscription } = makeBrokerSubscription({
    providerId: 'codex',
    label: 'Test Codex pool',
    readModels: async () => [MODEL],
    openEndpoint: async () => subject.endpoint,
    readings: async () => [],
  });
  const provider = makeSubscriptionResponsesProvider({
    subscription,
    model: MODEL,
    sessionId: 'real-subscription',
  });
  t.teardown(() => provider.dispose());
  t.deepEqual((await E(subscription).describe()).models, [MODEL]);
  const result = await provider.chat([], []);
  t.is(result.message.content, 'Done');
  t.is(
    result.usage?.context.windowTokens,
    0,
    'unknown context window is not invented',
  );
});

test('premature DONE and post-completion events cannot admit tool execution', async t => {
  for (const text of [
    'data: [DONE]\n\n',
    `data: ${JSON.stringify(completion([callItem]))}\n\ndata: ${JSON.stringify({ type: 'response.output_item.added', item: callItem })}\n\n`,
  ]) {
    const subject = fixture([], { text });
    t.teardown(() => subject.provider.dispose());
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => subject.provider.chat([], []), {
      message: /without completion|after completion/,
    });
  }
});

test('cancellation during a stalled byte read settles the caller and revokes its endpoint', async t => {
  t.timeout(5000);
  const pull = makePromiseKit();
  const entered = makePromiseKit();
  const reader = bytesReaderFromIterator({
    next: async () => {
      entered.resolve(undefined);
      return pull.promise;
    },
  });
  const subject = fixture([], {
    reader,
    revoke: () => pull.resolve(harden({ done: true, value: undefined })),
  });
  t.teardown(() => {
    pull.resolve(harden({ done: true, value: undefined }));
    return subject.provider.dispose();
  });
  const controller = new AbortController();
  const call = subject.provider.chat([], [], controller.signal);
  await entered.promise;
  controller.abort(Error('read cancelled'));
  await t.throwsAsync(call, { message: /read cancelled/ });
  await subject.provider.dispose();
  t.is(subject.revocations(), 1);
});

test('reader and usage-observer failures are errors, never inference retries', async t => {
  const subject = fixture([], {
    reader: bytesReaderFromIterator({
      next: async () => {
        throw Error('broken reader');
      },
    }),
  });
  t.teardown(() => subject.provider.dispose());
  await t.throwsAsync(() => subject.provider.chat([], []), {
    message: /broken reader/,
  });
  t.is(subject.requests.length, 1);
  const observer = fixture([completion()]);
  t.teardown(() => observer.provider.dispose());
  await t.throwsAsync(
    () =>
      observer.provider.chatStream([], [], undefined, undefined, () => {
        throw Error('broken observer');
      }),
    { message: /broken observer/ },
  );
  t.is(observer.requests.length, 1);
});

test('a falsy abort reason during a usage callback still fences the response', async t => {
  const subject = fixture([completion()]);
  t.teardown(() => subject.provider.dispose());
  const controller = new AbortController();
  await subject.provider
    .chatStream([], [], undefined, controller.signal, () => controller.abort(0))
    .then(
      () => t.fail('cancelled response must not succeed'),
      reason => t.is(reason, 0),
    );
  await subject.provider.dispose();
  t.is(subject.revocations(), 1);
});

test('late acquisition cancellation never dispatches inference after revocation', async t => {
  t.timeout(5000);
  for (let delay = 0; delay <= 12; delay += 1) {
    const late = makePromiseKit();
    const entered = makePromiseKit();
    const controller = new AbortController();
    const subject = fixture([completion()], {
      openEndpoint: () => {
        entered.resolve(undefined);
        return late.promise;
      },
    });
    t.teardown(() => subject.provider.dispose());
    const call = subject.provider.chat([], [], controller.signal);
    const settled = call.then(
      () => 'completed',
      () => 'cancelled',
    );
    // eslint-disable-next-line no-await-in-loop
    await entered.promise;
    late.resolve(subject.endpoint);
    for (let step = 0; step < delay; step += 1) {
      // eslint-disable-next-line no-await-in-loop
      await null;
    }
    controller.abort(Error('late acquisition cancelled'));
    // eslint-disable-next-line no-await-in-loop
    await settled;
    // eslint-disable-next-line no-await-in-loop
    await subject.provider.dispose();
    t.is(subject.postRevocationRequests(), 0);
    t.is(subject.revocations(), 1);
  }
});

test('failed revocation fences inference and remains retryable by disposal', async t => {
  let refuse = true;
  const subject = fixture([completion()], {
    revoke: async () => {
      if (refuse) throw Error('revocation refused');
    },
  });
  t.teardown(() => {
    refuse = false;
    return subject.provider.dispose();
  });
  await t.throwsAsync(() => subject.provider.chat([], []), {
    message: /revocation refused/,
  });
  await t.throwsAsync(() => subject.provider.chat([], []), {
    message: /cleanup pending/,
  });
  t.is(subject.openings(), 1);
  refuse = false;
  await subject.provider.dispose();
  t.is(subject.revocations(), 2);
});

const overload = harden({
  type: 'error',
  code: 'server_is_overloaded',
  error: {
    code: 'server_is_overloaded',
    type: 'service_unavailable_error',
    message: 'Private provider prose must not reach the retry log',
  },
});

/**
 * @param {any[][]} attempts
 * @param {any} [options]
 */
const retryFixture = (attempts, options = {}) => {
  const requests = [];
  const steps = [];
  const logs = [];
  const delays = [];
  let opened = 0;
  const subscription = Far('RetrySubscription', {
    describe: () => harden({ models: [MODEL] }),
    openEndpoint: spec => {
      const index = opened;
      opened += 1;
      steps.push(`open:${index}`);
      if (spec.sessionId !== 'retry-session') throw Error('Changed session');
      return Far('RetryEndpoint', {
        revoke: async () => {
          steps.push(`revoke:${index}`);
          await options.revoke?.();
        },
        requestByteStream: request => {
          steps.push(`request:${index}`);
          requests.push(request);
          const bytes = new TextEncoder().encode(
            (attempts[index] ?? attempts[attempts.length - 1])
              .map(event => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
          );
          return harden({
            status: options.status ?? 200,
            contentType: 'text/event-stream',
            reader: bytesReaderFromIterator([bytes][Symbol.iterator]()),
          });
        },
      });
    },
  });
  const provider = makeSubscriptionResponsesProvider({
    subscription,
    model: MODEL,
    sessionId: 'retry-session',
    log: line => logs.push(line),
    sleep: async (ms, signal) => {
      steps.push('sleep');
      delays.push(ms);
      await options.sleep?.(ms, signal);
    },
    ...(options.retryDelays === undefined
      ? {}
      : { overloadRetryDelaysMs: options.retryDelays }),
  });
  return { provider, requests, steps, logs, delays };
};

test('overload retries revoke before backoff and preserve the exact request', async t => {
  const messages = [{ role: 'user', content: 'Original task' }];
  const subject = retryFixture(
    [
      [
        { type: 'response.created', response: { output: [] } },
        { type: 'response.in_progress', response: { output: [] } },
        overload,
      ],
      [completion([callItem])],
    ],
    {
      sleep: () => {
        messages[0].content = 'Changed task';
      },
    },
  );
  t.teardown(() => subject.provider.dispose());
  const result = await subject.provider.chat(messages, []);
  t.is(result.message.tool_calls?.[0].id, 'call1');
  t.deepEqual(subject.requests[0], subject.requests[1]);
  t.is(JSON.parse(subject.requests[1].body).input[0].content, 'Original task');
  t.deepEqual(subject.steps, [
    'open:0',
    'request:0',
    'revoke:0',
    'sleep',
    'open:1',
    'request:1',
    'revoke:1',
  ]);
  t.deepEqual(subject.delays, [5000]);
  t.deepEqual(subject.logs, [
    '[subscription-responses] provider overloaded; retry 1/5 in 5000ms',
  ]);
});

test('persistent overload is bounded to six attempts and five gentle delays', async t => {
  const subject = retryFixture([[overload]]);
  t.teardown(() => subject.provider.dispose());
  await t.throwsAsync(subject.provider.chat([], []), {
    message: /code=server_is_overloaded, type=service_unavailable_error/,
  });
  t.is(subject.requests.length, 6);
  t.deepEqual(subject.delays, [5000, 10_000, 20_000, 40_000, 60_000]);
  t.is(subject.logs.length, 5);
  t.false(subject.logs.join('').includes('Private'));
});

test('overload delay configuration can be changed or disabled', async t => {
  for (const retryDelays of [[], [15, 25]]) {
    const subject = retryFixture([[overload]], { retryDelays });
    t.teardown(() => subject.provider.dispose());
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(subject.provider.chat([], []), {
      message: /server_is_overloaded/,
    });
    t.is(subject.requests.length, retryDelays.length + 1);
    t.deepEqual(subject.delays, retryDelays);
  }
  const sparse = [];
  sparse.length = 1;
  for (const retryDelays of [
    [0],
    [-1],
    [1.5],
    [0x8000_0000],
    ['5000'],
    sparse,
  ]) {
    t.throws(() => retryFixture([[overload]], { retryDelays }), {
      message: /Invalid overload retry delays/,
    });
  }
});

for (const [label, event] of [
  ['text', { type: 'response.output_text.delta', delta: 'Partial' }],
  [
    'item',
    { type: 'response.output_item.added', output_index: 0, item: callItem },
  ],
  [
    'function arguments',
    { type: 'response.function_call_arguments.delta', delta: '{}' },
  ],
  [
    'reasoning',
    { type: 'response.reasoning_summary_text.delta', delta: 'Private' },
  ],
  ['unknown event', { type: 'future.event' }],
  ['incomplete lifecycle', { type: 'response.created', response: {} }],
  [
    'lifecycle output',
    { type: 'response.created', response: { output: [callItem] } },
  ],
  [
    'positive usage',
    {
      type: 'response.in_progress',
      response: { output: [], usage: { input_tokens: 2 } },
    },
  ],
  [
    'zero usage',
    {
      type: 'response.in_progress',
      response: { output: [], usage: { input_tokens: 0, output_tokens: 0 } },
    },
  ],
  [
    'unrecognized usage',
    {
      type: 'response.in_progress',
      response: { output: [], usage: { mystery: 1 } },
    },
  ],
]) {
  test(`overload never retries after ${label}`, async t => {
    const subject = retryFixture([[event, overload], [completion()]]);
    t.teardown(() => subject.provider.dispose());
    await t.throwsAsync(
      subject.provider.chatStream(
        [],
        [],
        () => {},
        undefined,
        () => {},
      ),
      {
        message: /server_is_overloaded/,
      },
    );
    t.is(subject.requests.length, 1);
    t.deepEqual(subject.delays, []);
  });
}

test('overload carrying output or usage is not retried', async t => {
  for (const response of [
    { error: overload.error, output: [callItem] },
    { error: overload.error, usage: { input_tokens: 1 } },
  ]) {
    const subject = retryFixture([[{ type: 'response.failed', response }]]);
    t.teardown(() => subject.provider.dispose());
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(subject.provider.chat([], []), {
      message: /server_is_overloaded/,
    });
    t.is(subject.requests.length, 1);
  }
});

test('overload retries do not swallow observer failures or ambiguous HTTP failures', async t => {
  const subject = retryFixture([
    [{ type: 'response.output_text.delta', delta: 'Partial' }, overload],
  ]);
  t.teardown(() => subject.provider.dispose());
  await t.throwsAsync(
    subject.provider.chatStream([], [], () => {
      throw Error('Observer failed');
    }),
    {
      message: 'Observer failed',
    },
  );
  t.is(subject.requests.length, 1);
  const http = retryFixture([[overload]], { status: 503 });
  t.teardown(() => http.provider.dispose());
  await t.throwsAsync(http.provider.chat([], []), { message: /HTTP 503/ });
  t.is(http.requests.length, 1);
});

for (const action of ['abort', 'dispose']) {
  test(`${action} interrupts real overload backoff without another endpoint`, async t => {
    t.timeout(1500);
    const entered = makePromiseKit();
    const controller = new AbortController();
    const subject = retryFixture([[overload]], {
      sleep: (ms, signal) => {
        entered.resolve(undefined);
        return abortableDelay(ms, signal);
      },
    });
    t.teardown(() => subject.provider.dispose());
    const call = subject.provider.chat([], [], controller.signal);
    const rejected = t.throwsAsync(call, {
      message: action === 'abort' ? 'Cancelled backoff' : /disposed/,
    });
    await entered.promise;
    if (action === 'abort') controller.abort(Error('Cancelled backoff'));
    else await subject.provider.dispose();
    await rejected;
    t.is(subject.requests.length, 1);
    t.deepEqual(subject.steps, ['open:0', 'request:0', 'revoke:0', 'sleep']);
  });
}

test('overload cleanup failure fences retry and new inference', async t => {
  let fail = true;
  const subject = retryFixture([[overload]], {
    revoke: () => {
      if (fail) throw Error('Revocation failed');
    },
  });
  t.teardown(() => {
    fail = false;
    return subject.provider.dispose();
  });
  await t.throwsAsync(subject.provider.chat([], []), {
    message: 'Revocation failed',
  });
  await t.throwsAsync(subject.provider.chat([], []), {
    message: /cleanup pending/,
  });
  t.is(subject.requests.length, 1);
  t.deepEqual(subject.delays, []);
});
