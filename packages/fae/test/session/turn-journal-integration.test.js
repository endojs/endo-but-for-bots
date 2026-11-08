// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makeOpenRouterProvider } from '@endo/lal/providers/index.js';
import { Far } from '@endo/far';
// eslint-disable-next-line import/no-relative-packages
import { makeSubscriptionResponsesProvider } from '../../../lal/providers/subscription-responses.js';

import { makeStreamingAgent } from '../../session-factory.js';
import { makeReplyChannel } from '../../session/stream.js';
import {
  UNKNOWN_TOOL_OUTCOME,
  UNSETTLED_TOOL_RESULT,
} from '../../session/turn-evidence.js';
import { makeTurnJournal } from '../../session/turn-journal.js';
import { readContextTranscript } from '../../session/context-transcript.js';
import { usageCounts } from './helpers/usage.js';

/** @import { RuntimeConfig } from '../../session/runtime-config.js' */

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
  test(`provider dispatch intent ${fault} failure refuses send and revival follows durable dispatch evidence`, async t => {
    t.timeout(5000);
    const f = fixture();
    let sends = 0;

    const provider = harden({
      async chatStream() {
        sends += 1;
        return completed();
      },
    });
    /** @type {RuntimeConfig} */
    const runtime = { kind: 'provider', provideProvider: () => provider };
    f[fault](event => {
      if (event.type === 'dispatch-intent') throw Error('Marker unavailable');
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      runtime,
      'Test',
      { journalPowers: f.powers },
    );
    t.teardown(() => agent.shutdown());
    await t.throwsAsync(
      agent.converse('uncertain input', makeReplyChannel().writer),
    );
    t.is(sends, 0);
    t.is(
      f.events().some(event => event.type === 'dispatch-intent'),
      fault === 'afterStore',
    );
    await agent.shutdown();
    f.beforeStore(undefined);
    f.afterStore(undefined);
    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      runtime,
      'Test',
      { journalPowers: f.powers },
    );
    t.teardown(() => revived.shutdown());
    const [turn] = await revived.getTurns();
    t.is(
      turn.dispatchState,
      fault === 'afterStore' ? 'possibly-dispatched' : 'not-dispatched',
    );
    t.is(turn.state, fault === 'afterStore' ? 'outcome-unknown' : 'cancelled');
    t.is(sends, 0, 'revival never replays the uncertain input');
    const context = await readContextTranscript(makeTurnJournal(f.powers));
    t.is(
      context.some(row => row.content === 'uncertain input'),
      fault === 'afterStore',
      'a persisted marker retains uncertain input rather than claiming non-dispatch',
    );
  });
}

