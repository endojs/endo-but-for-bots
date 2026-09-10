// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { Far } from '@endo/pass-style';

import {
  UNREPORTED_TOOL_RESULT,
  hostedTurnPartialOf,
  runHostedTurn,
} from '../src/hosted-turn.js';

test('send response loss still confirms producer stop and records uncertainty', async t => {
  t.timeout(5000);
  let stopped = false;
  const error = await t.throwsAsync(
    runHostedTurn({
      client: harden({
        send: async () => {
          throw Error('send response lost after producer start');
        },
        interrupt: async () => {
          stopped = true;
        },
      }),
      text: 'go',
      writer: harden({}),
    }),
    { message: /send response lost/ },
  );
  t.true(stopped);
  t.true(hostedTurnPartialOf(error)?.outcomeUnknown);
});

for (const events of [
  [{ type: 'tool-result', id: 'orphan', result: 'changed' }],
  [{ type: 'tool-call', id: '', name: 'exec', args: '{}' }],
  [
    { type: 'tool-call', id: 'same', name: 'exec', args: '{}' },
    { type: 'tool-call', id: 'same', name: 'exec', args: '{}' },
  ],
]) {
  test(`malformed native tool identity is not successful: ${JSON.stringify(events)}`, async t => {
    let stopped = false;
    const error = await t.throwsAsync(
      runHostedTurn({
        client: harden({
          send: async () =>
            readerFromIterator(
              (async function* () {
                yield* events;
                yield { type: 'end' };
              })(),
            ),
          interrupt: async () => {
            stopped = true;
          },
        }),
        text: 'go',
        writer: harden({ setPhase() {}, toolCall() {}, toolResult() {} }),
      }),
      { message: /Hosted tool/ },
    );
    t.true(stopped);
    t.true(hostedTurnPartialOf(error)?.outcomeUnknown);
  });
}

test('hosted turns translate normalized lifecycle events', async t => {
  const output = [];
  let optionsSeen;
  const client = harden({
    send: async (_text, options) => {
      optionsSeen = options;
      return readerFromIterator(
        (async function* events() {
          yield { type: 'phase', phase: 'thinking' };
          yield { type: 'commentary-delta', text: 'Checking…' };
          yield { type: 'tool-call', id: '1', name: 'shell', args: '{}' };
          yield { type: 'tool-result', id: '1', name: 'shell', result: 'ok' };
          yield { type: 'usage', inputTokens: 3, outputTokens: 1 };
          yield { type: 'text-delta', text: 'Done' };
          yield { type: 'usage', inputTokens: 5, outputTokens: 2 };
          yield { type: 'end' };
        })(),
      );
    },
  });
  const writer = harden({
    setPhase: value => output.push(['phase', value]),
    delta: value => output.push(['delta', value]),
    toolCall: value => output.push(['call', value]),
    toolResult: value => output.push(['result', value]),
  });

  const result = await runHostedTurn({
    client,
    text: 'go',
    writer,
    systemPrompt: 'stay scoped',
    continuityContext: 'prior dialogue',
  });
  t.deepEqual(result, {
    delivered: true,
    finalContent: 'Done',
    usage: { inputTokens: 8, outputTokens: 3 },
    toolCalls: [{ id: '1', name: 'shell', args: '{}', result: 'ok' }],
  });
  t.truthy(optionsSeen);
  t.like(optionsSeen, { continuityContext: 'prior dialogue' });
  t.is(
    /** @type {{ systemPrompt?: string }} */ (
      /** @type {unknown} */ (optionsSeen)
    ).systemPrompt,
    'stay scoped',
  );
  t.deepEqual(output[0], ['phase', 'thinking']);
  t.false(output.some(([, value]) => value === 'Checking…'));
  t.true(output.some(([kind]) => kind === 'call'));
  t.true(output.some(([kind]) => kind === 'result'));
});

test('continuity options preserve explicit empty and unavailable without choosing policy', async t => {
  for (const options of [
    { continuityContext: '' },
    { continuityContextUnavailable: 'history exceeds replay limit' },
  ]) {
    let seen;
    const client = harden({
      send: async (_text, opts) => {
        seen = opts;
        return readerFromIterator(
          (async function* events() {
            yield { type: 'end' };
          })(),
        );
      },
    });
    // eslint-disable-next-line no-await-in-loop
    await runHostedTurn({
      client,
      text: 'next',
      writer: harden({}),
      ...options,
    });
    t.deepEqual(seen, options);
  }
});

