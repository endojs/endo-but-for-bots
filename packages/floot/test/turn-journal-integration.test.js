// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { makeOpenRouterProvider } from '@endo/lal/providers/index.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';
import { makeTurnJournal } from '../src/turn-journal.js';
import { usageCounts } from './helpers/usage.js';

const fixture = () => {
  const store = new Map();
  let refusedType;
  let beforeStore;
  let afterStore;
  let beforeLookup;
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
      if (beforeLookup) await beforeLookup(nameOf(name));
      if (!store.has(nameOf(name))) throw Error('Not found');
      return store.get(nameOf(name));
    },
    async storeValue(value, name) {
      if (beforeStore) await beforeStore(value);
      if (value?.type === refusedType && refusedType)
        throw Error('Storage unavailable');
      if (store.has(nameOf(name))) throw Error('No overwrite');
      store.set(nameOf(name), value);
      if (afterStore) await afterStore(value);
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
    beforeStore: hook => {
      beforeStore = hook;
    },
    afterStore: hook => {
      afterStore = hook;
    },
    beforeLookup: hook => {
      beforeLookup = hook;
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

for (const fault of ['beforeStore', 'afterStore']) {
  test(`mail dispatch publication ${fault} failure prevents inference and preserves committed receipt`, async t => {
    const f = fixture();
    let requests = 0;
    const provider = harden({
      async chatStream() {
        requests += 1;
        return completed();
      },
    });
    f[fault](value => {
      if (value.type === 'dispatch')
        throw Error('Dispatch publication refused');
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      {
        kind: 'provider',
        provideProvider: () => provider,
      },
      'Test',
    );
    t.teardown(() => agent.shutdown());
    const mail = harden({ from: 'sender', messageNumber: '123' });
    await t.throwsAsync(
      agent.converse('Incoming task', makeReplyChannel().writer, { mail }),
    );
    t.is(requests, 0);
    if (fault === 'afterStore') t.deepEqual(f.events()[0].mail, mail);
    else t.deepEqual(f.events(), []);
    await agent.shutdown();
    f.beforeStore(undefined);
    f.afterStore(undefined);
    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      {
        kind: 'provider',
        provideProvider: () => provider,
      },
      'Test',
    );
    t.teardown(() => revived.shutdown());
    const turns = await revived.getTurns();
    if (fault === 'beforeStore') t.deepEqual(turns, []);
    else {
      t.is(turns.length, 1);
      t.deepEqual(turns[0].mail, mail);
      t.is(turns[0].input, 'Incoming task');
      t.is(turns[0].state, 'outcome-unknown');
    }
  });
}

test('oversized backend token is refused before successful journal settlement or acknowledgement', async t => {
  const f = fixture();
  let acknowledgements = 0;
  const hostedClient = harden({
    async send() {
      const stream = makeBufferedReader();
      stream.push({ type: 'text-delta', text: 'Done' });
      stream.push({ type: 'end', checkpoint: 'x'.repeat(8193) });
      return stream.reader;
    },
    async acknowledge() {
      acknowledgements += 1;
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'hosted', provideHostedClient: () => hostedClient },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(agent.converse('Hello', makeReplyChannel().writer), {
    message: /Invalid turn journal text/,
  });
  t.is(acknowledgements, 0);
  t.false([...f.store.keys()].some(name => name.startsWith('ct-')));
  const [turn] = await agent.getTurns();
  t.is(turn.state, 'failed');
  t.is(turn.backendCheckpoint, undefined);
});

test('cancelled hosted thinking is journaled after the interrupt barrier', async t => {
  t.timeout(5000);
  const f = fixture();
  const controller = new AbortController();
  const stream = makeBufferedReader();
  let interrupted = false;
  const hostedClient = harden({
    async send() {
      stream.push({ type: 'thinking-delta', text: 'partial reasoning' });
      return stream.reader;
    },
    async interrupt() {
      interrupted = true;
      stream.close();
    },
  });
  f.beforeStore(value => {
    if (value.type === 'presentation') t.true(interrupted);
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'hosted', provideHostedClient: () => hostedClient },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  const writer = makeReplyChannel().writer;
  await agent.converse(
    'Hello',
    harden({
      ...writer,
      thinking: event => {
        writer.thinking(event);
        controller.abort();
      },
    }),
    undefined,
    controller.signal,
  );
  await agent.shutdown();
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'hosted', provideHostedClient: () => hostedClient },
    'Test',
  );
  t.teardown(() => revived.shutdown());
  const [turn] = await revived.getTurns();
  t.is(turn.state, 'cancelled');
  t.like(JSON.parse(turn.presentation.payload)[0], {
    text: 'partial reasoning',
    beforeTranscriptOrdinal: '0',
  });
  t.false(
    JSON.stringify(await revived.getTranscript()).includes('partial reasoning'),
  );
});

for (const fault of ['none', 'beforeStore', 'afterStore', 'abort']) {
  test(`hosted thinking presentation survives journal reconstruction: ${fault}`, async t => {
    const f = fixture();
    let acknowledges = 0;
    f.beforeStore(value => {
      if (value.type === 'presentation' && fault === 'beforeStore')
        throw Error('Lost presentation');
    });
    if (fault === 'afterStore')
      f.afterStore(value => {
        if (value.type === 'presentation') throw Error('Lost presentation');
      });
    const hostedClient = harden({
      async send() {
        const stream = makeBufferedReader();
        stream.push({ type: 'thinking-delta', text: 'public reasoning' });
        stream.push(
          fault === 'abort'
            ? { type: 'abort', reason: 'provider failed' }
            : { type: 'end', checkpoint: 'native-turn-1' },
        );
        return stream.reader;
      },
      async acknowledge() {
        acknowledges += 1;
      },
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      { kind: 'hosted', provideHostedClient: () => hostedClient },
      'Test',
    );
    t.teardown(() => agent.shutdown());
    const result = agent.converse('Hello', makeReplyChannel().writer);
    if (fault === 'none') await result;
    else await t.throwsAsync(result);
    t.is(acknowledges, fault === 'none' ? 1 : 0);
    await agent.shutdown();
    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      { kind: 'hosted', provideHostedClient: () => hostedClient },
      'Test',
    );
    t.teardown(() => revived.shutdown());
    const [turn] = await revived.getTurns();
    t.false(
      JSON.stringify(await revived.getTranscript()).includes(
        'public reasoning',
      ),
    );
    if (fault === 'beforeStore') t.is(turn.presentation, undefined);
    else
      t.like(JSON.parse(turn.presentation.payload)[0], {
        text: 'public reasoning',
        beforeTranscriptOrdinal: '0',
      });
  });
}

for (const fault of ['none', 'beforeStore', 'afterStore', 'ack']) {
  test(`hosted acknowledgement follows checkpoint journal publication: ${fault}`, async t => {
    const f = fixture();
    let acknowledges = 0;
    const sent = [];
    if (fault === 'beforeStore' || fault === 'afterStore') {
      f[fault](value => {
        if (value.type === 'finish') throw Error('Lost finish');
      });
    }
    const hostedClient = harden({
      async send(_text, options) {
        sent.push(options);
        const stream = makeBufferedReader();
        stream.push({ type: 'text-delta', text: 'Done' });
        stream.push({ type: 'end', checkpoint: 'native-turn-1' });
        return stream.reader;
      },
      async acknowledge(checkpoint) {
        acknowledges += 1;
        t.is(checkpoint, 'native-turn-1');
        const finish = f.events().find(event => event.type === 'finish');
        t.is(finish.backendCheckpoint, checkpoint);
        t.is(finish.state, 'completed');
        if (fault === 'ack') throw Error('Acknowledgement transport failed');
      },
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      { kind: 'hosted', provideHostedClient: () => hostedClient },
      'Test',
    );
    t.teardown(() => agent.shutdown());
    const result = agent.converse('Hello', makeReplyChannel().writer);
    if (fault === 'beforeStore' || fault === 'afterStore') {
      await t.throwsAsync(result, { message: /uncertain storage/ });
      t.is(acknowledges, 0);
    } else {
      await result;
      t.is(acknowledges, 1);
    }
    await agent.shutdown();
    t.false(
      [...f.store.values()].some(
        value => value.metadata?.backendCheckpoint !== undefined,
      ),
    );

    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      { kind: 'hosted', provideHostedClient: () => hostedClient },
      'Test',
    );
    t.teardown(() => revived.shutdown());
    const [turn] = await revived.getTurns();
    t.is(
      turn.backendCheckpoint,
      fault === 'beforeStore' ? undefined : 'native-turn-1',
    );
    f.beforeStore(undefined);
    f.afterStore(undefined);
    await revived.converse('Continue', makeReplyChannel().writer);
    t.is(sent[0].acknowledgedCheckpoint, undefined);
    t.is(
      sent[1].acknowledgedCheckpoint,
      fault === 'beforeStore' ? undefined : 'native-turn-1',
    );
  });
}

for (const treeName of ['ct-leaf', 'ct-root', 'ct-obsolete-node']) {
  test(`existing ${treeName} refuses construction before journal or backend access without modifying state`, async t => {
    const f = fixture();
    f.store.set(treeName, harden({ obsolete: 'preserve for export' }));
    f.store.set(
      'floot-turn-event-00000000000000000001',
      harden({ malformed: true }),
    );
    const before = [...f.store.entries()];
    let requests = 0;
    let reads = 0;
    f.beforeLookup(() => {
      reads += 1;
      throw Error('Must reject tree before reading journal');
    });
    const provider = harden({
      async chatStream() {
        requests += 1;
        return completed();
      },
    });
    await t.throwsAsync(
      makeStreamingAgent(
        f.powers,
        undefined,
        {
          kind: 'provider',
          provideProvider: () => provider,
        },
        'Test',
      ),
      {
        message:
          'Legacy Floot conversation tree requires retirement or export before journal-only recovery',
      },
    );
    t.is(requests, 0);
    t.is(reads, 0);
    t.deepEqual([...f.store.entries()], before);
  });
}

test('journal checkpoint survives a later partial turn without conversation tree state', async t => {
  const f = fixture();
  const seen = [];
  const hostedClient = harden({
    async send(text, options) {
      seen.push(options.acknowledgedCheckpoint);
      const stream = makeBufferedReader();
      if (text === 'Partial') {
        stream.push({ type: 'text-delta', text: 'partial response' });
        stream.push({ type: 'abort', reason: 'provider failure' });
      } else stream.push({ type: 'end', checkpoint: 'journal-token' });
      return stream.reader;
    },
    async acknowledge() {
      return undefined;
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'hosted', provideHostedClient: () => hostedClient },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  await agent.converse('First', makeReplyChannel().writer);
  await t.throwsAsync(agent.converse('Partial', makeReplyChannel().writer), {
    message: /provider failure/,
  });
  await agent.shutdown();
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'hosted', provideHostedClient: () => hostedClient },
    'Test',
  );
  t.teardown(() => revived.shutdown());
  await revived.converse('Continue', makeReplyChannel().writer);
  t.deepEqual(seen, [undefined, 'journal-token', 'journal-token']);
  t.false([...f.store.keys()].some(name => name.startsWith('ct-')));
});

test('checkpoint recovery orders archived evidence by turn rather than publication', async t => {
  const f = fixture();
  const options = { input: 'seed', backendId: 'codex', modelId: 'luna' };
  const initial = makeTurnJournal(f.powers);
  const oldest = await initial.begin(options);
  const journal = makeTurnJournal(f.powers);
  for (let i = 0; i < 290; i += 1) {
    // Deliberately await sequential journal writes.
    // eslint-disable-next-line no-await-in-loop
    const id = await journal.begin(options);
    // eslint-disable-next-line no-await-in-loop
    await journal.append(id, {
      type: 'finish',
      state: 'completed',
      ...(i === 0 ? { backendCheckpoint: 'newer-token' } : {}),
    });
  }
  await journal.append(oldest, {
    type: 'finish',
    state: 'completed',
    backendCheckpoint: 'older-token',
  });
  for (let i = 0; i < 35; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await journal.begin(options);
    // eslint-disable-next-line no-await-in-loop
    await journal.append(id, { type: 'finish', state: 'completed' });
  }
  const archive = await journal.listArchived();
  t.true(
    /** @type {any[]} */ (archive).findIndex(turn => turn.turnId === oldest) >
      /** @type {any[]} */ (archive).findIndex(
        turn => turn.backendCheckpoint === 'newer-token',
      ),
  );
  const hostedClient = harden({
    async send(_text, config) {
      t.is(config.acknowledgedCheckpoint, 'newer-token');
      const stream = makeBufferedReader();
      stream.push({ type: 'end' });
      return stream.reader;
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'hosted', provideHostedClient: () => hostedClient },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  await agent.converse('Continue', makeReplyChannel().writer);
});

test('cancellation during transcript sealing does not commit a successful turn', async t => {
  const f = fixture();
  const abort = new AbortController();
  f.beforeStore(value => {
    if (value.type === 'transcript-complete') abort.abort();
  });
  const provider = harden({
    async chatStream() {
      return completed();
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  await agent.converse(
    'Hello',
    makeReplyChannel().writer,
    undefined,
    abort.signal,
  );
  const [turn] = await agent.getTurns();
  t.is(turn.state, 'cancelled');
  t.true(turn.transcriptComplete);
  t.is(turn.conversationNodeId, undefined);
  const before = await agent.getTranscript();
  t.is(
    before.filter(
      record => record.kind === 'message' && record.content === 'Done',
    ).length,
    1,
  );
  await agent.shutdown();
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'Test',
  );
  t.teardown(() => revived.shutdown());
  t.deepEqual(await revived.getTranscript(), before);
  t.is((await revived.getTurns())[0].state, 'cancelled');
});

test('parallel identical calls keep distinct results after partial transcript publication', async t => {
  t.timeout(5000);
  const f = fixture();
  let releaseFirst;
  const first = new Promise(resolve => {
    releaseFirst = resolve;
  });
  t.teardown(() => releaseFirst());
  f.afterStore(value => {
    if (value.type === 'tool-result' && value.result === 'Second result')
      releaseFirst();
  });
  let faulted = false;
  f.beforeStore(value => {
    if (value.type === 'transcript-record') {
      const record = JSON.parse(value.payload);
      if (record.kind === 'tool-result' && record.id === 'second') {
        faulted = true;
        throw Error('Lost second transcript result');
      }
    }
  });
  let effects = 0;
  let requests = 0;
  const provider = harden({
    async chatStream() {
      requests += 1;
      return harden({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: ['first', 'second'].map(id => ({
            ...callEffect().message.tool_calls[0],
            id,
          })),
        },
      });
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'Test',
    {
      extraTools: new Map([
        [
          'effect',
          effectTool(async () => {
            effects += 1;
            if (effects === 1) {
              await first;
              return 'First result';
            }
            return 'Second result';
          }),
        ],
      ]),
    },
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(agent.converse('Run twice', makeReplyChannel().writer), {
    message: /uncertain storage/,
  });
  t.true(faulted);
  t.is(effects, 2);
  t.is(requests, 1);
  t.deepEqual(
    f
      .events()
      .filter(event => event.type === 'tool-result')
      .map(event => event.result),
    ['Second result', 'First result'],
  );
  await agent.shutdown();
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'Test',
  );
  t.teardown(() => revived.shutdown());
  const transcript = await revived.getTranscript();
  t.is(transcript.filter(record => record.kind === 'tool-call').length, 2);
  t.deepEqual(
    transcript
      .filter(record => record.kind === 'tool-result')
      .map(record => [record.id, record.content])
      .sort(),
    [
      ['first', 'First result'],
      ['second', 'Second result'],
    ],
  );
});

for (const missingId of [false, true]) {
  test(`direct malformed arguments remain one refused call (missing id ${missingId})`, async t => {
    const f = fixture();
    let calls = 0;
    let effects = 0;
    const provider = harden({
      async chatStream() {
        calls += 1;
        if (calls !== 1) throw Error('Later provider failure');
        return harden({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                ...(missingId ? {} : { id: 'malformed' }),
                type: 'function',
                function: { name: 'effect', arguments: '{"broken":' },
              },
            ],
          },
        });
      },
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      {
        kind: 'provider',
        provideProvider: () => provider,
      },
      'Test',
      {
        extraTools: new Map([
          [
            'effect',
            effectTool(async () => {
              effects += 1;
              return 'Unexpected';
            }),
          ],
        ]),
      },
    );
    t.teardown(() => agent.shutdown());
    await t.throwsAsync(agent.converse('Try it', makeReplyChannel().writer), {
      message: /Later provider/,
    });
    const transcript = await agent.getTranscript();
    const toolCalls = transcript.filter(record => record.kind === 'tool-call');
    const results = transcript.filter(record => record.kind === 'tool-result');
    t.is(effects, 0);
    t.is(toolCalls.length, 1);
    t.is(results.length, 1);
    t.is(toolCalls[0].id, missingId ? 'floot-synth-0-0' : 'malformed');
    t.is(results[0].id, toolCalls[0].id);
    t.regex(results[0].content, /could not parse/);
    await agent.shutdown();
    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      {
        kind: 'provider',
        provideProvider: () => provider,
      },
      'Test',
    );
    t.teardown(() => revived.shutdown());
    t.deepEqual(await revived.getTranscript(), transcript);
  });
}

for (const phase of ['beforeStore', 'afterStore']) {
  for (const boundary of ['call', 'result', 'seal', 'finish']) {
    test(`direct ${boundary} ${phase} failure reconstructs its acknowledged prefix`, async t => {
      t.timeout(5000);
      const f = fixture();
      let faulted = false;
      f[phase](value => {
        const record =
          value.type === 'transcript-record'
            ? JSON.parse(value.payload)
            : undefined;
        const matches =
          boundary === 'call'
            ? record?.kind === 'tool-call'
            : boundary === 'result'
              ? record?.kind === 'tool-result'
              : boundary === 'seal'
                ? value.type === 'transcript-complete'
                : value.type === 'finish';
        if (matches && !faulted) {
          faulted = true;
          throw Error('Injected publication failure');
        }
      });
      let effects = 0;
      let calls = 0;
      const provider = harden({
        async chatStream() {
          calls += 1;
          return calls === 1 ? callEffect() : completed();
        },
      });
      const agent = await makeStreamingAgent(
        f.powers,
        undefined,
        {
          kind: 'provider',
          provideProvider: () => provider,
        },
        'Test',
        {
          extraTools: new Map([
            [
              'effect',
              effectTool(async () => {
                effects += 1;
                return 'Changed once';
              }),
            ],
          ]),
        },
      );
      t.teardown(() => agent.shutdown());
      await t.throwsAsync(
        agent.converse('Change it', makeReplyChannel().writer),
      );
      t.true(faulted);
      t.is(effects, boundary === 'call' ? 0 : 1);
      await agent.shutdown();
      const revived = await makeStreamingAgent(
        f.powers,
        undefined,
        {
          kind: 'provider',
          provideProvider: () => provider,
        },
        'Test',
      );
      t.teardown(() => revived.shutdown());
      const transcript = await revived.getTranscript();
      const toolCalls = transcript.filter(
        record => record.kind === 'tool-call',
      );
      const results = transcript.filter(
        record => record.kind === 'tool-result',
      );
      t.is(
        toolCalls.length,
        boundary === 'call' && phase === 'beforeStore' ? 0 : 1,
      );
      t.is(results.length, boundary === 'call' ? 0 : 1);
      if (results.length) t.is(results[0].content, 'Changed once');
      if (boundary === 'finish') {
        t.is(
          transcript.filter(
            record => record.kind === 'message' && record.content === 'Done',
          ).length,
          1,
        );
        t.true((await revived.getTurns())[0].transcriptComplete);
      }
      t.is(calls, boundary === 'call' || boundary === 'result' ? 1 : 2);
    });
  }
}

for (const boundary of ['transcript-record', 'tool-intent']) {
  test(`direct cancellation during ${boundary} publication refuses effects`, async t => {
    t.timeout(5000);
    const f = fixture();
    const abort = new AbortController();
    let effects = 0;
    f.beforeStore(value => {
      if (
        value.type === boundary &&
        (boundary !== 'transcript-record' ||
          JSON.parse(value.payload).kind === 'tool-call')
      )
        abort.abort();
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      {
        kind: 'provider',
        provideProvider: (
          value => () =>
            value
        )(
          harden({
            async chatStream() {
              return callEffect();
            },
          }),
        ),
      },
      'Test',
      {
        extraTools: new Map([
          [
            'effect',
            effectTool(async () => {
              effects += 1;
              return 'Changed';
            }),
          ],
        ]),
      },
    );
    t.teardown(() => agent.shutdown());
    await agent.converse(
      'Change it',
      makeReplyChannel().writer,
      undefined,
      abort.signal,
    );
    t.is(effects, 0);
    const [turn] = await agent.getTurns();
    t.is(turn.state, 'cancelled');
    t.false(turn.transcriptComplete === true);
    if (boundary === 'tool-intent') {
      t.is(turn.tools.length, 1);
      t.true(turn.tools[0].settled);
      t.regex(turn.tools[0].result, /aborted/);
    }
  });
}

test('direct dialogue prefix survives a later provider failure and reconstruction', async t => {
  const f = fixture();
  let calls = 0;
  const records = () =>
    f
      .events()
      .filter(event => event.type === 'transcript-record')
      .map(event => JSON.parse(event.payload));
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: (
        value => () =>
          value
      )(
        harden({
          async chatStream(_context, _tools, onDelta) {
            calls += 1;
            if (calls === 1)
              return harden({
                message: {
                  ...callEffect().message,
                  content: 'I will change it once.',
                },
              });
            onDelta('The change succeeded, but');
            throw Error('Disconnected');
          },
        }),
      ),
    },
    'Test',
    {
      extraTools: new Map([
        [
          'effect',
          effectTool(async () => {
            t.deepEqual(
              records().map(record => record.kind),
              ['message', 'message', 'tool-call'],
            );
            return 'Changed once';
          }),
        ],
      ]),
    },
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(agent.converse('Change it', makeReplyChannel().writer), {
    message: /Disconnected/,
  });
  t.deepEqual(
    records().map(record => record.kind),
    ['message', 'message', 'tool-call', 'tool-result', 'message'],
  );
  t.false(f.events().some(event => event.type === 'transcript-complete'));
  const before = await agent.getTranscript();
  await agent.shutdown();
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: (
        value => () =>
          value
      )(
        harden({
          async chatStream() {
            return completed();
          },
        }),
      ),
    },
    'Test',
  );
  t.teardown(() => revived.shutdown());
  t.deepEqual(await revived.getTranscript(), before);
  t.true(
    before.some(
      record =>
        record.kind === 'message' &&
        record.content === 'I will change it once.',
    ),
  );
  t.true(
    before.some(
      record =>
        record.kind === 'message' &&
        record.content === 'The change succeeded, but',
    ),
  );
  t.is(before.filter(record => record.kind === 'tool-call').length, 1);
  t.is(before.filter(record => record.kind === 'tool-result').length, 1);
});

test('direct provider refuses effects when its dialogue cannot be journaled', async t => {
  const f = fixture();
  let effects = 0;
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: (
        value => () =>
          value
      )(
        harden({
          async chatStream() {
            f.refuse('transcript-record');
            return callEffect();
          },
        }),
      ),
    },
    'Test',
    {
      extraTools: new Map([
        [
          'effect',
          effectTool(async () => {
            effects += 1;
            return 'Changed';
          }),
        ],
      ]),
    },
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(agent.converse('Change it', makeReplyChannel().writer), {
    message: /uncertain storage/,
  });
  t.is(effects, 0);
  t.false(f.events().some(event => event.type === 'tool-intent'));
});

test('recorded compaction survives reconstruction into direct-provider context', async t => {
  t.timeout(10_000);
  const f = fixture();
  const hostedClient = harden({
    async send() {
      const channel = makeBufferedReader();
      channel.push({ type: 'text-delta', text: 'superseded answer' });
      channel.push({
        type: 'compaction',
        summary: 'retained summary',
        retainedTail: [
          { kind: 'message', role: 'user', content: 'tail request' },
          { kind: 'tool-call', id: 'old-call', name: 'read', args: '{}' },
          {
            kind: 'tool-result',
            id: 'old-call',
            content: '[Old tool result content cleared]',
          },
        ],
      });
      channel.push({ type: 'text-delta', text: 'after boundary' });
      channel.push({ type: 'end' });
      return channel.reader;
    },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'hosted', provideHostedClient: () => hostedClient },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  await agent.converse('superseded request', makeReplyChannel().writer);
  const transcript = await agent.getTranscript();
  t.true(transcript.some(record => record.kind === 'compaction'));
  t.false(
    (await agent.getHistory()).some(row => row.content === 'tail request'),
  );
  t.deepEqual((await agent.getTurns())[0].tools, []);
  t.deepEqual((await agent.getTurns())[0].activity, []);
  await agent.shutdown();
  const contexts = [];
  const provider = harden({
    async chatStream(context) {
      contexts.push(context);
      return completed();
    },
  });
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'Test',
  );
  t.teardown(() => revived.shutdown());
  t.deepEqual(await revived.getTranscript(), transcript);
  await revived.converse('continue now', makeReplyChannel().writer);
  const replay = contexts[0].filter(message => message.role !== 'system');
  t.deepEqual(replay, [
    { role: 'assistant', content: 'retained summary' },
    { role: 'user', content: 'tail request' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'floot-history-2',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'floot-history-2',
      content: '[Old tool result content cleared]',
    },
    { role: 'assistant', content: 'after boundary' },
    { role: 'user', content: 'continue now' },
  ]);
  t.deepEqual(
    (await revived.getTranscript()).slice(0, transcript.length),
    transcript,
  );
});

for (const failure of ['empty', 'HTTP 503']) {
  test(`OpenRouter ${failure} remains a failed turn with usage after reconstruction`, async t => {
    t.timeout(10_000);
    const f = fixture();
    let requests = 0;
    const provider = makeOpenRouterProvider({
      apiKey: 'test-not-a-key',
      model: 'openrouter/free',
      fetchImpl: async url => {
        if (String(url).endsWith('/models')) return Response.json({ data: [] });
        requests += 1;
        return Response.json(
          {
            usage: { prompt_tokens: 10, completion_tokens: 3 },
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '',
                },
              },
            ],
          },
          { status: failure === 'empty' ? 200 : 503 },
        );
      },
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      {
        kind: 'provider',
        provideProvider: () => provider,
      },
      'Test',
    );
    t.teardown(() => agent.shutdown());
    await t.throwsAsync(
      agent.converse('Recall the saved word', makeReplyChannel().writer),
      {
        message: failure === 'empty' ? /empty assistant response/ : /HTTP 503/,
      },
    );
    const before = await agent.getTurns();
    t.is(before.length, 1);
    t.is(before[0].state, 'failed');
    t.is(before[0].usage.inputTokens, 10);
    t.is(before[0].usage.outputTokens, 3);
    const usage = await agent.getUsage();
    t.is(usage.inputTokens, 10);
    t.is(usage.outputTokens, 3);
    t.is(usage.turns, 0);
    await agent.shutdown();
    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      {
        kind: 'provider',
        provideProvider: () => provider,
      },
      'Test',
    );
    t.teardown(() => revived.shutdown());
    t.deepEqual(await revived.getTurns(), before);
    t.deepEqual(await revived.getUsage(), usage);
    t.true(
      (await revived.getHistory()).some(row =>
        String(row.content).includes(
          failure === 'empty' ? 'empty assistant response' : 'HTTP 503',
        ),
      ),
    );
    t.is(requests, 1);
  });
}