for (const fault of ['beforeStore', 'afterStore']) {
  test(`mail begin publication ${fault} failure prevents inference and preserves committed receipt`, async t => {
    const f = fixture();
    let requests = 0;
    const provider = harden({
      async chatStream() {
        requests += 1;
        return completed();
      },
    });
    f[fault](value => {
      if (value.type === 'begin') throw Error('Begin publication refused');
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      {
        kind: 'provider',
        provideProvider: () => provider,
      },
      'Test',
      { journalPowers: f.powers },
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
      { journalPowers: f.powers },
    );
    t.teardown(() => revived.shutdown());
    const turns = await revived.getTurns();
    if (fault === 'beforeStore') t.deepEqual(turns, []);
    else {
      t.is(turns.length, 1);
      t.deepEqual(turns[0].mail, mail);
      t.is(turns[0].input, 'Incoming task');
      t.is(turns[0].state, 'cancelled');
      t.is(turns[0].dispatchState, 'not-dispatched');
      t.is(requests, 0, 'automatic repair never dispatches the mail');
    }
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
        { journalPowers: f.powers },
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
    { journalPowers: f.powers },
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
    { journalPowers: f.powers },
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
      journalPowers: f.powers,
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
    { journalPowers: f.powers },
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

test('restart associates an out-of-order settled effect with its exact request when an identical peer loses its result', async t => {
  const f = fixture();
  let releaseFirst;
  const first = new Promise(resolve => {
    releaseFirst = resolve;
  });
  t.teardown(() => releaseFirst());
  f.afterStore(event => {
    if (event.type === 'tool-result' && event.result === 'second')
      releaseFirst();
  });
  f.beforeStore(event => {
    if (event.type === 'tool-result' && event.result === 'first')
      throw Error('interrupted before recording first outcome');
  });
  const replies = harden({
    chatStream: async () =>
      harden({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: ['wire-A', 'wire-B'].map(id => ({
            ...callEffect().message.tool_calls[0],
            id,
          })),
        },
      }),
  });
  let invoked = 0;
  const runtime = {
    kind: /** @type {const} */ ('provider'),
    provideProvider: () => replies,
  };
  const agent = await makeStreamingAgent(f.powers, undefined, runtime, 'test', {
    journalPowers: f.powers,
    extraTools: new Map([
      [
        'effect',
        effectTool(async () => {
          invoked += 1;
          if (invoked === 1) {
            await first;
            return 'first';
          }
          return 'second';
        }),
      ],
    ]),
  });
  const live = [];
  const writer = makeReplyChannel().writer;
  await t.throwsAsync(
    agent.converse(
      'Run both',
      harden({
        ...writer,
        toolCall: event => {
          live.push(event.id);
          writer.toolCall(event);
        },
      }),
    ),
    { message: /uncertain storage/ },
  );
  await agent.shutdown();
  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    runtime,
    'test',
    { journalPowers: f.powers },
  );
  t.teardown(() => revived.shutdown());
  const [turn] = await revived.getTurns();
  t.deepEqual(
    turn.tools.map(tool => tool.callId),
    live,
  );
  t.is(new Set(live).size, 2);
  const history = (await revived.getHistory()).filter(
    msg => msg.role === 'tool',
  );
  t.deepEqual(
    history.map(row => row.id),
    live,
  );
  t.not(history[0].result, 'second');
  t.is(history[1].result, 'second');
  const transcript = await revived.getTranscript();
  t.deepEqual(
    transcript.filter(row => row.kind === 'tool-call').map(row => row.id),
    ['wire-A', 'wire-B'],
  );
  t.deepEqual(
    transcript
      .filter(row => row.kind === 'tool-result')
      .map(row => [row.id, row.content]),
    [['wire-B', 'second']],
  );
  t.is(invoked, 2);
});

for (const text of [UNKNOWN_TOOL_OUTCOME, UNSETTLED_TOOL_RESULT]) {
  test(`a successful tool returning historical placeholder text stays settled on restart: ${text}`, async t => {
    const f = fixture();
    let rounds = 0;
    const provider = harden({
      chatStream: async () => {
        rounds += 1;
        return rounds === 1 ? callEffect() : completed();
      },
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      { kind: 'provider', provideProvider: () => provider },
      'test',
      {
        journalPowers: f.powers,
        extraTools: new Map([['effect', effectTool(async () => text)]]),
      },
    );
    await agent.converse('run effect', makeReplyChannel().writer);
    await agent.shutdown();
    let observed;
    const later = harden({
      chatStream: async messages => {
        observed = messages.find(row => row.role === 'tool');
        return completed();
      },
    });
    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      { kind: 'provider', provideProvider: () => later },
      'test',
      { journalPowers: f.powers },
    );
    t.teardown(() => revived.shutdown());
    const row = (await revived.getHistory()).find(
      message => message.role === 'tool',
    );
    t.like(row, { result: text, failed: false });
    await revived.converse('continue', makeReplyChannel().writer);
    t.like(observed, { content: text, failed: false });
    if (!observed) throw Error('Missing replayed tool result');
    t.false(Object.hasOwn(observed, 'outcomeUnknown'));
  });
}

test('duplicate provider IDs within one response refuse tool effects', async t => {
  const f = fixture();
  const request = callEffect().message.tool_calls[0];
  const provider = harden({
    chatStream: async () =>
      harden({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [request, request],
        },
      }),
  });
  let effects = 0;
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'provider', provideProvider: () => provider },
    'test',
    {
      journalPowers: f.powers,
      extraTools: new Map([
        [
          'effect',
          effectTool(async () => {
            effects += 1;
            return 'ran';
          }),
        ],
      ]),
    },
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(agent.converse('Run', makeReplyChannel().writer), {
    message: /duplicate tool call ID/,
  });
  t.is(effects, 0);
  t.false(f.events().some(event => event.type === 'tool-intent'));
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
        journalPowers: f.powers,
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
      { journalPowers: f.powers },
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
          journalPowers: f.powers,
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
        { journalPowers: f.powers },
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

for (const hook of ['beforeStore', 'afterStore']) {
  test(`provider cancellation while initial transcript ${hook} awaits acknowledgement refuses inference`, async t => {
    t.timeout(5000);
    const f = fixture();
    const controller = new AbortController();
    let sends = 0;
    let entered = () => {};
    const entering = new Promise(resolve => {
      entered = () => resolve(undefined);
    });
    let release = () => {};
    const held = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    t.teardown(release);
    f[hook](async event => {
      if (event.type === 'transcript-record' && event.ordinal === '0') {
        t.is(JSON.parse(event.payload).role, 'user');
        entered();
        await held;
      }
    });
    const provider = harden({
      async chatStream() {
        sends += 1;
        return completed();
      },
    });
    const agent = await makeStreamingAgent(
      f.powers,
      undefined,
      { kind: 'provider', provideProvider: () => provider },
      'Test',
      { journalPowers: f.powers },
    );
    t.teardown(() => agent.shutdown());
    const turn = agent.converse(
      'cancel before inference',
      makeReplyChannel().writer,
      undefined,
      controller.signal,
    );
    await entering;
    t.true(f.events().some(event => event.type === 'dispatch-intent'));
    controller.abort();
    t.is(sends, 0);
    release();
    await turn;
    t.is(
      sends,
      0,
      'late transcript acknowledgement must not invoke the provider',
    );
    const [record] = await agent.getTurns();
    t.is(record.dispatchState, 'possibly-dispatched');
    t.is(record.state, 'cancelled');
    t.false(record.transcriptComplete === true);
    t.false(
      f
        .events()
        .some(event => event.type === 'finish' && event.state === 'completed'),
    );
  });
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
        journalPowers: f.powers,
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
      journalPowers: f.powers,
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
    { journalPowers: f.powers },
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
      journalPowers: f.powers,
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
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin({
    input: 'superseded request',
    backendId: 'fae-codex',
    modelId: 'test',
  });
  await journal.dispatch(id);
  await journal.recordTranscript(id, '0', {
    kind: 'compaction',
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
  await journal.recordTranscript(id, '1', {
    kind: 'message',
    role: 'assistant',
    content: 'after boundary',
  });
  await journal.completeTranscript(id, '2');
  await journal.append(id, { type: 'finish', state: 'completed' });
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
    { journalPowers: f.powers },
  );
  t.teardown(() => revived.shutdown());
  const transcript = await revived.getTranscript();
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

test('Responses overload after metadata retries without repeating a completed tool', async t => {
  t.timeout(5000);
  const f = fixture();
  const requests = [];
  const delays = [];
  let effects = 0;
  let revocations = 0;
  const call = id => ({
    type: 'function_call',
    id: `item-${id}`,
    call_id: id,
    name: 'effect',
    arguments: '{}',
    status: 'completed',
  });
  const completion = output => ({
    type: 'response.completed',
    response: { status: 'completed', output },
  });
  const attempts = [
    [completion([call('committed')])],
    [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: call('discarded'),
      },
      {
        type: 'response.reasoning_summary_text.delta',
        delta: 'Private partial reasoning',
      },
      {
        type: 'response.function_call_arguments.delta',
        delta: '{}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: call('discarded'),
      },
      {
        type: 'response.metadata',
        response_id: 'private-response-id',
        metadata: { private: 'not published' },
      },
      {
        type: 'error',
        error: {
          code: 'server_is_overloaded',
          type: 'service_unavailable_error',
        },
      },
    ],
    [
      completion([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done' }],
        },
      ]),
    ],
  ];
  const provider = makeSubscriptionResponsesProvider({
    model: 'test-luna',
    sessionId: 'overload-with-committed-tool',
    sleep: async ms => {
      delays.push(ms);
    },
    subscription: Far('RetrySubscription', {
      describe: () => harden({ models: ['test-luna'] }),
      openEndpoint: () =>
        Far('RetryEndpoint', {
          requestByteStream: request => {
            const events = attempts[requests.length];
            if (!events) throw Error('Unexpected extra inference');
            requests.push(JSON.parse(request.body));
            const bytes = new TextEncoder().encode(
              events
                .map(event => `data: ${JSON.stringify(event)}\n\n`)
                .join(''),
            );
            return harden({
              status: 200,
              contentType: 'text/event-stream',
              reader: bytesReaderFromIterator([bytes][Symbol.iterator]()),
            });
          },
          revoke: () => {
            revocations += 1;
          },
        }),
    }),
  });
  const agent = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'provider', provideProvider: () => provider },
    'Test',
    {
      journalPowers: f.powers,
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
  await agent.converse('Implement and validate', makeReplyChannel().writer);
  t.is(effects, 1);
  t.is(requests.length, 3);
  t.is(revocations, 3);
  t.deepEqual(delays, [5000]);
  t.deepEqual(requests[1], requests[2]);
  t.true(
    requests[2].input.some(
      item =>
        item.type === 'function_call_output' &&
        item.call_id === 'committed' &&
        item.output === 'Changed once',
    ),
  );
  const [turn] = await agent.getTurns();
  t.is(turn.state, 'completed');
  t.is(turn.tools.length, 1);
  t.true(turn.tools[0].settled);
  t.false(JSON.stringify(await agent.getHistory()).includes('discarded'));
});

for (const event of [
  { type: 'error', code: 'invalid_encrypted_content' },
  {
    type: 'response.failed',
    response: { error: { code: 'server_error' } },
  },
  {
    type: 'response.incomplete',
    response: { incomplete_details: { reason: 'max_output_tokens' } },
  },
]) {
  test(`Responses ${event.type} details remain durable without replay`, async t => {
    t.timeout(10_000);
    const f = fixture();
    let requests = 0;
    let revoked = 0;
    const provideProvider = () =>
      makeSubscriptionResponsesProvider({
        model: 'test-luna',
        sessionId: 'durable-error-test',
        subscription: Far('TestSubscription', {
          describe: async () => harden({ models: ['test-luna'] }),
          openEndpoint: async () =>
            Far('TestEndpoint', {
              requestByteStream: async () => {
                requests += 1;
                const bytes = new TextEncoder().encode(
                  `data: ${JSON.stringify({ ...event, message: 'PRIVATE_PROMPT' })}\n\n`,
                );
                return harden({
                  status: 200,
                  contentType: 'text/event-stream',
                  reader: bytesReaderFromIterator([bytes][Symbol.iterator]()),
                });
              },
              revoke: async () => {
                revoked += 1;
              },
            }),
        }),
      });
    /** @type {RuntimeConfig} */
    const spec = { kind: 'provider', provideProvider };
    const agent = await makeStreamingAgent(f.powers, undefined, spec, 'Test', {
      journalPowers: f.powers,
    });
    t.teardown(() => agent.shutdown());
    const error = await t.throwsAsync(
      agent.converse('Do the work', makeReplyChannel().writer),
      { message: /Subscription inference ended unsuccessfully/ },
    );
    const before = await agent.getTurns();
    t.is(before[0].state, 'failed');
    t.is(before[0].error, error.message);
    t.regex(
      before[0].error,
      /code=invalid_encrypted_content|code=server_error|reason=max_output_tokens/,
    );
    t.false(before[0].error.includes('PRIVATE_PROMPT'));
    await agent.shutdown();
    const revived = await makeStreamingAgent(
      f.powers,
      undefined,
      spec,
      'Test',
      {
        journalPowers: f.powers,
      },
    );
    t.teardown(() => revived.shutdown());
    t.deepEqual(await revived.getTurns(), before);
    t.true(
      (await revived.getHistory()).some(row =>
        String(row.content).includes(error.message),
      ),
    );
    t.is(requests, 1);
    t.is(revoked, 1);
  });
}

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
      { journalPowers: f.powers },
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
      { journalPowers: f.powers },
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
    { journalPowers: f.powers },
  );
  t.teardown(() => agent.shutdown());
  await agent.converse('Hello', makeReplyChannel().writer);
  t.is((await agent.getUsage()).inputTokens, 11);
  t.is((await agent.getUsage()).outputTokens, 3);
});