test('a pre-aborted hosted turn never reaches the client', async t => {
  let sends = 0;
  const client = harden({
    send: async () => {
      sends += 1;
      throw Error('must not send');
    },
  });
  const controller = new AbortController();
  controller.abort();
  const result = await runHostedTurn({
    client,
    text: 'go',
    writer: harden({}),
    signal: controller.signal,
  });
  t.is(sends, 0);
  t.deepEqual(result, {
    delivered: false,
    finalContent: '',
    usage: undefined,
    toolCalls: [],
  });
});

test('aborting while send is pending interrupts startup promptly', async t => {
  let interrupts = 0;
  const client = harden({
    send: async () => new Promise(() => {}),
    interrupt: async () => {
      interrupts += 1;
    },
  });
  const controller = new AbortController();
  const turnP = runHostedTurn({
    client,
    text: 'go',
    writer: harden({}),
    signal: controller.signal,
  });
  controller.abort();
  const result = await turnP;
  t.deepEqual(result, {
    delivered: false,
    finalContent: '',
    usage: undefined,
    toolCalls: [],
  });
  t.is(interrupts, 1);
});

test('abort waits for the backend terminal barrier before the next turn', async t => {
  let active = false;
  let resolveInterrupt = () => {};
  const interrupted = new Promise(resolve => {
    resolveInterrupt = () => resolve(undefined);
  });
  const client = harden({
    async send() {
      if (active) throw Error('backend still active');
      active = true;
      return new Promise(() => {});
    },
    async interrupt() {
      await interrupted;
      active = false;
    },
  });
  const controller = new AbortController();
  const first = runHostedTurn({
    client,
    text: 'first',
    writer: harden({ setPhase: () => {} }),
    signal: controller.signal,
  });
  controller.abort();
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await null;
  await null;
  t.false(settled);
  resolveInterrupt();
  await first;

  const secondController = new AbortController();
  const second = runHostedTurn({
    client,
    text: 'second',
    writer: harden({ setPhase: () => {} }),
    signal: secondController.signal,
  });
  secondController.abort();
  await second;
});

test('abort with a live reader also waits for terminal confirmation', async t => {
  const channel = makeBufferedReader();
  let resolveStarted = () => {};
  const started = new Promise(resolve => {
    resolveStarted = () => resolve(undefined);
  });
  let resolveInterrupt = () => {};
  const interrupted = new Promise(resolve => {
    resolveInterrupt = () => resolve(undefined);
  });
  const client = harden({
    send: async () => channel.reader,
    interrupt: async () => interrupted,
  });
  const controller = new AbortController();
  const turnP = runHostedTurn({
    client,
    text: 'live',
    writer: harden({ setPhase: resolveStarted }),
    signal: controller.signal,
  });
  channel.push({ type: 'phase', phase: 'thinking' });
  await started;
  controller.abort();
  let settled = false;
  void turnP.then(() => {
    settled = true;
  });
  await null;
  await null;
  t.false(settled);
  resolveInterrupt();
  await turnP;
});

