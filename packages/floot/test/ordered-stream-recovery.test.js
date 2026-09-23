// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { pairToolCalls } from '@endo/hosted-agent/transcript-records.js';

import { runHostedTurn, UNSETTLED_TOOL_RESULT } from '../src/hosted-turn.js';
import { makeTurnJournal } from '../src/turn-journal.js';
import {
  recoverTurnTranscript,
  transcriptToProviderMessages,
} from '../src/transcript-projection.js';

const fixture = async () => {
  const values = new Map();
  let refusedOrdinal;
  let afterStore = false;
  const powers = Far('OrderedStreamStorage', {
    list: () => harden([...values.keys()]),
    lookup: name => values.get(name),
    storeValue: (value, name) => {
      const fail =
        value?.type === 'transcript-record' && value.ordinal === refusedOrdinal;
      if (fail && !afterStore) throw Error('Transcript write failed');
      if (values.has(name)) throw Error('Overwrite');
      values.set(name, value);
      if (fail) throw Error('Transcript acknowledgement lost');
    },
    remove: name => values.delete(name),
  });
  const journal = makeTurnJournal(powers);
  const id = await journal.begin({
    input: 'request',
    backendId: 'test',
    modelId: 'test',
  });
  return {
    journal,
    id,
    powers,
    fail: (ordinal, stored = false) => {
      refusedOrdinal = ordinal;
      afterStore = stored;
    },
    callbacks: {
      recordToolEvent: event => journal.append(id, event),
      recordTranscript: (ordinal, record) =>
        journal.recordTranscript(id, ordinal, record),
      completeTranscript: count => journal.completeTranscript(id, count),
    },
    recover: async () => {
      const revived = makeTurnJournal(powers);
      const turn = await revived.get(id);
      return recoverTurnTranscript([], turn, ref => revived.readContent(ref));
    },
  };
};
const writer = harden({
  setPhase() {},
  delta() {},
  toolCall() {},
  toolResult() {},
});
const events = harden([
  { type: 'text-delta', text: 'before' },
  { type: 'tool-call', id: 'c', name: 'read', args: '{}' },
  { type: 'tool-result', id: 'c', result: 'result' },
  { type: 'compaction', summary: 'summary' },
  { type: 'text-delta', text: 'after' },
  { type: 'end' },
]);
const clientFor = (items, interrupt = async () => {}) =>
  harden({
    send: async () =>
      readerFromIterator(
        (async function* stream() {
          for (const event of items) yield event;
        })(),
      ),
    interrupt,
  });

for (const placeholder of [false, true]) {
  test(`recovered host result remains active across compaction (placeholder=${placeholder})`, async t => {
    const f = await fixture();
    await f.journal.append(f.id, {
      type: 'tool-intent',
      callId: 'host',
      name: 'read',
      args: '{}',
    });
    await f.journal.recordTranscript(f.id, '0', {
      kind: 'tool-call',
      id: 'native',
      name: 'read',
      args: '{}',
    });
    if (placeholder)
      await f.journal.recordTranscript(f.id, '1', {
        kind: 'tool-result',
        id: 'native',
        content: UNSETTLED_TOOL_RESULT,
      });
    await f.journal.recordTranscript(f.id, placeholder ? '2' : '1', {
      kind: 'compaction',
      summary: 'summary',
    });
    await f.journal.append(f.id, {
      type: 'tool-result',
      callId: 'host',
      result: 'done',
    });
    const context = transcriptToProviderMessages(await f.recover());
    t.is(context[0].content, 'summary');
    t.true(context.some(row => row.content?.includes('position relative')));
    t.deepEqual(
      context.filter(row => row.role === 'tool').map(row => row.content),
      ['done'],
    );
  });
}

test('unmatched host effects stay visible even when they predate compaction', async t => {
  const f = await fixture();
  await f.journal.append(f.id, {
    type: 'tool-intent',
    callId: 'host',
    name: 'read',
    args: '{}',
  });
  await f.journal.append(f.id, {
    type: 'tool-result',
    callId: 'host',
    result: 'effect unknown to native summary',
  });
  await f.journal.recordTranscript(f.id, '0', {
    kind: 'compaction',
    summary: 'summary',
  });
  const context = transcriptToProviderMessages(await f.recover());
  t.is(context[0].content, 'summary');
  t.deepEqual(
    context.filter(row => row.role === 'tool').map(row => row.content),
    ['effect unknown to native summary'],
  );
});

