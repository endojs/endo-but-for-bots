// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { pairToolCalls } from '@endo/hosted-agent/transcript-records.js';
import {
  projectContextTranscript,
  readContextTranscript,
} from '../src/context-transcript.js';
import { makeTurnJournal } from '../src/turn-journal.js';
import { encodeJournalTranscript } from '../src/journal-transcript.js';

const message = content => ({ kind: 'message', role: 'assistant', content });
const checkpoint = summary => ({
  kind: 'compaction',
  summary,
  retainedTail: [],
});
const call = (id, name) => ({ kind: 'tool-call', id, name, args: '{}' });
const result = (id, content) => ({ kind: 'tool-result', id, content });
const turn = (turnId, records, extra = {}) => ({
  turnId: `${turnId}`,
  state: 'completed',
  transcriptComplete: true,
  input: `input ${turnId}`,
  activity: [],
  tools: [],
  transcript: records.map((record, index) => ({
    ordinal: `${index}`,
    sequence: `${turnId + index + 1}`,
    kind: record.kind,
    payload: encodeJournalTranscript(record),
  })),
  ...extra,
});
const noRead = async () => {
  throw Error('Unexpected content hydration');
};

test('context skips superseded prose and boundary input, expanding retained tail exactly once', async t => {
  const old = turn(1, [message('old')], { inputRef: 'old-input' });
  old.transcript[0].payloadRef = 'old-prose';
  const tail = [call('tail', 'retained'), result('tail', 'pruned output')];
  const boundary = turn(
    10,
    [
      message('before'),
      { ...checkpoint('summary'), retainedTail: tail },
      message('after'),
    ],
    { inputRef: 'boundary-input' },
  );
  boundary.transcript[0].payloadRef = 'before';
  boundary.transcript[1].payloadRef = 'checkpoint';
  const reads = [];
  const projected = await projectContextTranscript(
    [boundary, old],
    async ref => {
      reads.push(ref);
      t.is(ref, 'checkpoint');
      return boundary.transcript[1].payload;
    },
  );
  t.deepEqual(reads, ['checkpoint']);
  t.deepEqual(projected, [
    { kind: 'compaction', summary: 'summary' },
    ...tail,
    message('after'),
  ]);
});

test('latest dispatch and ordinal win over archive publication order; pending and excluded checkpoints do not win', async t => {
  const old = turn(1, [checkpoint('old')]);
  const latest = turn(10, [checkpoint('first'), checkpoint('latest')]);
  const pending = turn(20, [checkpoint('pending')], { state: 'pending' });
  const excluded = turn(30, [checkpoint('excluded')]);
  const projected = await projectContextTranscript(
    [excluded, latest, pending, old],
    noRead,
    '30',
  );
  t.deepEqual(projected, [{ kind: 'compaction', summary: 'latest' }]);
});

test('settled canonical prior calls are summarized but unresolved and unmatched host evidence survive', async t => {
  const old = turn(
    1,
    [
      call('settled', 'done'),
      result('settled', 'known'),
      call('pending', 'unfinished'),
    ],
    {
      tools: [
        {
          callId: 'host',
          name: 'hostOnly',
          args: '{}',
          result: 'host effect',
          settled: true,
          sequence: '5',
          resultSequence: '6',
        },
      ],
    },
  );
  const projected = await projectContextTranscript(
    [old, turn(10, [checkpoint('summary')])],
    noRead,
  );
  const { pairs } = pairToolCalls(projected);
  t.deepEqual(
    pairs.map(pair => pair.call.name),
    ['unfinished', 'hostOnly'],
  );
  t.regex(
    pairs[0].result.content,
    /outcome unknown; do not automatically retry/,
  );
  t.is(pairs[1].result.content, 'host effect');
  t.true(
    projected.some(
      record =>
        record.kind === 'message' &&
        record.content.includes('position relative'),
    ),
  );
});

test('same native IDs in different old turns retain independent late settlements', async t => {
  const makeOld = (id, content) =>
    turn(id, [call('same', `exec${id}`)], {
      activity: [
        {
          callId: 'same',
          name: `exec${id}`,
          args: '{}',
          result: content,
          settled: true,
          sequence: `${id + 1}`,
          resultSequence: '50',
        },
      ],
    });
  const projected = await projectContextTranscript(
    [
      makeOld(1, 'first'),
      makeOld(10, 'second'),
      turn(30, [checkpoint('summary')]),
    ],
    noRead,
  );
  const { pairs } = pairToolCalls(projected);
  t.deepEqual(
    pairs.map(pair => pair.result.content),
    ['first', 'second'],
  );
  t.not(pairs[0].call.id, pairs[1].call.id);
});

