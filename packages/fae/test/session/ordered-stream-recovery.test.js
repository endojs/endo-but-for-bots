// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { pairToolCalls } from '@endo/hosted-agent/transcript-records.js';

import { UNSETTLED_TOOL_RESULT } from '../../session/turn-evidence.js';
import { makeTurnJournal } from '../../session/turn-journal.js';
import { projectContextTranscript } from '../../session/context-transcript.js';
import {
  recoverTurnTranscript,
  transcriptToProviderMessages,
} from '../../session/transcript-projection.js';

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
  await journal.dispatch(id);
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
      return recoverTurnTranscript(turn, ref => revived.readContent(ref));
    },
  };
};
test('context selection preserves an unresolved canonical call before its same-turn checkpoint', async t => {
  const f = await fixture();
  await f.journal.recordTranscript(f.id, '0', {
    kind: 'tool-call',
    id: 'unsettled',
    name: 'effect',
    args: '{}',
  });
  await f.journal.recordTranscript(f.id, '1', {
    kind: 'compaction',
    summary: 'Summary does not settle a call',
  });
  await f.journal.append(f.id, { type: 'finish', state: 'failed' });
  const turns = await f.journal.list();
  const context = await projectContextTranscript(turns, ref =>
    f.journal.readContent(ref),
  );
  const messages = transcriptToProviderMessages(context);
  t.true(
    messages.some(
      message =>
        message.role === 'tool' && /unknown|unsettled/i.test(message.content),
    ),
  );
  t.is(context.filter(record => record.kind === 'tool-call').length, 1);
  t.is(context[0].kind, 'compaction');
  t.is((await f.recover())[0].kind, 'message');
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
  const { result } = pairs[0];
  if (!result) throw Error('Expected the known host completion');
  t.is(result.content, 'done');
});
