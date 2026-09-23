// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { makeOpenRouterProvider } from '@endo/lal/providers/index.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';
import { usageCounts } from './helpers/usage.js';

const fixture = () => {
  const store = new Map();
  let refusedType;
  const accessedNames = [];
  const nameOf = name => {
    const key = Array.isArray(name) ? name.join('.') : name;
    accessedNames.push(key);
    return key;
  };
  const powers = harden({
    async list(prefix) {
      return harden(prefix === 'tools' ? [] : [...store.keys()]);
    },
    async has(name) {
      return store.has(nameOf(name));
    },
    async remove(name) {
      store.delete(nameOf(name));
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
    store,
    accessedNames,
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

test('empty OpenRouter completion remains a failed turn after reconstruction', async t => {
  t.timeout(10_000);
  const f = fixture();
  let requests = 0;
  const provider = makeOpenRouterProvider({
    apiKey: 'test-not-a-key',
    model: 'openrouter/free',
    fetchImpl: async url => {
      if (String(url).endsWith('/models')) return Response.json({ data: [] });
      requests += 1;
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '',
            },
          },
        ],
      });
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(
    agent.converse('Recall the saved word', makeReplyChannel().writer),
    { message: /empty assistant response/ },
  );
  const before = await agent.getTurns();
  t.is(before.length, 1);
  t.is(before[0].state, 'failed');
  await agent.shutdown();
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
  );
  t.teardown(() => revived.shutdown());
  t.deepEqual(await revived.getTurns(), before);
  t.true(
    (await revived.getHistory()).some(row =>
      String(row.content).includes('empty assistant response'),
    ),
  );
  t.is(requests, 1);
});

for (const backend of ['provider', 'hosted']) {
  test(`${backend} usage survives revival from conversation metadata without the legacy cache`, async t => {
    const f = fixture();
    const obsolete = harden({ inputTokens: 999_999, turns: 999 });
    f.store.set('floot-usage', obsolete);
    const perTurn = usageCounts({ inputTokens: 11, outputTokens: 3 });
    const config =
      backend === 'provider'
        ? {
            provider: harden({
              async chatStream() {
                return harden({ ...completed(), usage: perTurn });
              },
            }),
          }
        : {
            hostedClient: harden({
              async send() {
                const channel = makeBufferedReader();
                channel.push({ type: 'usage', ...perTurn });
                channel.push({ type: 'text-delta', text: 'Done' });
                channel.push({ type: 'end' });
                return channel.reader;
              },
            }),
          };
    const agent = await makeStreamingAgent(f.powers, undefined, config, 'Test');
    t.teardown(() => agent.shutdown());
    t.deepEqual(await agent.getUsage(), {
      ...usageCounts({}),
      turns: 0,
      incompleteTurns: 0,
    });
    await agent.converse('First', makeReplyChannel().writer);
    t.deepEqual(await agent.getUsage(), {
      ...perTurn,
      turns: 1,
      incompleteTurns: 0,
    });
    await agent.shutdown();
    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      config,
      'Test',
    );
    t.teardown(() => revived.shutdown());
    t.deepEqual(await revived.getUsage(), await agent.getUsage());
    await revived.converse('Second', makeReplyChannel().writer);
    t.deepEqual(await revived.getUsage(), {
      ...usageCounts({ inputTokens: 22, outputTokens: 6 }),
      turns: 2,
      incompleteTurns: 0,
    });
    t.is(f.store.get('floot-usage'), obsolete);
    t.false(f.accessedNames.includes('floot-usage'));
  });
}

