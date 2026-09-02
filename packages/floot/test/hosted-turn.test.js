// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { Far } from '@endo/pass-style';

import { runHostedTurn } from '../src/hosted-turn.js';

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
  });
  t.deepEqual(result, {
    finalContent: 'Done',
    usage: { inputTokens: 8, outputTokens: 3 },
    toolCalls: [{ id: '1', name: 'shell', args: '{}', result: 'ok' }],
  });
  t.truthy(optionsSeen);
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

test('hosted turn abort is a failed turn', async t => {
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
  await t.throwsAsync(() => runHostedTurn({ client, text: 'go', writer }), {
    message: 'denied',
  });
});
