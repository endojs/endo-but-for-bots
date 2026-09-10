// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';

const makeSendSignal = () => {
  let count = 0;
  const waiters = new Map();
  return {
    notify() {
      count += 1;
      waiters.get(count)?.();
    },
    /** @param {number} expected */
    waitFor(expected) {
      return count >= expected
        ? Promise.resolve()
        : new Promise(resolve => waiters.set(expected, resolve));
    },
  };
};

const makeFakePowers = () => {
  const store = new Map();
  const nameOf = petName =>
    Array.isArray(petName) ? petName.join('.') : petName;
  return harden({
    async storeValue(value, petName) {
      const name = nameOf(petName);
      if (store.has(name)) throw Error(`already stored: ${name}`);
      store.set(name, value);
    },
    async lookup(petName) {
      const name = nameOf(petName);
      if (!store.has(name)) throw Error(`not found: ${name}`);
      return store.get(name);
    },
    async has(petName) {
      return store.has(nameOf(petName));
    },
    async remove(petName) {
      store.delete(nameOf(petName));
    },
    async list() {
      return harden([...store.keys()]);
    },
    async followMessages() {
      return harden({ [Symbol.asyncIterator]: () => harden({}) });
    },
  });
};

test('a hosted backend persists completed turns and scopes reused tool IDs', async t => {
  t.timeout(5000);
  const sent = makeSendSignal();
  const turns = [];
  const sendOptions = [];
  const powers = makeFakePowers();
  const hostedClient = harden({
    async send(_text, options) {
      sendOptions.push(options);
      const channel = makeBufferedReader();
      turns.push(channel);
      sent.notify();
      return channel.reader;
    },
  });
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient },
    'test prompt',
  );
  const { writer, reader } = makeReplyChannel();
  const replyP = (async () => {
    const events = [];
    for await (const event of iterateReader(reader)) events.push(event);
    return events;
  })();
  const turnP = agent.converse('build it', writer);
  await sent.waitFor(1);
  t.is(
    sendOptions[0].continuityContext,
    '',
    'current input is not replayed as history',
  );
  turns[0].push({ type: 'text-delta', text: 'Built.' });
  turns[0].push({ type: 'tool-call', id: 'tool-1', name: 'shell', args: '{}' });
  turns[0].push({
    type: 'tool-result',
    id: 'tool-1',
    name: 'shell',
    result: 'ok',
  });
  turns[0].push({ type: 'usage', inputTokens: 9, outputTokens: 2 });
  turns[0].push({ type: 'end' });
  await turnP;

  const events = await replyP;
  t.deepEqual(events.at(-1), { type: 'end' });
  t.deepEqual(events.at(-2), { type: 'final', text: 'Built.' });
  t.deepEqual(
    (await agent.getHistory()).map(message => [message.role, message.content]),
    [
      ['user', 'build it'],
      ['tool', undefined],
      ['assistant', 'Built.'],
    ],
  );

  const secondReply = makeReplyChannel();
  const secondTurn = agent.converse('again', secondReply.writer);
  await sent.waitFor(2);
  t.deepEqual(
    JSON.parse(sendOptions[1].continuityContext),
    [
      { role: 'user', content: 'build it' },
      { role: 'tool', name: 'shell', args: '{}', result: 'ok' },
      { role: 'assistant', content: 'Built.' },
    ],
    'the next turn gets complete prior dialogue, not its own prompt',
  );
  turns[1].push({
    type: 'tool-call',
    id: 'tool-1',
    name: 'shell',
    args: '{"second":true}',
  });
  turns[1].push({
    type: 'tool-result',
    id: 'tool-1',
    name: 'shell',
    result: 'second result',
  });
  turns[1].push({ type: 'text-delta', text: 'Again.' });
  turns[1].push({ type: 'end' });
  await secondTurn;
  t.deepEqual(
    (await agent.getHistory())
      .filter(message => message.role === 'tool')
      .map(message => message.result),
    ['ok', 'second result'],
    'reused provider call ids pair with results from their own turn',
  );

  const revived = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient },
    'test prompt',
  );
  t.deepEqual(await revived.getUsage(), {
    inputTokens: 9,
    outputTokens: 2,
    turns: 2,
  });
});

test('failed hosted turns revive before later successful history', async t => {
  const powers = makeFakePowers();
  const failedClient = harden({
    async send() {
      const channel = makeBufferedReader();
      queueMicrotask(() => channel.push({ type: 'abort', reason: 'failed' }));
      return channel.reader;
    },
  });
  const first = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient: failedClient },
    'test prompt',
  );
  const failedReply = makeReplyChannel();
  await t.throwsAsync(() => first.converse('orphan me', failedReply.writer), {
    message: 'failed',
  });

  const successfulClient = harden({
    async send() {
      const channel = makeBufferedReader();
      queueMicrotask(() => {
        channel.push({ type: 'text-delta', text: 'Clean.' });
        channel.push({ type: 'end' });
      });
      return channel.reader;
    },
  });
  const revived = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient: successfulClient },
    'test prompt',
  );
  const successfulReply = makeReplyChannel();
  await revived.converse('new turn', successfulReply.writer);
  t.deepEqual(
    (await revived.getHistory()).map(message => [
      message.role,
      message.content,
    ]),
    [
      ['user', 'orphan me'],
      ['assistant', 'Turn failed: failed'],
      ['user', 'new turn'],
      ['assistant', 'Clean.'],
    ],
  );
});

