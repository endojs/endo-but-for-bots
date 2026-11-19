// @ts-check
// The compaction projection hook (resources/agent-host/impl/providers/
// compaction.js `compactionHook`; designs/m8-interfaces.md 5.5, D-M8-5):
// the highest-epoch marker's summary (and directive) first, every marker
// dropped, and no marker = the same transcript. This file imports the
// compaction module before the projection, the order that would break an
// import cycle built on a `const` hook (see the hook's note).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { compactionHook } from '../../resources/agent-host/impl/providers/compaction.js';
import { projectRecords } from '../../resources/agent-host/impl/projection.js';

const user = (/** @type {string} */ content) => ({
  kind: 'message',
  role: 'user',
  content,
});
const assistant = (/** @type {string} */ content) => ({
  kind: 'message',
  role: 'assistant',
  content,
});

test('no marker: the transcript is answered unchanged', t => {
  const transcript = [
    user('hi'),
    assistant('calling'),
    { kind: 'tool-call', id: 'a', name: 'echo', args: '{}' },
    { kind: 'tool-result', id: 'a', content: 'ok' },
  ];
  t.is(compactionHook(transcript), transcript);
  const empty = /** @type {any[]} */ ([]);
  t.is(compactionHook(empty), empty);
});

test('the highest epoch leads, wherever its marker lies; every marker is dropped', t => {
  const transcript = [
    { kind: 'compaction', epoch: 1, summary: 'first summary' },
    user('sealed'),
    assistant('sealed reply'),
    {
      kind: 'compaction',
      epoch: 3,
      summary: 'third summary',
      directive: 'the directive',
    },
    user('kept'),
    { kind: 'compaction', epoch: 2, summary: 'second summary' },
    assistant('kept reply'),
  ];
  t.deepEqual(compactionHook(transcript), [
    assistant('third summary'),
    user('the directive'),
    user('sealed'),
    assistant('sealed reply'),
    user('kept'),
    assistant('kept reply'),
  ]);
});

test('a marker without a directive puts the summary alone first', t => {
  t.deepEqual(
    compactionHook([user('a'), { kind: 'compaction', epoch: 1, summary: 's' }]),
    [assistant('s'), user('a')],
  );
});

test('as a projection hook: records project, then the hook runs', t => {
  const records = harden([
    { kind: 'turn-started', turnId: 't1', input: 'question', at: 1 },
    { kind: 'dispatched', turnId: 't1', round: 0 },
    { kind: 'round-settled', turnId: 't1', round: 0, text: 'answer', at: 1 },
    { kind: 'turn-settled', turnId: 't1', status: 'completed', at: 1 },
  ]);
  const plain = projectRecords(records, { texts: new Map(), hooks: [] });
  const hooked = projectRecords(records, {
    texts: new Map(),
    hooks: [compactionHook],
  });
  t.deepEqual(hooked.transcript, plain.transcript);
  t.deepEqual(
    projectRecords(records, {
      texts: new Map(),
      hooks: [
        transcript => [
          ...transcript,
          { kind: 'compaction', epoch: 1, summary: 'sum' },
        ],
        compactionHook,
      ],
    }).transcript,
    [assistant('sum'), user('question'), assistant('answer')],
  );
});