test('failed committed checkpoint still defines context and preserves terminal failure', async t => {
  const projected = await projectContextTranscript(
    [
      turn(1, [message('old')]),
      turn(10, [checkpoint('summary')], {
        state: 'failed',
        error: 'lost stream',
      }),
    ],
    noRead,
  );
  t.is(projected[0].kind, 'compaction');
  t.false(JSON.stringify(projected).includes('input 10'));
  t.true(JSON.stringify(projected).includes('lost stream'));
});

test('mixed old pairs preserve only late canonical results and unresolved calls', async t => {
  const old = turn(1, [
    call('same', 'finished'),
    result('same', 'before'),
    call('same', 'late'),
    result('same', 'after'),
    call('open', 'unfinished'),
  ]);
  old.transcript[3].sequence = '40';
  old.transcript[4].sequence = '41';
  const projected = await projectContextTranscript(
    [old, turn(10, [checkpoint('summary')])],
    noRead,
  );
  const { pairs } = pairToolCalls(projected);
  t.deepEqual(
    pairs.map(pair => pair.call.name),
    ['late', 'unfinished'],
  );
  t.is(pairs[0].result.content, 'after');
  t.regex(pairs[1].result.content, /outcome unknown/);
});

test('recovered context IDs cannot alias a retained native call', async t => {
  const nativeId = 'recovered-context:1:0';
  const tail = [
    call(nativeId, 'retained'),
    result(nativeId, 'retained result'),
  ];
  const projected = await projectContextTranscript(
    [
      turn(1, [call('old', 'unfinished')]),
      turn(10, [{ ...checkpoint('summary'), retainedTail: tail }]),
    ],
    noRead,
  );
  const { pairs } = pairToolCalls(projected);
  t.is(pairs.length, 2);
  t.not(pairs[0].call.id, pairs[1].call.id);
  t.is(pairs[0].result.content, 'retained result');
  t.regex(pairs[1].result.content, /outcome unknown/);
});

test('real journal late old-turn settlement survives subsequent archive publication and revival', async t => {
  const store = new Map();
  const powers = Far('ContextJournalStorage', {
    list: () => harden([...store.keys()]),
    lookup: name => store.get(name),
    storeValue: (value, name) => {
      if (store.has(name)) throw Error('Overwrite forbidden');
      store.set(name, value);
    },
    remove: name => store.delete(name),
  });
  const journal = makeTurnJournal(powers);
  const options = harden({
    input: 'input',
    backendId: 'codex',
    modelId: 'sol',
  });
  const old = await journal.begin(options);
  await journal.recordTranscript(old, '0', call('native', 'exec'));
  await journal.append(old, {
    type: 'observed-tool-call',
    callId: 'native',
    name: 'exec',
    args: '{}',
  });
  await journal.append(old, { type: 'finish', state: 'completed' });
  const boundary = await journal.begin(options);
  await journal.recordTranscript(boundary, '0', checkpoint('durable summary'));
  await journal.append(boundary, { type: 'finish', state: 'completed' });
  // Publish the checkpoint before the earlier unresolved turn can be archived.
  /* eslint-disable no-await-in-loop */
  for (let index = 0; index < 290; index += 1) {
    const id = await journal.begin(options);
    await journal.append(id, { type: 'finish', state: 'completed' });
  }
  await journal.append(old, {
    type: 'observed-tool-result',
    callId: 'native',
    result: 'late effect',
  });
  await journal.resolve(old, 'Effect checked');
  for (let index = 0; index < 80; index += 1) {
    const id = await journal.begin(options);
    await journal.append(id, { type: 'finish', state: 'completed' });
  }
  const revived = makeTurnJournal(powers);
  const archived = await revived.listArchived();
  t.true(
    Number(archived.findIndex(item => item.turnId === old)) >
      Number(archived.findIndex(item => item.turnId === boundary)),
  );
  const projected = await projectContextTranscript(
    [...archived, ...(await revived.list())],
    ref => revived.readContent(ref),
  );
  const { pairs } = pairToolCalls(projected);
  t.is(pairs.length, 1);
  t.is(pairs[0].result.content, 'late effect');
  t.is(projected[0].summary, 'durable summary');
  t.deepEqual(await readContextTranscript(revived), projected);
});

