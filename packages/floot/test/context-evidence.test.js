// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import {
  certifyContextEvidence,
  assertContextEvidence,
} from '../src/context-evidence.js';
import { readContextTranscript } from '../src/context-transcript.js';
import { encodeJournalTranscript } from '../src/journal-transcript.js';
import { makeTurnJournal } from '../src/turn-journal.js';

/* eslint-disable no-await-in-loop */
const call = (id, name = 'exec') => ({
  kind: 'tool-call',
  id,
  name,
  args: '{}',
});
const result = (id, content) => ({ kind: 'tool-result', id, content });
const checkpoint = { kind: 'compaction', summary: 'summary', retainedTail: [] };
const record = (records, extra = {}) => ({
  turnId: '1',
  state: 'completed',
  input: 'input',
  transcriptComplete: true,
  tools: [],
  activity: [],
  transcript: records.map((value, index) => ({
    ordinal: `${index}`,
    sequence: `${index + 2}`,
    kind: value.kind,
    payload: encodeJournalTranscript(value),
  })),
  ...extra,
});
const noRead = async () => {
  throw Error('Unexpected hydration');
};
const settled = {
  callId: 'native',
  name: 'exec',
  args: '{}',
  settled: true,
  result: 'done',
  sequence: '2',
  resultSequence: '6',
};

test('certificate reconciles repeated IDs one-to-one and accounts for exact evidence frontier', async t => {
  const turn = record(
    [
      call('same'),
      result('same', 'first'),
      call('same'),
      result('same', 'second'),
    ],
    {
      tools: [
        { ...settled, callId: 'host1', result: 'first' },
        { ...settled, callId: 'host2', result: 'second', resultSequence: '7' },
      ],
    },
  );
  t.deepEqual(await certifyContextEvidence(turn, noRead), {
    kind: 'no-tool-exceptions',
    throughSequence: '7',
  });
  turn.tools.push({ ...settled, callId: 'unmatched-third', result: 'third' });
  t.is(await certifyContextEvidence(turn, noRead), undefined);
});

const disqualified = [
  ['unanswered canonical call', record([call('native')])],
  [
    'canonical placeholder',
    record([
      call('native'),
      result('native', 'Tool outcome unknown; do not automatically retry.'),
    ]),
  ],
  ['unmatched host effect', record([], { tools: [settled] })],
  ['unmatched native effect', record([], { activity: [settled] })],
  ['host-only replacement', record([call('native')], { tools: [settled] })],
  [
    'unsettled host despite canonical answer',
    record([call('native'), result('native', 'done')], {
      tools: [{ ...settled, settled: false }],
    }),
  ],
  [
    'unsettled native despite canonical answer',
    record([call('native'), result('native', 'done')], {
      activity: [{ ...settled, settled: false }],
    }),
  ],
  [
    'missing call provenance',
    record([call('native'), result('native', 'done')], {
      activity: [{ ...settled, sequence: undefined }],
    }),
  ],
  [
    'missing result provenance',
    record([call('native'), result('native', 'done')], {
      activity: [{ ...settled, resultSequence: undefined }],
    }),
  ],
];
for (const [label, turn] of disqualified) {
  test(`does not certify ${label}`, async t => {
    t.is(await certifyContextEvidence(turn, noRead), undefined);
  });
}

test('native-only replacement is certified through its late result, never its earlier call', async t => {
  const turn = record([call('native')], { activity: [settled] });
  t.deepEqual(await certifyContextEvidence(turn, noRead), {
    kind: 'no-tool-exceptions',
    throughSequence: '6',
  });
});

test('malformed and inconsistent certificates fail structural validation', t => {
  const turn = record([call('native'), result('native', 'done')]);
  for (const certificate of [
    null,
    {},
    { kind: 'wrong', throughSequence: '3' },
    { kind: 'no-tool-exceptions', throughSequence: '2' },
    { kind: 'no-tool-exceptions', throughSequence: '03' },
    { kind: 'no-tool-exceptions', throughSequence: '3', extra: true },
  ]) {
    t.throws(
      () => assertContextEvidence({ ...turn, contextEvidence: certificate }),
      { message: /Invalid archived context evidence/ },
    );
  }
  t.notThrows(() =>
    assertContextEvidence({
      ...turn,
      contextEvidence: { kind: 'no-tool-exceptions', throughSequence: '3' },
    }),
  );
});