test('archived failures remain in UI history and direct-provider context', async t => {
  t.timeout(20_000);
  const f = fixture();
  let requests = 0;
  let lastContext;
  const provider = harden({
    async chatStream(context) {
      requests += 1;
      lastContext = context;
      if (requests === 1) throw Error('Archived failure');
      return completed();
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(
    agent.converse('Preserve this failed request', makeReplyChannel().writer),
  );
  for (let index = 0; index < 290; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await agent.converse(`Later request ${index}`, makeReplyChannel().writer);
  }
  t.true(
    (await agent.getArchivedTurns()).some(
      turn => turn.input === 'Preserve this failed request',
    ),
  );
  t.true(
    (await agent.getArchivedTurnsPage()).records.some(
      turn => turn.input === 'Preserve this failed request',
    ),
  );
  t.is((await agent.getUsage()).incompleteTurns, 1);
  t.true(
    (await agent.getHistory()).some(
      message => message.content === 'Preserve this failed request',
    ),
  );
  t.true(
    lastContext.some(
      message => message.content === 'Preserve this failed request',
    ),
  );
  await agent.shutdown();
  let restoredTranscript;
  const hostedClient = harden({
    async send(input, options) {
      t.is(input, 'New hosted request');
      restoredTranscript = options.transcript;
      const channel = makeBufferedReader();
      channel.push({ type: 'text-delta', text: 'Restored' });
      channel.push({ type: 'end' });
      return channel.reader;
    },
  });
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { hostedClient },
    'Test',
  );
  t.teardown(() => revived.shutdown());
  await revived.converse('New hosted request', makeReplyChannel().writer);
  t.true(
    restoredTranscript.some(
      record => record.content === 'Preserve this failed request',
    ),
  );
  t.false(
    restoredTranscript.some(record => record.content === 'New hosted request'),
  );
});

test('direct-provider recovery hydrates full input and tool evidence, not UI previews', async t => {
  const f = fixture();
  const input = `${'i'.repeat(9000)}INPUT-TAIL`;
  const args = { text: `${'a'.repeat(9000)}ARGS-TAIL` };
  const result = `${'r'.repeat(9000)}RESULT-TAIL`;
  const contexts = [];
  const provider = harden({
    async chatStream(context) {
      contexts.push(context);
      if (contexts.length === 1)
        return harden({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'long-call',
                type: 'function',
                function: { name: 'effect', arguments: JSON.stringify(args) },
              },
            ],
          },
        });
      if (contexts.length === 2) throw Error('Failed after long effect');
      return completed();
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { provider },
    'Test',
    {
      extraTools: new Map([['effect', effectTool(async () => result)]]),
    },
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(agent.converse(input, makeReplyChannel().writer));
  await agent.converse('Continue without repeating', makeReplyChannel().writer);
  const restored = contexts[2];
  t.true(restored.some(message => message.content === input));
  t.true(
    restored.some(
      message => message.role === 'tool' && message.content === result,
    ),
  );
  const call = restored
    .flatMap(message => message.tool_calls || [])
    .find(item => item.function.name === 'effect');
  t.deepEqual(JSON.parse(call.function.arguments), args);
  t.is(
    restored.filter(message => message.content === 'Continue without repeating')
      .length,
    1,
  );
});

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
        message.content ===
        '[Floot turn failed: Provider disconnected after effect]',
    ),
  );
  t.deepEqual(
    (await agent.getTurns()).map(turn => turn.state),
    ['failed', 'completed'],
  );
  t.deepEqual(
    (await agent.getTurns())[0].usage,
    usageCounts({ inputTokens: 7, outputTokens: 3 }),
  );
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
  t.deepEqual(
    (await revived.getTurns())[0].usage,
    usageCounts({ inputTokens: 7, outputTokens: 3 }),
  );
});

