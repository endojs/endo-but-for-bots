// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { runHostedTurn } from '../src/hosted-turn.js';
import { projectJournalTurnHistory } from '../src/journal-history.js';
import { encodeJournalTranscript } from '../src/journal-transcript.js';
import { makeReplyFold } from '../src/reply-fold.js';
import { makeReplyChannel } from '../src/stream.js';
import { recoverTurnTranscript } from '../src/transcript-projection.js';
import { reconcileTurnEvidence } from '../src/turn-evidence.js';
import { makeTurnJournal } from '../src/turn-journal.js';

const fixture = () => {
  const values = new Map();
  const powers = Far('FailureStatusStorage', {
    list: () => harden([...values.keys()]),
    lookup: name => values.get(name),
    storeValue: (value, name) => {
      if (values.has(name)) throw Error('Overwrite');
      values.set(name, value);
    },
    remove: name => values.delete(name),
  });
  return { powers, journal: makeTurnJournal(powers) };
};
const options = { input: 'go', backendId: 'test', modelId: 'test' };
const read = tool => ({ args: tool.args, result: tool.result });

for (const failed of [true, false, undefined]) {
  test(`native outcome reaches context, journal observation, reply and snapshot (failed=${failed})`, async t => {
    const events = [];
    const records = [];
    const channel = makeReplyChannel();
    t.teardown(channel.close);
    const fold = makeReplyFold();
    const status = {
      phase: '',
      streamingText: '',
      messages: [],
      error: null,
      usage: null,
    };
    const draining = (async () => {
      for await (const event of iterateReader(channel.reader)) {
        if (fold.apply(status, event)) break;
      }
    })();
    const result = await runHostedTurn({
      text: 'go',
      writer: channel.writer,
      client: harden({
        send: async () =>
          readerFromIterator(
            (async function* toolEvents() {
              yield {
                type: 'tool-call',
                id: 'call',
                name: 'shell',
                args: '{}',
              };
              yield {
                type: 'tool-result',
                id: 'call',
                result: 'Error: literal output',
                ...(failed === undefined ? {} : { ok: !failed }),
              };
              yield { type: 'end' };
            })(),
          ),
      }),
      recordToolEvent: async event => {
        events.push(event);
      },
      recordTranscript: async (_ordinal, record) => {
        records.push(record);
      },
      completeTranscript: async () => {},
    });
    channel.writer.end();
    await draining;
    t.is(result.toolCalls[0].failed, failed);
    t.is(
      events.find(event => event.type === 'observed-tool-result').failed,
      failed,
    );
    t.is(records.find(record => record.kind === 'tool-result').failed, failed);
    t.is(status.messages[0].failed, failed);
    const adopted = { ...status, messages: [] };
    fold.adopt(adopted, status);
    t.is(adopted.messages[0].failed, failed);
  });
}

test('host and native classification survives event replay, snapshots, archives and full-content recovery', async t => {
  const f = fixture();
  const id = await f.journal.begin(options);
  await f.journal.dispatch(id);
  const result = `Error: ${'x'.repeat(9000)}`;
  for (const [index, failed] of [true, false, undefined].entries()) {
    // eslint-disable-next-line no-await-in-loop
    await f.journal.append(id, {
      type: 'tool-intent',
      callId: `h${index}`,
      name: 'exec',
      args: '{}',
    });
    // eslint-disable-next-line no-await-in-loop
    await f.journal.append(id, {
      type: 'tool-result',
      callId: `h${index}`,
      result,
      ...(failed === undefined ? {} : { failed }),
    });
    // eslint-disable-next-line no-await-in-loop
    await f.journal.append(id, {
      type: 'observed-tool-call',
      callId: `n${index}`,
      name: 'shell',
      args: '{}',
    });
    // eslint-disable-next-line no-await-in-loop
    await f.journal.append(id, {
      type: 'observed-tool-result',
      callId: `n${index}`,
      result,
      ...(failed === undefined ? {} : { failed }),
    });
  }
  await f.journal.append(id, { type: 'finish', state: 'completed' });
  const verify = async turn => {
    t.is(
      turn.state,
      'completed',
      'a failed tool is a settled response, not a failed turn',
    );
    t.deepEqual(
      turn.tools.map(tool => tool.failed),
      [true, false, undefined],
    );
    t.deepEqual(
      turn.activity.map(tool => tool.failed),
      [true, false, undefined],
    );
    const records = await recoverTurnTranscript(turn, ref =>
      f.journal.readContent(ref),
    );
    t.deepEqual(
      records
        .filter(record => record.kind === 'tool-result')
        .map(record => record.failed),
      [true, false, undefined, true, false, undefined],
    );
    t.true(
      records
        .filter(record => record.kind === 'tool-result')
        .every(record => record.content === result),
    );
    const history = await projectJournalTurnHistory(turn, ref =>
      f.journal.readContent(ref),
    );
    t.deepEqual(
      history.filter(row => row.role === 'tool').map(row => row.failed),
      [true, false, undefined, true, false, undefined],
    );
  };
  await verify(await makeTurnJournal(f.powers).get(id));
  for (let index = 0; index < 280; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const next = await f.journal.begin(options);
    // eslint-disable-next-line no-await-in-loop
    await f.journal.dispatch(next);
    // eslint-disable-next-line no-await-in-loop
    await f.journal.append(next, { type: 'finish', state: 'completed' });
  }
  const revived = makeTurnJournal(f.powers);
  const archived = (await revived.listArchived()).find(
    turn => turn.turnId === id,
  );
  t.truthy(archived);
  await verify(archived);
});