test('paged reader pins one cut across publication and late settlement between passes', async t => {
  const old = turn(1, [call('unsettled', 'exec')]);
  const boundary = turn(10, [checkpoint('old summary')]);
  const after = turn(20, [message('after checkpoint')]);
  const newer = turn(30, [checkpoint('new summary')]);
  let published = false;
  let views = 0;
  const cursors = [];
  const journal = {
    readView: async () => {
      views += 1;
      return {
        retained: structuredClone([
          published
            ? {
                ...old,
                activity: [
                  {
                    callId: 'unsettled',
                    name: 'exec',
                    args: '{}',
                    settled: true,
                    result: 'new settlement',
                    sequence: '2',
                    resultSequence: '40',
                  },
                ],
              }
            : old,
        ]),
        archiveCursor: published ? '0:3' : '0:2',
      };
    },
    listArchivedPage: async cursor => {
      cursors.push(cursor);
      const [index, end] = cursor.split(':').map(Number);
      // Publication order intentionally differs from dispatch order.
      const pages = [[after], [boundary], [newer]];
      if (cursor === '1:2') published = true;
      return {
        records: pages[index],
        next: Number(index) + 1 < Number(end) ? `${index + 1}:${end}` : null,
      };
    },
    readContent: noRead,
  };
  const first = await readContextTranscript(journal);
  t.is(views, 1);
  t.deepEqual(cursors, ['0:2', '1:2', '0:2', '1:2']);
  t.is(first[0].summary, 'old summary');
  t.true(first.some(record => record.content === 'after checkpoint'));
  t.regex(pairToolCalls(first).pairs[0].result.content, /outcome unknown/);
  t.false(JSON.stringify(first).includes('new settlement'));
  const second = await readContextTranscript(journal);
  t.is(views, 2);
  t.deepEqual(cursors.slice(4), ['0:3', '1:3', '2:3', '0:3', '1:3', '2:3']);
  t.is(second[0].summary, 'new summary');
  t.is(pairToolCalls(second).pairs[0].result.content, 'new settlement');
  t.false(second.some(record => record.content === 'after checkpoint'));
});

for (const failingPass of [1, 2]) {
  test(`paged reader rejects archive failure in pass ${failingPass}`, async t => {
    let visits = 0;
    let views = 0;
    const journal = {
      readView: async () => {
        views += 1;
        return {
          retained: [turn(20, [message('not partial output')])],
          archiveCursor: '0:1',
        };
      },
      listArchivedPage: async cursor => {
        t.is(cursor, '0:1');
        visits += 1;
        if (visits === failingPass) throw Error('Archive unavailable');
        return { records: [turn(1, [checkpoint('summary')])], next: null };
      },
      readContent: noRead,
    };
    await t.throwsAsync(readContextTranscript(journal), {
      message: 'Archive unavailable',
    });
    t.is(views, 1);
    t.is(visits, failingPass);
  });
}

for (const corruption of ['missing', 'sequence', 'kind', 'ordinal']) {
  test(`paged reader rejects ${corruption} checkpoint on second pass`, async t => {
    let visits = 0;
    const original = turn(1, [checkpoint('summary')]);
    const changed = structuredClone(original);
    if (corruption === 'sequence') changed.transcript[0].sequence = '99';
    if (corruption === 'kind') changed.transcript[0].kind = 'message';
    if (corruption === 'ordinal') changed.transcript[0].ordinal = '1';
    const journal = {
      readView: async () => ({ retained: [], archiveCursor: '0:1' }),
      listArchivedPage: async () => {
        visits += 1;
        return {
          records:
            visits === 1
              ? [original]
              : corruption === 'missing'
                ? []
                : [changed],
          next: null,
        };
      },
      readContent: noRead,
    };
    await t.throwsAsync(readContextTranscript(journal), {
      message: /Context checkpoint (changed|missing)/,
    });
    t.is(visits, 2);
  });
}