test('failed hosted turn preserves reported partial usage across revival without claiming success', async t => {
  t.timeout(5000);
  const f = fixture();
  const hostedClient = harden({
    async send() {
      const channel = makeBufferedReader();
      channel.push({
        type: 'usage',
        inputTokens: 13,
        outputTokens: 5,
        cachedInputTokens: 900,
        context: { usedTokens: 918, windowTokens: 4000 },
      });
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
  const spent = usageCounts({
    inputTokens: 13,
    outputTokens: 5,
    cachedInputTokens: 900,
    context: { usedTokens: 918, windowTokens: 4000 },
  });
  t.deepEqual(turn.usage, spent);
  // The turn did not complete, but its tokens were spent and its reading is
  // the newest the session has: both are in what the session reports.
  t.deepEqual(await revived.getUsage(), {
    ...spent,
    turns: 0,
    incompleteTurns: 1,
  });
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
  t.is(inputs.length, 1);
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
  await agent.converse('Unrelated follow-up', makeReplyChannel().writer);
  t.regex(inputs[2], /Hosted effect completed/);
  t.regex(inputs[2], /outcome-unknown/);
  t.is((await agent.getTurns())[0].resolution, undefined);
  t.is(effects, 1);
  await agent.resolveTurn(
    turn.turnId,
    'Operator independently verified all hosted effects',
  );
  await agent.converse('After resolution', makeReplyChannel().writer);
  t.is(inputs[3], 'After resolution');
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

test('lost result writes poison dispatch; revival permits unrelated work without replay or resolution', async t => {
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
    async chatStream(context) {
      calls += 1;
      t.true(
        context.some(
          message =>
            message.role === 'tool' &&
            /outcome unknown; do not automatically retry/.test(message.content),
        ),
      );
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
  t.is(calls, 1);
  await revived.converse('Continue safely', makeReplyChannel().writer);
  t.is(calls, 2);
  t.is(effects, 1);
  t.is((await revived.getTurns())[0].resolution, undefined);
  await revived.resolveTurn(
    uncertain.turnId,
    'Operator verified the effect happened once',
  );
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

test('native activity without result remains unknown while unrelated later work completes', async t => {
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
      if (sends > 1) {
        channel.push({ type: 'text-delta', text: 'Unrelated answer' });
        channel.push({ type: 'end' });
        return channel.reader;
      }
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
  await agent.converse(
    'Do not blindly replay; answer an unrelated question',
    makeReplyChannel().writer,
  );
  t.is(sends, 2);
  const [prior, next] = await agent.getTurns();
  t.is(prior.state, 'outcome-unknown');
  t.is(prior.resolution, undefined);
  t.is(next.state, 'completed');
  t.deepEqual(next.activity, []);
});

test('interrupt closes hosted tool admission before backend acknowledgement and preserves admitted context', async t => {
  t.timeout(5000);
  const f = fixture();
  const barrier = () => {
    let resolve = () => {};
    const promise = new Promise(done => {
      resolve = () => done(undefined);
    });
    return harden({ promise, resolve });
  };
  const sent = barrier();
  const effectStarted = barrier();
  const finishEffect = barrier();
  const interruptStarted = barrier();
  const finishInterrupt = barrier();
  const events = makeBufferedReader();
  const controller = new AbortController();
  let turn = Promise.resolve();
  t.teardown(async () => {
    controller.abort();
    finishEffect.resolve();
    finishInterrupt.resolve();
    events.close();
    await turn;
  });
  /** @type {{ execute(name: string, args: object): Promise<string> } | undefined} */
  let tools;
  let effects = 0;
  let sends = 0;
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      provideHostedClient: async snapshot => {
        tools = snapshot;
        return harden({
          async send() {
            sends += 1;
            if (sends === 1) {
              sent.resolve();
              return events.reader;
            }
            await snapshot.execute('effect', harden({}));
            const completedEvents = makeBufferedReader();
            completedEvents.push({ type: 'text-delta', text: 'Done' });
            completedEvents.push({ type: 'end' });
            t.teardown(() => completedEvents.close());
            return completedEvents.reader;
          },
          async interrupt() {
            interruptStarted.resolve();
            await finishInterrupt.promise;
            events.close();
          },
        });
      },
    },
    'Test',
    {
      extraTools: new Map([
        [
          'effect',
          effectTool(async () => {
            effects += 1;
            effectStarted.resolve();
            await finishEffect.promise;
            return 'Effect completed';
          }),
        ],
      ]),
    },
  );
  if (!tools) throw Error('Hosted tool snapshot was not provisioned');
  const hostedTools = tools;
  await t.throwsAsync(() => hostedTools.execute('effect', harden({})), {
    message: /outside an active Floot turn/,
  });
  turn = agent.converse(
    'First turn',
    makeReplyChannel().writer,
    undefined,
    controller.signal,
  );
  await sent.promise;
  const admitted = hostedTools.execute('effect', harden({}));
  await effectStarted.promise;
  const firstTurnId = (await agent.getTurns())[0].turnId;

  controller.abort();
  // Assert before waiting for the backend interrupt callback as well as while
  // its acknowledgement is withheld. Neither window permits another effect.
  await t.throwsAsync(() => hostedTools.execute('effect', harden({})), {
    message: /outside an active Floot turn/,
  });
  await interruptStarted.promise;
  await t.throwsAsync(() => hostedTools.execute('effect', harden({})), {
    message: /outside an active Floot turn/,
  });
  t.is(effects, 1);
  t.is(f.events().filter(event => event.type === 'tool-intent').length, 1);
  finishEffect.resolve();
  t.is(await admitted, 'Effect completed');
  const result = f.events().find(event => event.type === 'tool-result');
  t.is(result.turnId, firstTurnId);
  finishInterrupt.resolve();
  await turn;
  t.is((await agent.getTurns())[0].tools[0].result, 'Effect completed');
  await t.throwsAsync(() => hostedTools.execute('effect', harden({})), {
    message: /outside an active Floot turn/,
  });

  // The same runtime/tool capability can admit calls for a subsequent turn.
  await agent.converse('Second turn', makeReplyChannel().writer);
  t.is(sends, 2);
  t.is(effects, 2);
  const [first, second] = await agent.getTurns();
  t.not(second.turnId, first.turnId);
  t.is(first.tools.length, 1);
  t.is(second.tools.length, 1);
});

test('a turn stopped before its backend sized the window keeps the size already known', async t => {
  t.timeout(5000);
  const f = fixture();
  let turn = 0;
  const hostedClient = harden({
    async send() {
      const channel = makeBufferedReader();
      turn += 1;
      if (turn === 1) {
        channel.push({
          type: 'usage',
          inputTokens: 10,
          outputTokens: 2,
          context: { usedTokens: 150_000, windowTokens: 200_000 },
        });
        channel.push({ type: 'text-delta', text: 'ok' });
        channel.push({ type: 'end' });
      } else {
        // A mid-turn reading: the request is known, the window is not yet.
        channel.push({
          type: 'usage',
          context: { usedTokens: 160_000, windowTokens: 0 },
        });
        channel.push({ type: 'abort', reason: 'stopped by the operator' });
      }
      return channel.reader;
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { hostedClient },
    'Test',
  );
  await agent.converse('first', makeReplyChannel().writer);
  await t.throwsAsync(agent.converse('second', makeReplyChannel().writer), {
    message: /stopped by the operator/,
  });
  t.deepEqual((await agent.getUsage()).context, {
    usedTokens: 160_000,
    windowTokens: 200_000,
  });
});
