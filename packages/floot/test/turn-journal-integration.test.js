// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';

const fixture = () => {
  const store = new Map();
  let refusedType;
  const nameOf = name => (Array.isArray(name) ? name.join('.') : name);
  const powers = harden({
    async list(prefix) {
      return harden(prefix === 'tools' ? [] : [...store.keys()]);
    },
    async has(name) {
      return store.has(nameOf(name));
    },
    async lookup(name) {
      if (!store.has(nameOf(name))) throw Error('Not found');
      return store.get(nameOf(name));
    },
    async storeValue(value, name) {
      if (value?.type === refusedType && refusedType)
        throw Error('Storage unavailable');
      if (store.has(nameOf(name))) throw Error('No overwrite');
      store.set(nameOf(name), value);
    },
    async followMessages() {
      return harden({ [Symbol.asyncIterator]: () => harden({}) });
    },
  });
  return {
    powers,
    events: () =>
      [...store.entries()]
        .filter(([name]) => name.startsWith('floot-turn-event-'))
        .map(([, event]) => event),
    refuse: type => {
      refusedType = type;
    },
  };
};

const effectTool = execute =>
  harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'effect',
          description: 'Test side effect',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }),
    execute,
    help: () => 'Test side effect',
  });
const callEffect = () =>
  harden({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'effect-call',
          type: 'function',
          function: { name: 'effect', arguments: '{}' },
        },
      ],
    },
  });
const completed = () =>
  harden({ message: { role: 'assistant', content: 'Done' } });

test('direct tools persist intent before effects and failed effects remain in later model context', async t => {
  t.timeout(5000);
  const f = fixture();
  const contexts = [];
  let effects = 0;
  const extraTools = new Map([
    [
      'effect',
      effectTool(async () => {
        t.is(f.events().at(-1).type, 'tool-intent');
        effects += 1;
        return 'Changed the external resource once';
      }),
    ],
  ]);
  const provider = harden({
    async chatStream(context) {
      contexts.push(context);
      if (contexts.length === 1)
        return harden({
          ...callEffect(),
          usage: { inputTokens: 7, outputTokens: 3 },
        });
      if (contexts.length === 2)
        throw Error('Provider disconnected after effect');
      return completed();
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
    { extraTools },
  );
  await t.throwsAsync(agent.converse('Change it', makeReplyChannel().writer), {
    message: /disconnected after effect/,
  });
  await agent.converse('Summarize, do not repeat', makeReplyChannel().writer);
  t.is(effects, 1);
  t.true(
    contexts[2].some(
      message =>
        message.role === 'tool' &&
        message.content === 'Changed the external resource once',
    ),
  );
  t.true(
    contexts[2].some(
      message =>
        message.content === 'Turn failed: Provider disconnected after effect',
    ),
  );
  t.deepEqual(
    (await agent.getTurns()).map(turn => turn.state),
    ['failed', 'completed'],
  );
  t.deepEqual((await agent.getTurns())[0].usage, {
    inputTokens: 7,
    outputTokens: 3,
  });
  t.deepEqual(
    (await agent.getHistory()).map(
      message => message.content || message.result,
    ),
    [
      'Change it',
      'Changed the external resource once',
      'Turn failed: Provider disconnected after effect',
      'Summarize, do not repeat',
      'Done',
    ],
  );
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
    { extraTools },
  );
  t.deepEqual(await revived.getHistory(), await agent.getHistory());
  t.deepEqual((await revived.getTurns())[0].usage, {
    inputTokens: 7,
    outputTokens: 3,
  });
});

test('failed hosted turn preserves reported partial usage across revival without claiming success', async t => {
  t.timeout(5000);
  const f = fixture();
  const hostedClient = harden({
    async send() {
      const channel = makeBufferedReader();
      channel.push({ type: 'usage', inputTokens: 13, outputTokens: 5 });
      channel.push({
        type: 'abort',
        reason: 'Provider failed after metered work',
      });
      return channel.reader;
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { hostedClient },
    'Test',
  );
  await t.throwsAsync(
    agent.converse('Metered attempt', makeReplyChannel().writer),
    { message: /Provider failed after metered work/ },
  );
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { hostedClient },
    'Test',
  );
  const [turn] = await revived.getTurns();
  t.is(turn.state, 'failed');
  t.deepEqual(turn.usage, { inputTokens: 13, outputTokens: 5 });
  t.is((await revived.getUsage()).turns, 0);
});

test('hosted snapshot tools durably authorize effects and preserve failures without stream tool events', async t => {
  t.timeout(5000);
  const f = fixture();
  let effects = 0;
  const inputs = [];
  const extraTools = new Map([
    [
      'effect',
      effectTool(async () => {
        t.is(f.events().at(-1).type, 'tool-intent');
        effects += 1;
        return 'Hosted effect completed';
      }),
    ],
  ]);
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      provideHostedClient: async snapshot =>
        harden({
          async interrupt() {
            await null;
          },
          async send(input) {
            inputs.push(input);
            if (inputs.length > 1) {
              const channel = makeBufferedReader();
              channel.push({ type: 'text-delta', text: 'Recovered safely' });
              channel.push({ type: 'end' });
              return channel.reader;
            }
            await snapshot.execute('effect', harden({}));
            t.is(f.events().at(-1).type, 'tool-result');
            throw Error('Hosted provider disconnected');
          },
        }),
    },
    'Test',
    { extraTools },
  );
  await t.throwsAsync(
    agent.converse('Change hosted resource', makeReplyChannel().writer),
    { message: /Hosted provider disconnected/ },
  );
  const [turn] = await agent.getTurns();
  t.is(effects, 1);
  t.is(turn.state, 'outcome-unknown');
  t.is(turn.tools[0].result, 'Hosted effect completed');
  t.deepEqual(turn.activity, []);
  t.is((await agent.getHistory())[1].result, 'Hosted effect completed');
  await t.throwsAsync(
    agent.converse('Blocked until checked', makeReplyChannel().writer),
    { message: /unknown turn outcome/ },
  );
  t.is(inputs.length, 1);
  await agent.resolveTurn(
    turn.turnId,
    'Operator independently verified all hosted effects',
  );
  await agent.converse('Inspect, do not repeat', makeReplyChannel().writer);
  t.regex(inputs[1], /Previous incomplete-turn recovery evidence/);
  t.regex(inputs[1], /Hosted effect completed/);
  t.regex(inputs[1], /External effects are not undone/);
  t.regex(inputs[1], /Current user request:\nInspect, do not repeat/);
  t.is(effects, 1);
  t.is(
    (await agent.getTurns())[1].input,
    'Inspect, do not repeat',
    'Recovery envelope does not replace original durable input',
  );
});