test('provider usage notifications and returned totals are not double counted', async t => {
  const f = fixture();
  const roundUsage = usageCounts({ inputTokens: 11, outputTokens: 3 });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: (
        value => () =>
          value
      )({
        async chatStream(_messages, _tools, _onToken, _signal, onUsage) {
          onUsage?.(usageCounts({ inputTokens: 5, outputTokens: 1 }));
          onUsage?.(usageCounts({ inputTokens: 6, outputTokens: 2 }));
          return {
            message: { role: 'assistant', content: 'Done' },
            usage: roundUsage,
          };
        },
      }),
    },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  await agent.converse('Hello', makeReplyChannel().writer);
  t.is((await agent.getUsage()).inputTokens, 11);
  t.is((await agent.getUsage()).outputTokens, 3);
});

test('usage context follows dispatch order across late archive publication', async t => {
  const f = fixture();
  const options = { input: 'seed', backendId: 'provider', modelId: 'free' };
  const old = await makeTurnJournal(f.powers).begin(options);
  const journal = makeTurnJournal(f.powers);
  for (let i = 0; i < 290; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await journal.begin(options);
    // eslint-disable-next-line no-await-in-loop
    await journal.append(id, {
      type: 'finish',
      state: i === 1 ? 'failed' : 'completed',
      usage: {
        inputTokens: 1,
        ...(i === 0 ? { context: { usedTokens: 20, windowTokens: 1000 } } : {}),
        ...(i === 1 ? { context: { usedTokens: 30, windowTokens: 0 } } : {}),
      },
    });
  }
  await journal.append(old, {
    type: 'finish',
    state: 'outcome-unknown',
    usage: { inputTokens: 7, context: { usedTokens: 10, windowTokens: 100 } },
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: (
        value => () =>
          value
      )(harden({ chatStream: async () => completed() })),
    },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  f.beforeLookup(name => {
    if (name.startsWith('ct-')) throw Error('Usage must not read tree');
  });
  t.deepEqual(await agent.getUsage(), {
    ...usageCounts({ inputTokens: 297 }),
    turns: 289,
    incompleteTurns: 2,
    context: { usedTokens: 30, windowTokens: 1000 },
  });
  f.beforeLookup(undefined);
  await agent.resolveTurn(old, 'Known recovered outcome');
  for (let i = 0; i < 35; i += 1) {
    // Use the actual agent writer so the original journal incarnation owns
    // every subsequent publication and archive cache update.
    // eslint-disable-next-line no-await-in-loop
    await agent.converse('Later', makeReplyChannel().writer);
  }
  t.deepEqual((await agent.getUsage()).context, {
    usedTokens: 30,
    windowTokens: 1000,
  });
  t.is((await agent.getUsage()).inputTokens, 297);
});

for (const backend of ['provider', 'hosted']) {
  for (const fault of ['before-finish', 'after-finish']) {
    test(`${backend} journal finish alone controls usage accounting: ${fault}`, async t => {
      const f = fixture();
      const perTurn = usageCounts({ inputTokens: 11, outputTokens: 3 });
      const config =
        backend === 'provider'
          ? {
              kind: 'provider',
              provideProvider: (
                value => () =>
                  value
              )(
                harden({
                  chatStream: async () =>
                    harden({ ...completed(), usage: perTurn }),
                }),
              ),
            }
          : {
              kind: 'hosted',
              provideHostedClient: () =>
                harden({
                  async send() {
                    const channel = makeBufferedReader();
                    channel.push({ type: 'usage', ...perTurn });
                    channel.push({ type: 'end' });
                    return channel.reader;
                  },
                }),
            };
      f.beforeStore(value => {
        if (fault === 'before-finish' && value.type === 'finish')
          throw Error('Refused write');
      });
      f.afterStore(value => {
        if (fault === 'after-finish' && value.type === 'finish')
          throw Error('Lost reply');
      });
      const agent = await makeStreamingAgent(
        f.powers,
        undefined,
        config,
        'Test',
      );
      t.teardown(() => agent.shutdown());
      await t.throwsAsync(agent.converse('Go', makeReplyChannel().writer));
      await agent.shutdown();
      f.beforeStore(undefined);
      f.afterStore(undefined);
      const revived = await makeStreamingAgent(
        f.powers,
        undefined,
        config,
        'Test',
      );
      t.teardown(() => revived.shutdown());
      t.deepEqual(await revived.getUsage(), {
        ...(fault === 'before-finish' ? usageCounts({}) : perTurn),
        turns: fault === 'after-finish' ? 1 : 0,
        incompleteTurns: 0,
      });
    });
  }
}

test('usage projection failure cannot undo successful journal settlement', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  for (let i = 0; i < 290; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await journal.begin({
      input: 'seed',
      backendId: 'provider',
      modelId: 'free',
    });
    // eslint-disable-next-line no-await-in-loop
    await journal.append(id, { type: 'finish', state: 'completed' });
  }
  let refuse = false;
  f.afterStore(value => {
    if (value.type === 'finish') refuse = true;
  });
  f.beforeLookup(name => {
    if (refuse && name.startsWith('floot-turn-archive-'))
      throw Error('Totals unavailable');
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: (
        value => () =>
          value
      )(
        harden({
          chatStream: async () =>
            harden({ ...completed(), usage: usageCounts({ inputTokens: 11 }) }),
        }),
      ),
    },
    'Test',
  );
  t.teardown(() => agent.shutdown());
  let updates = 0;
  await agent.converse(
    'Go',
    harden({
      ...makeReplyChannel().writer,
      usage: () => {
        updates += 1;
      },
    }),
  );
  t.is(updates, 0);
  t.is((await agent.getTurns()).at(-1).state, 'completed');
  refuse = false;
  t.is((await agent.getUsage()).inputTokens, 11);
  t.is((await agent.getUsage()).turns, 291);
});