test('agent shutdown interrupts and awaits an active hosted turn', async t => {
  t.timeout(5000);
  const sent = makeSendSignal();
  const powers = makeFakePowers();
  let interrupted = 0;
  let terminalDelivered = false;
  const turns = [];
  const hostedClient = harden({
    async send() {
      const channel = makeBufferedReader();
      turns.push(channel);
      sent.notify();
      return channel.reader;
    },
    async interrupt() {
      interrupted += 1;
      terminalDelivered = true;
      turns.at(-1).push({ type: 'abort', reason: 'interrupted' });
    },
  });
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient },
    'test prompt',
  );
  const reply = makeReplyChannel();
  const turn = agent.converse('keep working', reply.writer);
  await sent.waitFor(1);
  turns[0].push({ type: 'phase', phase: 'thinking' });
  await null;
  await null;
  await agent.shutdown();
  await turn;
  t.true(terminalDelivered);
  t.is(interrupted, 1);
  t.deepEqual(
    (await agent.getHistory()).map(message => [message.role, message.content]),
    [
      ['user', 'keep working'],
      ['assistant', 'Turn cancelled.'],
    ],
  );
  t.is((await agent.getTurns())[0].state, 'cancelled');
  await t.throwsAsync(
    () => agent.converse('too late', makeReplyChannel().writer),
    { message: /shutting down/ },
  );
});

test('a rejected hosted interrupt quarantines the streaming agent', async t => {
  t.timeout(5000);
  const sent = makeSendSignal();
  const powers = makeFakePowers();
  const turns = [];
  const hostedClient = harden({
    async send() {
      const channel = makeBufferedReader();
      turns.push(channel);
      sent.notify();
      return channel.reader;
    },
    async interrupt() {
      throw Error('terminal barrier failed');
    },
  });
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient },
    'test prompt',
  );
  const active = agent.converse('mutate', makeReplyChannel().writer);
  await sent.waitFor(1);
  turns[0].push({ type: 'phase', phase: 'thinking' });
  const activeFailure = t.throwsAsync(active, {
    message: /terminal barrier failed/,
  });
  await t.throwsAsync(() => agent.shutdown(), {
    message: /terminal barrier failed/,
  });
  // Factory teardown may proceed to the separately held backend admin facet,
  // whose termination is the authoritative slice-reap barrier.
  await agent.shutdown(true);
  await activeFailure;
  await t.throwsAsync(
    () => agent.converse('retry', makeReplyChannel().writer),
    { message: /terminal barrier failed/ },
  );
});

test('shutdown cancels inbox startup delayed before iterator creation', async t => {
  const base = makeFakePowers();
  let releaseLocate = () => {};
  const locateReady = new Promise(resolve => {
    releaseLocate = () => resolve('self-locator');
  });
  const inbox = makeBufferedReader();
  const powers = harden({
    ...base,
    locate: async () => locateReady,
    followMessages: async () => inbox.reader,
  });
  const provider = harden({
    async chatStream() {
      throw Error('must not run');
    },
  });
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { provider },
    'test prompt',
  );
  agent.startInbox();
  const shutdown = agent.shutdown();
  releaseLocate();
  await shutdown;
  t.true(inbox.isClosed());
});

test('failed provider tool loops revive their known tool effects', async t => {
  const powers = makeFakePowers();
  let round = 0;
  const provider = harden({
    async chatStream() {
      round += 1;
      if (round === 1) {
        return harden({
          message: harden({
            role: 'assistant',
            content: '',
            tool_calls: harden([
              harden({
                id: 'list-1',
                type: 'function',
                function: harden({ name: 'list', arguments: '{}' }),
              }),
            ]),
          }),
        });
      }
      throw Error('provider failed after tool execution');
    },
  });
  const first = await makeStreamingAgent(
    powers,
    undefined,
    { provider },
    'test prompt',
  );
  const reply = makeReplyChannel();
  await t.throwsAsync(() => first.converse('partial', reply.writer), {
    message: /provider failed after tool execution/,
  });

  const revived = await makeStreamingAgent(
    powers,
    undefined,
    { provider },
    'test prompt',
  );
  const history = await revived.getHistory();
  t.is(history[0].content, 'partial');
  t.is(history[1].role, 'tool');
  t.is(history[1].name, 'list');
  t.true(Array.isArray(JSON.parse(history[1].result)));
  t.is(history[2].content, 'Turn failed: provider failed after tool execution');
  t.true(history.every(message => message.meta.turnState === 'failed'));
  t.is((await revived.getTurns())[0].tools[0].settled, true);
});

test('hosted provisioning receives the session delegation and account catalog', async t => {
  const powers = makeFakePowers();
  /** @type {{ names: string[] } | undefined} */
  let supplied;
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    {
      provideHostedClient: async snapshot => {
        supplied = snapshot;
        await t.throwsAsync(snapshot.execute('accountStatus', harden({})), {
          message: /outside an active Floot turn/,
        });
        return harden({
          async send() {
            const report = await snapshot.execute('accountStatus', harden({}));
            t.regex(report, /0 input and 0 output tokens/);
            const channel = makeBufferedReader();
            channel.push({ type: 'text-delta', text: 'Checked' });
            channel.push({ type: 'end' });
            return channel.reader;
          },
        });
      },
    },
    'test prompt',
    {
      spawner: harden({}),
      accountOracle: harden({
        getPlan: () =>
          harden({ title: 'Test', source: 'declared', observedAt: '' }),
        getRateLimits: () =>
          harden({ windows: [], source: 'unavailable', observedAt: '' }),
        getRateCard: () =>
          harden({ rates: [], source: 'unavailable', observedAt: '' }),
      }),
    },
  );
  t.teardown(() => agent.shutdown());
  await agent.converse('check account', makeReplyChannel().writer);
  if (!supplied) throw Error('Hosted catalog was not supplied');
  for (const name of [
    'spawnSubagent',
    'askSubagent',
    'stopSubagent',
    'accountStatus',
  ]) {
    t.true(
      supplied.names.includes(name),
      `${name} is available to hosted agents`,
    );
  }
});