test('aliased backend observations retain distinct execution evidence without claiming duplicate effects', async t => {
  t.timeout(5000);
  const f = fixture();
  let effects = 0;
  const extraTools = new Map([
    [
      'effect',
      effectTool(async () => {
        effects += 1;
        return 'Effect happened once';
      }),
    ],
  ]);
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      provideHostedClient: async snapshot =>
        harden({
          async send() {
            const result = await snapshot.execute('effect', harden({}));
            const channel = makeBufferedReader();
            channel.push({
              type: 'tool-call',
              id: 'native-alias',
              name: 'endo_effect',
              args: '{}',
            });
            channel.push({
              type: 'tool-result',
              id: 'native-alias',
              name: 'endo_effect',
              result,
            });
            channel.push({
              type: 'abort',
              reason: 'Provider declined further work',
            });
            return channel.reader;
          },
        }),
    },
    'Test',
    { extraTools },
  );
  await t.throwsAsync(
    agent.converse('Apply effect', makeReplyChannel().writer),
    { message: /Provider declined further work/ },
  );
  const [turn] = await agent.getTurns();
  t.is(turn.state, 'failed');
  t.is(turn.activity[0].name, 'endo_effect');
  t.is(turn.tools[0].name, 'effect');
  const tools = (await agent.getHistory()).filter(
    message => message.role === 'tool',
  );
  t.is(tools.length, 2);
  t.is(tools[0].name, 'endo_effect');
  t.is(tools[0].result, 'Effect happened once');
  t.is(tools[1].name, 'effect');
  t.regex(
    tools[1].result,
    /Durable Endo execution evidence; may correspond to a backend observation above, not an additional execution/,
  );
  t.regex(tools[1].result, /Effect happened once/);
  t.is(effects, 1);
});