test('reconciliation fills known classification without matching contradictory host outcomes', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: [{ id: 'n', name: 'exec', args: '{}', result: 'same' }],
    activity: [
      {
        callId: 'n',
        name: 'exec',
        args: '{}',
        result: 'same',
        settled: true,
        failed: true,
      },
    ],
    tools: [
      {
        callId: 'h',
        name: 'exec',
        args: '{}',
        result: 'same',
        settled: true,
        failed: false,
      },
    ],
    read,
  });
  t.is(
    rows.length,
    2,
    'different outcomes are distinct evidence, not silently overwritten',
  );
  t.deepEqual(
    rows.map(row => row.failed),
    [true, false],
  );
  await t.throwsAsync(
    reconcileTurnEvidence({
      turnId: '1',
      known: [
        { id: 'n', name: 'exec', args: '{}', result: 'same', failed: false },
      ],
      activity: [
        {
          callId: 'n',
          name: 'exec',
          args: '{}',
          result: 'same',
          settled: true,
          failed: true,
        },
      ],
      read,
    }),
    { message: /Conflicting observed tool outcome/ },
  );
});

test('late host rejection settles unknown outcome without making the cancelled turn successful', async t => {
  const f = fixture();
  const id = await f.journal.begin(options);
  await f.journal.dispatch(id);
  await f.journal.append(id, {
    type: 'tool-intent',
    callId: 'h',
    name: 'exec',
    args: '{}',
  });
  await f.journal.append(id, { type: 'finish', state: 'cancelled' });
  const revived = makeTurnJournal(f.powers);
  await revived.append(id, {
    type: 'tool-result',
    callId: 'h',
    result: 'refused',
    failed: true,
  });
  const turn = await revived.get(id);
  t.is(turn.state, 'outcome-unknown');
  t.true(turn.tools[0].settled);
  t.true(turn.tools[0].failed);
  const records = await recoverTurnTranscript(turn, ref =>
    revived.readContent(ref),
  );
  t.true(records.find(record => record.kind === 'tool-result').failed);
});

test('failure enrichment keeps its journal position across compaction and cannot certify a native cut', async t => {
  const f = fixture();
  const id = await f.journal.begin(options);
  await f.journal.dispatch(id);
  await f.journal.recordTranscript(id, '0', {
    kind: 'tool-call',
    id: 'n',
    name: 'exec',
    args: '{}',
  });
  await f.journal.recordTranscript(id, '1', {
    kind: 'tool-result',
    id: 'n',
    content: 'refused',
  });
  await f.journal.recordTranscript(id, '2', {
    kind: 'compaction',
    summary: 'Summary',
  });
  await f.journal.append(id, {
    type: 'tool-intent',
    callId: 'h',
    name: 'exec',
    args: '{}',
  });
  await f.journal.append(id, {
    type: 'tool-result',
    callId: 'h',
    result: 'refused',
    failed: true,
  });
  await f.journal.completeTranscript(id, '3');
  await f.journal.append(id, { type: 'finish', state: 'completed' });
  const turn = await f.journal.get(id);
  let safe;
  const recovered = await recoverTurnTranscript(
    turn,
    ref => f.journal.readContent(ref),
    {
      reportNativeSafety: value => {
        safe = value;
      },
    },
  );
  t.false(safe);
  t.is(recovered.filter(record => record.kind === 'tool-result').length, 2);
  t.true(
    recovered
      .filter(record => record.kind === 'tool-result')
      .every(record => record.failed),
  );
  const late = await recoverTurnTranscript(
    turn,
    ref => f.journal.readContent(ref),
    { evidenceAfter: turn.transcript[2].sequence },
  );
  t.true(late.find(record => record.kind === 'tool-result').failed);
  const native = {
    ...turn,
    nativeContextFormat: 'test-native',
    transcript: [
      ...turn.transcript,
      {
        ordinal: '3',
        sequence: turn.tools[0].resultSequence,
        kind: 'native-context',
        payload: encodeJournalTranscript({
          kind: 'native-context',
          format: 'test-native',
          payload: 'opaque',
          context: [],
        }),
      },
    ],
  };
  await recoverTurnTranscript(native, ref => f.journal.readContent(ref), {
    reportNativeSafety: value => {
      safe = value;
    },
  });
  t.false(safe);
});

test('invalid outcome flags are rejected before journal publication', async t => {
  const f = fixture();
  const id = await f.journal.begin(options);
  await f.journal.dispatch(id);
  await f.journal.append(id, {
    type: 'tool-intent',
    callId: 'h',
    name: 'exec',
    args: '{}',
  });
  await t.throwsAsync(
    f.journal.append(id, {
      type: 'tool-result',
      callId: 'h',
      result: 'literal',
      failed: 'true',
    }),
    { message: /Invalid turn journal tool failure flag/ },
  );
  t.not((await makeTurnJournal(f.powers).get(id)).tools[0].settled, true);
});