test('reader close failure cannot skip the explicit backend interrupt', async t => {
  let resolveStarted = () => {};
  const started = new Promise(resolve => {
    resolveStarted = () => resolve(undefined);
  });
  let rejectTail = () => {};
  const tail = new Promise((_resolve, reject) => {
    rejectTail = () => reject(Error('reader close failed'));
  });
  const reader = Far('RejectingReader', {
    async stream(_synHead) {
      return harden({
        value: { type: 'phase', phase: 'thinking' },
        promise: tail,
      });
    },
    readPattern() {
      return undefined;
    },
    readReturnPattern() {
      return undefined;
    },
  });
  let interrupts = 0;
  const client = harden({
    send: async () => reader,
    interrupt: async () => {
      interrupts += 1;
    },
  });
  const controller = new AbortController();
  const turnP = runHostedTurn({
    client,
    text: 'live',
    writer: harden({ setPhase: resolveStarted }),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  rejectTail();
  await t.throwsAsync(turnP, { message: /reader close failed/ });
  t.is(interrupts, 1);
});

test('hosted turn abort is a failed turn that reports what was delivered', async t => {
  const client = harden({
    send: async () =>
      readerFromIterator(
        (async function* events() {
          yield { type: 'abort', reason: 'denied' };
        })(),
      ),
  });
  const writer = harden({
    setPhase: () => {},
    delta: () => {},
    toolCall: () => {},
    toolResult: () => {},
  });
  const refused = await t.throwsAsync(
    () => runHostedTurn({ client, text: 'go', writer }),
    { message: 'denied' },
  );
  // A leading abort means the backend never took the prompt.
  t.deepEqual(hostedTurnPartialOf(refused), {
    delivered: false,
    finalContent: '',
    usage: undefined,
    toolCalls: [],
  });

  // A failure after the backend started the turn keeps what streamed: the
  // prompt was delivered, and a transcript backend retains all of this.
  const streamed = harden({
    send: async () =>
      readerFromIterator(
        (async function* events() {
          yield { type: 'phase', phase: 'starting' };
          yield { type: 'tool-call', id: '1', name: 'shell', args: '{}' };
          yield { type: 'text-delta', text: 'partial' };
          yield {
            type: 'abort',
            reason: 'claude turn failed: error_max_turns',
          };
        })(),
      ),
  });
  const failed = await t.throwsAsync(
    () => runHostedTurn({ client: streamed, text: 'go', writer }),
    { message: /error_max_turns/ },
  );
  t.deepEqual(hostedTurnPartialOf(failed), {
    delivered: true,
    finalContent: 'partial',
    usage: undefined,
    toolCalls: [{ id: '1', name: 'shell', args: '{}', result: null }],
  });
  // Any other error carries no partial: the prompt never reached the backend.
  t.is(hostedTurnPartialOf(Error('send refused')), undefined);
});

test('an unresolved tool at turn end fails with an honest partial record', async t => {
  const output = [];
  let interrupts = 0;
  const client = harden({
    interrupt: async () => {
      interrupts += 1;
    },
    send: async () =>
      readerFromIterator(
        (async function* events() {
          yield { type: 'tool-call', id: '1', name: 'shell', args: '{}' };
          yield { type: 'tool-call', id: '2', name: 'lookup', args: '{}' };
          yield { type: 'tool-result', id: '2', name: 'lookup', result: 'ok' };
          yield { type: 'text-delta', text: 'Done' };
          yield { type: 'usage', inputTokens: 7, outputTokens: 3 };
          yield { type: 'end' };
        })(),
      ),
  });
  const writer = harden({
    setPhase: () => {},
    delta: () => {},
    toolCall: () => {},
    toolResult: value => output.push(value),
  });
  const error = await t.throwsAsync(
    runHostedTurn({ client, text: 'go', writer }),
    {
      message: /unsettled tool calls/,
    },
  );
  const partial = hostedTurnPartialOf(error);
  t.is(interrupts, 1);
  t.deepEqual(partial?.usage, { inputTokens: 7, outputTokens: 3 });
  t.deepEqual(partial?.toolCalls, [
    { id: '1', name: 'shell', args: '{}', result: null },
    { id: '2', name: 'lookup', args: '{}', result: 'ok' },
  ]);
  t.deepEqual(output, [
    { id: '2', name: 'lookup', result: 'ok' },
    { id: '1', name: 'shell', result: UNREPORTED_TOOL_RESULT },
  ]);
});

test('send failure during cancellation waits for the interrupt outcome', async t => {
  t.timeout(5000);
  let rejectSend = error => {};
  let rejectInterrupt = error => {};
  let signalStarted = () => {};
  const started = new Promise(resolve => {
    signalStarted = () => resolve(undefined);
  });
  const sendP = new Promise((resolve, reject) => {
    rejectSend = reject;
  });
  const interruptP = new Promise((resolve, reject) => {
    rejectInterrupt = reject;
  });
  const controller = new AbortController();
  const turnP = runHostedTurn({
    client: harden({
      send: () => {
        signalStarted();
        return sendP;
      },
      interrupt: () => interruptP,
    }),
    text: 'cancel me',
    writer: harden({}),
    signal: controller.signal,
  });
  let settled = false;
  void turnP.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started;
  controller.abort();
  rejectSend(Error('send disconnected'));
  await new Promise(resolve => setImmediate(resolve));
  t.false(settled, 'the backend interruption is still pending');
  rejectInterrupt(Error('interrupt failed'));
  await t.throwsAsync(turnP, {
    instanceOf: AggregateError,
    message: /interrupt failed/,
  });
});

for (const failure of ['EOF', 'reader rejection']) {
  test(`${failure} waits for explicit interruption and preserves partial usage`, async t => {
    t.timeout(5000);
    let finishInterrupt = () => {};
    const barrier = new Promise(resolve => {
      finishInterrupt = () => resolve(undefined);
    });
    t.teardown(finishInterrupt);
    let interruptStarted = () => {};
    const started = new Promise(resolve => {
      interruptStarted = () => resolve(undefined);
    });
    const turn = runHostedTurn({
      client: harden({
        send: async () =>
          readerFromIterator(
            (async function* events() {
              yield { type: 'text-delta', text: 'partial' };
              yield { type: 'usage', inputTokens: 4, outputTokens: 2 };
              if (failure === 'reader rejection') throw Error('reader broke');
            })(),
          ),
        interrupt: async () => {
          interruptStarted();
          await barrier;
        },
      }),
      text: 'go',
      writer: harden({ delta: () => {} }),
    });
    let settled = false;
    void turn.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = t.throwsAsync(turn, {
      message: failure === 'EOF' ? /without a terminal/ : /reader broke/,
    });
    await started;
    t.false(settled);
    finishInterrupt();
    const error = await rejected;
    t.deepEqual(hostedTurnPartialOf(error), {
      delivered: true,
      outcomeUnknown: true,
      finalContent: 'partial',
      toolCalls: [],
      usage: { inputTokens: 4, outputTokens: 2 },
    });
  });
}

test('abnormal EOF with a failed interrupt quarantines with partial evidence', async t => {
  const error = await t.throwsAsync(
    runHostedTurn({
      client: harden({
        send: async () =>
          readerFromIterator(
            (async function* events() {
              yield { type: 'text-delta', text: 'partial' };
            })(),
          ),
        interrupt: async () => {
          throw Error('not stopped');
        },
      }),
      text: 'go',
      writer: harden({ delta: () => {} }),
    }),
    { message: /^Hosted turn cancellation failed:/ },
  );
  t.is(hostedTurnPartialOf(error)?.finalContent, 'partial');
});

test('normalized abort is already a terminal barrier and retains usage', async t => {
  let interrupts = 0;
  const error = await t.throwsAsync(
    runHostedTurn({
      client: harden({
        send: async () =>
          readerFromIterator(
            (async function* events() {
              yield { type: 'usage', inputTokens: 2, outputTokens: 1 };
              yield { type: 'abort', reason: 'stopped' };
            })(),
          ),
        interrupt: async () => {
          interrupts += 1;
        },
      }),
      text: 'go',
      writer: harden({}),
    }),
    { message: 'stopped' },
  );
  t.is(interrupts, 0);
  t.deepEqual(hostedTurnPartialOf(error)?.usage, {
    inputTokens: 2,
    outputTokens: 1,
  });
});

test('durable tool recording failure stops the producer before exposing the tool', async t => {
  let interrupts = 0;
  let published = 0;
  const error = await t.throwsAsync(
    runHostedTurn({
      client: harden({
        send: async () =>
          readerFromIterator(
            (async function* events() {
              yield { type: 'tool-call', id: 'one', name: 'exec', args: '{}' };
              yield { type: 'end' };
            })(),
          ),
        interrupt: async () => {
          interrupts += 1;
        },
      }),
      text: 'go',
      writer: harden({
        setPhase: () => {},
        toolCall: () => {
          published += 1;
        },
      }),
      recordToolEvent: async () => {
        throw Error('journal unavailable');
      },
    }),
    { message: /journal unavailable/ },
  );
  t.is(interrupts, 1);
  t.is(published, 0);
  t.deepEqual(hostedTurnPartialOf(error)?.toolCalls, [
    { id: 'one', name: 'exec', args: '{}', result: null },
  ]);
});