for (const backend of ['provider', 'hosted']) {
  test(`${backend} usage survives journal-only revival and ignores obsolete usage cache`, async t => {
    const f = fixture();
    const obsolete = harden({ inputTokens: 999_999, turns: 999 });
    f.store.set('floot-usage', obsolete);
    const perTurn = usageCounts({ inputTokens: 11, outputTokens: 3 });
    const config =
      backend === 'provider'
        ? {
            kind: 'provider',
            provideProvider: (
              value => () =>
                value
            )(
              harden({
                async chatStream() {
                  return harden({ ...completed(), usage: perTurn });
                },
              }),
            ),
          }
        : {
            kind: 'hosted',
            provideHostedClient: () =>
              harden({
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
    t.false(
      [...f.store.values()].some(
        value => value.metadata?.usageTotals !== undefined,
      ),
    );
    t.false([...f.store.keys()].some(name => name.startsWith('ct-')));
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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
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
    { kind: 'hosted', provideHostedClient: () => hostedClient },
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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
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
    { kind: 'hosted', provideHostedClient: () => hostedClient },
    'Test',
  );
  await t.throwsAsync(
    agent.converse('Metered attempt', makeReplyChannel().writer),
    { message: /Provider failed after metered work/ },
  );
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'hosted', provideHostedClient: () => hostedClient },
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
      kind: 'hosted',
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
      kind: 'hosted',
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

test('failed mail turns restore journaled receipt and tool evidence after revival', async t => {
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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
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

test('repeated typed receipt hides only duplicate display input, not new admission or effects', async t => {
  const f = fixture();
  const inputs = [
    'First typed request',
    `Second full input ${'detail '.repeat(2000)}TAIL`,
  ];
  const contexts = [];
  let effects = 0;
  const provider = harden({
    async chatStream(context) {
      contexts.push(context);
      if (contexts.length === 1 || contexts.length === 3) return callEffect();
      if (contexts.length === 4)
        throw Error('Second attempt failed after effect');
      return harden({
        message: { role: 'assistant', content: 'First attempt completed' },
      });
    },
  });
  const extraTools = new Map([
    [
      'effect',
      effectTool(async () => {
        effects += 1;
        return `Explicit attempt effect ${effects}`;
      }),
    ],
  ]);
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'Test',
    { extraTools },
  );
  t.teardown(() => agent.shutdown());
  const meta = harden({
    mail: { messageNumber: 'same-receipt', from: 'sender' },
  });
  await agent.converse(inputs[0], makeReplyChannel().writer, meta);
  await t.throwsAsync(
    agent.converse(inputs[1], makeReplyChannel().writer, meta),
    { message: /Second attempt failed/ },
  );
  t.is(effects, 2);
  t.is(contexts.length, 4);
  t.is(
    contexts[0].filter(message => message.role === 'user').at(-1).content,
    inputs[0],
  );
  t.is(
    contexts[2].filter(message => message.role === 'user').at(-1).content,
    inputs[1],
  );
  const history = await agent.getHistory();
  t.deepEqual(
    history.filter(row => row.role === 'user').map(row => row.content),
    [inputs[0]],
  );
  t.true(history.some(row => row.content === 'First attempt completed'));
  t.true(
    history.some(
      row => row.content === 'Turn failed: Second attempt failed after effect',
    ),
  );
  t.deepEqual(
    history.filter(row => row.result).map(row => row.result),
    ['Explicit attempt effect 1', 'Explicit attempt effect 2'],
  );
  t.deepEqual(
    (await agent.getTurns()).map(turn => turn.state),
    ['completed', 'failed'],
  );
  t.false([...f.store.keys()].some(name => name.startsWith('ct-')));
  await agent.shutdown();
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'Test',
    { extraTools },
  );
  t.teardown(() => revived.shutdown());
  t.deepEqual(await revived.getHistory(), history);
  t.deepEqual(
    (await revived.getTranscript())
      .filter(row => row.kind === 'message' && row.role === 'user')
      .map(row => row.content),
    inputs,
  );
  t.is(effects, 2);
  t.is(contexts.length, 4);
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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
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
    {
      kind: 'provider',
      provideProvider: () => safeProvider,
    },
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
    {
      kind: 'provider',
      provideProvider: (
        value => () =>
          value
      )(harden({ chatStream: async () => callEffect() })),
    },
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
    ['dispatch', 'transcript-record', 'transcript-record'],
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
    { kind: 'hosted', provideHostedClient: () => hostedClient },
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
      kind: 'hosted',
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
    { kind: 'hosted', provideHostedClient: () => hostedClient },
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