test('ordered stream restores text/tools/boundary without the conversation tree', async t => {
  const f = await fixture();
  await runHostedTurn({
    client: clientFor(events),
    writer,
    text: 'request',
    ...f.callbacks,
  });
  await f.journal.append(f.id, {
    type: 'finish',
    state: 'completed',
    output: 'beforeafter',
  });
  const turn = await f.journal.get(f.id);
  t.true(turn.transcriptComplete);
  t.is(turn.transcript.length, 5);
  t.true(
    BigInt(turn.activity[0].sequence) < BigInt(turn.activity[0].resultSequence),
  );
  const records = await f.recover();
  t.deepEqual(
    records.map(record => record.kind),
    ['message', 'message', 'tool-call', 'tool-result', 'compaction', 'message'],
  );
  t.is(pairToolCalls(records).pairs.length, 1);
  t.deepEqual(transcriptToProviderMessages(records), [
    { role: 'assistant', content: 'summary' },
    { role: 'assistant', content: 'after' },
  ]);
});

test('stream refuses compaction across an unsettled reported tool call', async t => {
  const f = await fixture();
  let stops = 0;
  await t.throwsAsync(
    runHostedTurn({
      client: clientFor([events[0], events[1], events[3]], async () => {
        stops += 1;
      }),
      writer,
      text: 'request',
      ...f.callbacks,
    }),
    { message: /Compaction cannot cross/ },
  );
  t.is(stops, 1);
  t.false((await f.recover()).some(record => record.kind === 'compaction'));
});

for (const ordinal of ['1', '2', '3']) {
  for (const stored of [false, true]) {
    test(`failed publication at ordinal ${ordinal} (stored=${stored}) stops and recovers one tool`, async t => {
      const f = await fixture();
      f.fail(ordinal, stored);
      let stops = 0;
      await t.throwsAsync(
        runHostedTurn({
          client: clientFor(events, async () => {
            stops += 1;
          }),
          writer,
          text: 'request',
          ...f.callbacks,
        }),
        { message: /Transcript/ },
      );
      t.is(stops, 1);
      await t.throwsAsync(f.journal.assertReady(), {
        message: /uncertain storage/,
      });
      const records = await f.recover();
      const { pairs } = pairToolCalls(records);
      t.is(pairs.length, 1);
      t.is(pairs[0].result?.content, ordinal === '1' ? undefined : 'result');
      t.true(
        records.some(
          record =>
            record.kind === 'message' &&
            record.content.includes('durable transcript prefix'),
        ),
      );
      if (ordinal === '3' && stored) {
        t.is(transcriptToProviderMessages(records)[0].content, 'summary');
      }
    });
  }
}

test('cancelled text is journaled only after producer shutdown acknowledgement', async t => {
  t.timeout(5000);
  const f = await fixture();
  const controller = new AbortController();
  let release = () => {};
  let entered = () => {};
  const barrier = new Promise(resolve => {
    release = resolve;
  });
  const stopped = new Promise(resolve => {
    entered = resolve;
  });
  const channel = makeBufferedReader();
  channel.push({ type: 'text-delta', text: 'partial' });
  const client = harden({
    send: async () => channel.reader,
    interrupt: async () => {
      entered();
      await barrier;
    },
  });
  const work = runHostedTurn({
    client,
    writer: harden({ ...writer, delta: () => controller.abort() }),
    text: 'request',
    signal: controller.signal,
    ...f.callbacks,
  });
  await stopped;
  t.is((await f.journal.get(f.id)).transcript, undefined);
  release();
  await work;
  t.is((await f.journal.get(f.id)).transcriptComplete, undefined);
  t.true(
    (await f.recover()).some(
      record => record.kind === 'message' && record.content === 'partial',
    ),
  );
});

test('known host completion before delayed call observation never precedes its call', async t => {
  const f = await fixture();
  await f.journal.append(f.id, {
    type: 'tool-intent',
    callId: 'host',
    name: 'read',
    args: '{}',
  });
  await f.journal.append(f.id, {
    type: 'tool-result',
    callId: 'host',
    result: 'done',
  });
  await f.journal.recordTranscript(f.id, '0', {
    kind: 'tool-call',
    id: 'native',
    name: 'read',
    args: '{}',
  });
  const { pairs } = pairToolCalls(await f.recover());
  t.is(pairs.length, 1);
  t.is(pairs[0].result.content, 'done');
});