test('failed mail turns merge partial input nodes with durable tool evidence after revival', async t => {
  t.timeout(5000);
  const f = fixture();
  const contexts = [];
  let effects = 0;
  const extraTools = new Map([
    [
      'effect',
      effectTool(async () => {
        effects += 1;
        return 'Mail-origin effect completed';
      }),
    ],
  ]);
  const provider = harden({
    async chatStream(context) {
      contexts.push(context);
      if (contexts.length === 1) return callEffect();
      if (contexts.length === 2) throw Error('Failed after mail-origin effect');
      return completed();
    },
  });
  const first = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
    { extraTools },
  );
  await t.throwsAsync(
    first.converse('Mail request', makeReplyChannel().writer, {
      mail: { messageNumber: 'mail-1' },
    }),
    { message: /Failed after mail-origin effect/ },
  );
  const history = await first.getHistory();
  t.deepEqual(
    history.map(message => message.content || message.result),
    [
      'Mail request',
      'Mail-origin effect completed',
      'Turn failed: Failed after mail-origin effect',
    ],
  );
  t.is(history[0].meta.mail.messageNumber, 'mail-1');
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
    { extraTools },
  );
  t.deepEqual(await revived.getHistory(), history);
  await revived.converse(
    'Continue without repeating',
    makeReplyChannel().writer,
  );
  t.is(effects, 1);
  t.true(
    contexts[2].some(
      message =>
        message.role === 'tool' &&
        message.content === 'Mail-origin effect completed',
    ),
  );
  t.deepEqual(
    (await revived.getHistory()).map(
      message => message.content || message.result,
    ),
    [
      'Mail request',
      'Mail-origin effect completed',
      'Turn failed: Failed after mail-origin effect',
      'Continue without repeating',
      'Done',
    ],
  );
});

test('lost result writes prevent automatic redispatch and revival requires explicit outcome resolution', async t => {
  t.timeout(5000);
  const f = fixture();
  let effects = 0;
  let calls = 0;
  const extraTools = new Map([
    [
      'effect',
      effectTool(async () => {
        effects += 1;
        f.refuse('tool-result');
        return 'Effect happened but result could not be recorded';
      }),
    ],
  ]);
  const provider = harden({
    async chatStream() {
      calls += 1;
      return callEffect();
    },
  });
  const first = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
    { extraTools },
  );
  await t.throwsAsync(first.converse('Apply once', makeReplyChannel().writer), {
    message: /uncertain storage/,
  });
  await t.throwsAsync(
    first.converse('Do not replay', makeReplyChannel().writer),
    { message: /uncertain storage/ },
  );
  t.is(calls, 1);
  t.is(effects, 1);
  f.refuse(undefined);
  const safeProvider = harden({
    async chatStream() {
      calls += 1;
      return completed();
    },
  });
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider: safeProvider },
    'Test',
    { extraTools },
  );
  const [uncertain] = await revived.getTurns();
  t.is(uncertain.state, 'outcome-unknown');
  t.is(uncertain.tools[0].settled, undefined);
  await t.throwsAsync(
    revived.converse('Do not replay yet', makeReplyChannel().writer),
    { message: /unknown turn outcome/ },
  );
  t.is(calls, 1);
  await revived.resolveTurn(
    uncertain.turnId,
    'Operator verified the effect happened once',
  );
  await revived.converse('Continue safely', makeReplyChannel().writer);
  t.is(calls, 2);
  t.is(effects, 1);
  const [resolved, next] = await revived.getTurns();
  t.is(resolved.state, 'outcome-unknown');
  t.is(resolved.resolution, 'Operator verified the effect happened once');
  t.is(next.state, 'completed');
});

test('failed intent persistence never dispatches the actual Endo tool', async t => {
  t.timeout(5000);
  const f = fixture();
  f.refuse('tool-intent');
  let effects = 0;
  const extraTools = new Map([
    [
      'effect',
      effectTool(async () => {
        effects += 1;
        return 'unsafe';
      }),
    ],
  ]);
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider: harden({ chatStream: async () => callEffect() }) },
    'Test',
    { extraTools },
  );
  await t.throwsAsync(
    agent.converse('Do not execute without intent', makeReplyChannel().writer),
    { message: /uncertain storage/ },
  );
  t.is(effects, 0);
  t.deepEqual(
    f.events().map(event => event.type),
    ['dispatch'],
  );
});

test('native hosted activity without result fences a later turn despite a provider success claim', async t => {
  t.timeout(5000);
  const f = fixture();
  let sends = 0;
  const hostedClient = harden({
    async interrupt() {
      await null;
    },
    async send() {
      sends += 1;
      const channel = makeBufferedReader();
      channel.push({
        type: 'tool-call',
        id: 'native',
        name: 'shell',
        args: '{}',
      });
      channel.push({ type: 'text-delta', text: 'Claimed success' });
      channel.push({ type: 'end' });
      return channel.reader;
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { hostedClient },
    'Test',
  );
  await t.throwsAsync(
    agent.converse('Native operation', makeReplyChannel().writer),
    { message: /Tool outcome unknown|unsettled tool|without.*result/i },
  );
  const [turn] = await agent.getTurns();
  t.is(turn.state, 'outcome-unknown');
  t.is(turn.activity[0].settled, undefined);
  await t.throwsAsync(
    agent.converse('Do not blindly replay', makeReplyChannel().writer),
    { message: /unknown turn outcome/ },
  );
  t.is(sends, 1);
});