test('reader skips only archived certified evidence at or before boundary, never retained or late evidence', async t => {
  const old = record([call('native')], { activity: [settled] });
  old.contextEvidence = await certifyContextEvidence(old, noRead);
  old.transcript[0].payloadRef = 'call';
  const boundary = record([checkpoint], { turnId: '4' });
  boundary.transcript[0].sequence = '5';
  const read = async ref => {
    t.is(ref, 'call');
    return old.transcript[0].payload;
  };
  let reads = 0;
  const journal = retained => ({
    readView: async () => ({
      retained: retained ? [old, boundary] : [boundary],
      archiveCursor: retained ? null : '0:1',
      archivedCheckpoint: null,
    }),
    listArchivedPage: async () => ({ records: [old], next: null }),
    readContent: async ref => {
      reads += 1;
      return read(ref);
    },
  });
  const late = await readContextTranscript(journal(false));
  t.is(reads, 1);
  t.true(late.some(item => item.content === 'done'));
  boundary.transcript[0].sequence = '6';
  reads = 0;
  await readContextTranscript(journal(false));
  t.is(reads, 0);
  await readContextTranscript(journal(true));
  t.is(reads, 1);
});

test('real archive certifies large tool payload once and skips it on later context reads', async t => {
  const store = new Map();
  const reads = [];
  const powers = Far('CertificateStorage', {
    list: () => harden([...store.keys()]),
    lookup: name => {
      reads.push(name);
      return store.get(name);
    },
    storeValue: (value, name) => {
      if (store.has(name)) throw Error('Overwrite');
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
  await journal.recordTranscript(old, '0', {
    ...call('native'),
    args: JSON.stringify({ command: 'x'.repeat(12_000) }),
  });
  await journal.recordTranscript(
    old,
    '1',
    result('native', 'y'.repeat(12_000)),
  );
  await journal.append(old, { type: 'finish', state: 'completed' });
  const boundary = await journal.begin(options);
  await journal.recordTranscript(boundary, '0', checkpoint);
  await journal.append(boundary, { type: 'finish', state: 'completed' });
  for (let index = 0; index < 290; index += 1) {
    const id = await journal.begin(options);
    await journal.append(id, { type: 'finish', state: 'completed' });
  }
  const archived = await journal.listArchived();
  t.is(
    archived.find(turn => turn.turnId === old).contextEvidence.kind,
    'no-tool-exceptions',
  );
  reads.length = 0;
  const context = await readContextTranscript(makeTurnJournal(powers));
  t.is(context[0].summary, 'summary');
  t.false(reads.some(name => name.startsWith('floot-turn-content-')));
});

test('archive certification content-read failure poisons writer before archive publication', async t => {
  const store = new Map();
  let failRead = false;
  const powers = Far('FailingCertificateStorage', {
    list: () => harden([...store.keys()]),
    lookup: name => {
      if (failRead && name.startsWith('floot-turn-content-')) {
        throw Error('Certificate content unavailable');
      }
      return store.get(name);
    },
    storeValue: (value, name) => {
      if (store.has(name)) throw Error('Overwrite');
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
  await journal.recordTranscript(old, '0', call('native'));
  await journal.recordTranscript(
    old,
    '1',
    result('native', 'x'.repeat(12_000)),
  );
  await journal.append(old, { type: 'finish', state: 'completed' });
  failRead = true;
  await t.throwsAsync(
    async () => {
      for (let index = 0; index < 290; index += 1) {
        const id = await journal.begin(options);
        await journal.append(id, { type: 'finish', state: 'completed' });
      }
    },
    { message: 'Certificate content unavailable' },
  );
  await t.throwsAsync(journal.readView());
  t.false(
    [...store.keys()].some(name => name.startsWith('floot-turn-archive-')),
  );
  failRead = false;
  const revived = makeTurnJournal(powers);
  const view = await revived.readView();
  t.is(view.archivedTurns, 0);
  t.true(view.retained.some(turn => turn.turnId === old));
});
