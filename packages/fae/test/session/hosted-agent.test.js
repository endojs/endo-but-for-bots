// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { defined } from '../../../../scripts/test/defined.js';

import { makeStreamingAgent } from '../../session-factory.js';
import { makeReplyChannel } from '../../session/stream.js';

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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'test prompt',
    { journalPowers: powers },
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
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'test prompt',
    { journalPowers: powers },
  );
  const reply = makeReplyChannel();
  await t.throwsAsync(() => first.converse('partial', reply.writer), {
    message: /provider failed after tool execution/,
  });

  const revived = await makeStreamingAgent(
    powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => provider,
    },
    'test prompt',
    { journalPowers: powers },
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

test('provider validation rejection is failed in live output, durable effects and revived context', async t => {
  const powers = makeFakePowers();
  const journalPowers = makeFakePowers();
  let round = 0;
  const provider = harden({
    chatStream: async () => {
      round += 1;
      return harden({
        message:
          round === 1
            ? {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'reject',
                    type: 'function',
                    function: {
                      name: 'exec',
                      arguments: '{"code":"return 1","timeout":30}',
                    },
                  },
                ],
              }
            : { role: 'assistant', content: 'Handled refusal.' },
      });
    },
  });
  const config = {
    kind: /** @type {const} */ ('provider'),
    provideProvider: () => provider,
  };
  const first = await makeStreamingAgent(powers, undefined, config, 'test', {
    journalPowers,
  });
  t.teardown(() => first.shutdown());
  const channel = makeReplyChannel();
  await first.converse('invalid tool', channel.writer);
  const events = [];
  for await (const event of iterateReader(channel.reader)) events.push(event);
  t.true(events.find(event => event.type === 'tool_result').failed);
  t.true((await first.getTurns())[0].tools[0].failed);
  const revived = await makeStreamingAgent(powers, undefined, config, 'test', {
    journalPowers,
  });
  t.teardown(() => revived.shutdown());
  t.true(
    defined((await revived.getHistory()).find(row => row.role === 'tool'))
      .failed,
  );
  t.true(
    defined(
      (await revived.getTranscript()).find(row => row.kind === 'tool-result'),
    ).failed,
  );
});

test('read-only history leaves undispatched evidence intact; writable startup repairs without acquiring a backend', async t => {
  const powers = makeFakePowers();
  const { makeTurnJournal } = await import('../../session/turn-journal.js');
  const journal = makeTurnJournal(powers);
  const id = await journal.begin({
    input: 'not sent',
    backendId: 'test',
    modelId: 'test',
  });
  const before = await powers.list();
  const reader = await makeStreamingAgent(
    powers,
    undefined,
    { kind: 'records-only' },
    'test',
    { journalPowers: powers },
  );
  t.teardown(() => reader.shutdown());
  t.is((await reader.getTurns())[0].state, 'outcome-unknown');
  t.deepEqual(await powers.list(), before);
  await reader.shutdown();
  let acquired = 0;
  const writer = await makeStreamingAgent(
    powers,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => {
        acquired += 1;
        throw Error('Unexpected backend');
      },
    },
    'test',
    { journalPowers: powers },
  );
  t.teardown(() => writer.shutdown());
  const repaired = (await writer.getTurns()).find(turn => turn.turnId === id);
  if (!repaired) throw Error('Missing repaired turn');
  t.is(repaired.state, 'cancelled');
  t.is(acquired, 0);
});