test('usage context follows dispatch order across late archive publication', async t => {
  const f = fixture();
  const options = { input: 'seed', backendId: 'provider', modelId: 'free' };
  const initial = makeTurnJournal(f.powers);
  const old = await initial.begin(options);
  await initial.dispatch(old);
  const journal = makeTurnJournal(f.powers);
  for (let i = 0; i < 290; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await journal.begin(options);
    // eslint-disable-next-line no-await-in-loop
    await journal.dispatch(id);
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
    { journalPowers: f.powers },
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

for (const fault of ['before-finish', 'after-finish']) {
  test(`provider journal finish alone controls usage accounting: ${fault}`, async t => {
    const f = fixture();
    const perTurn = usageCounts({ inputTokens: 11, outputTokens: 3 });
    /** @type {RuntimeConfig} */
    const config = {
      kind: 'provider',
      provideProvider: () =>
        harden({
          chatStream: async () => harden({ ...completed(), usage: perTurn }),
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
      { journalPowers: f.powers },
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
      { journalPowers: f.powers },
    );
    t.teardown(() => revived.shutdown());
    t.deepEqual(await revived.getUsage(), {
      ...(fault === 'before-finish' ? usageCounts({}) : perTurn),
      turns: fault === 'after-finish' ? 1 : 0,
      incompleteTurns: 0,
    });
  });
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
    await journal.dispatch(id);
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
    { journalPowers: f.powers },
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
  const lastTurn = (await agent.getTurns()).at(-1);
  if (!lastTurn) throw Error('Expected the completed turn');
  t.is(lastTurn.state, 'completed');
  refuse = false;
  t.is((await agent.getUsage()).inputTokens, 11);
  t.is((await agent.getUsage()).turns, 291);
});

test(`provider usage survives journal-only revival and ignores obsolete usage cache`, async t => {
  const f = fixture();
  const obsolete = harden({ inputTokens: 999_999, turns: 999 });
  f.store.set('floot-usage', obsolete);
  const perTurn = usageCounts({ inputTokens: 11, outputTokens: 3 });
  /** @type {RuntimeConfig} */
  const config = {
    kind: 'provider',
    provideProvider: () =>
      harden({
        chatStream: async () => harden({ ...completed(), usage: perTurn }),
      }),
  };
  const agent = await makeStreamingAgent(f.powers, undefined, config, 'Test', {
    journalPowers: f.powers,
  });
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
    { journalPowers: f.powers },
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

test('archived failures remain in UI history and direct-provider context', async t => {
  t.timeout(20_000);
  const f = fixture();
  let requests = 0;
  /** @type {{lastContext: {content?: string}[] | undefined}} */
  const observed = { lastContext: undefined };
  const provider = harden({
    async chatStream(context) {
      requests += 1;
      observed.lastContext = context;
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
    { journalPowers: f.powers },
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
  if (!observed.lastContext) throw Error('Expected the provider context');
  t.true(
    observed.lastContext.some(
      message => message.content === 'Preserve this failed request',
    ),
  );
  await agent.shutdown();

  const revived = await makeStreamingAgent(
    f.powers,
    undefined,
    { kind: 'provider', provideProvider: () => provider },
    'Test',
    { journalPowers: f.powers },
  );
  t.teardown(() => revived.shutdown());
  await revived.converse('New direct request', makeReplyChannel().writer);
  t.true(
    observed.lastContext.some(
      message => message.content === 'Preserve this failed request',
    ),
  );
  t.is(
    observed.lastContext.filter(
      message => message.content === 'New direct request',
    ).length,
    1,
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
      journalPowers: f.powers,
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
    { journalPowers: f.powers, extraTools },
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
    { journalPowers: f.powers, extraTools },
  );
  t.deepEqual(await revived.getHistory(), await agent.getHistory());
  t.deepEqual(
    (await revived.getTurns())[0].usage,
    usageCounts({ inputTokens: 7, outputTokens: 3 }),
  );
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
    { journalPowers: f.powers, extraTools },
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
    { journalPowers: f.powers, extraTools },
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
    { journalPowers: f.powers, extraTools },
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
    { journalPowers: f.powers, extraTools },
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
    { journalPowers: f.powers, extraTools },
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
    { journalPowers: f.powers, extraTools },
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
    { journalPowers: f.powers, extraTools },
  );
  await t.throwsAsync(
    agent.converse('Do not execute without intent', makeReplyChannel().writer),
    { message: /uncertain storage/ },
  );
  t.is(effects, 0);
  t.deepEqual(
    f.events().map(event => event.type),
    ['begin', 'dispatch-intent', 'transcript-record', 'transcript-record'],
  );
});
