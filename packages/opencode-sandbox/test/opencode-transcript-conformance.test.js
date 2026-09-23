// @ts-check
import '@endo/init';
import test from 'ava';

import { testTranscriptRestoration } from '@endo/hosted-agent/test/transcript-conformance.js';

import {
  importedTurnsFor,
  readImportedTurns,
} from '../src/opencode-transcript.js';

// OpenCode takes its history through the fork's import route
// (`op: 'import'` on the bridge, opencode-client.js), so the "native store"
// here is the turn list that route is handed, serialized so a retried revival
// can be compared byte for byte. Read-back decodes the payload without
// filtering it; this is not a native database or model-context test.
testTranscriptRestoration({
  label: 'opencode',
  restore: records => JSON.stringify(importedTurnsFor(records)),
  readBack: native => readImportedTurns(JSON.parse(native)),
});

test('import payload excludes superseded history before reaching the route', t => {
  const records = harden([
    { kind: 'message', role: 'user', content: 'superseded' },
    { kind: 'compaction', summary: 'old summary' },
    { kind: 'tool-call', id: 'reused', name: 'old', args: '{}' },
    { kind: 'compaction', summary: 'current summary' },
    { kind: 'message', role: 'user', content: 'continue' },
    { kind: 'tool-call', id: 'reused', name: 'new', args: '{}' },
    { kind: 'tool-result', id: 'reused', content: 'new result' },
  ]);
  t.deepEqual(importedTurnsFor(records), [
    { kind: 'compaction', text: 'current summary' },
    { kind: 'user', text: 'continue' },
    {
      kind: 'tool',
      callID: 'reused',
      name: 'new',
      input: {},
      output: 'new result',
    },
  ]);
  t.is(records.length, 7);
});

test('payload decoder cannot hide superseded context sent by an adapter', t => {
  t.deepEqual(
    readImportedTurns([
      { kind: 'user', text: 'old context' },
      { kind: 'compaction', text: 'summary' },
    ]),
    [
      { kind: 'message', role: 'user', content: 'old context' },
      { kind: 'compaction', summary: 'summary' },
    ],
  );
});

test('import refuses tool results that cross a compaction boundary', t => {
  t.throws(
    () =>
      importedTurnsFor([
        { kind: 'tool-call', id: 'old', name: 'tool', args: '{}' },
        { kind: 'compaction', summary: 'summary' },
        { kind: 'tool-result', id: 'old', content: 'late result' },
      ]),
    { message: /answers no call/ },
  );
});

test('imported tool inputs preserve objects and wrap non-object arguments', t => {
  /** @type {Array<[string, Record<string, unknown>]>} */
  const cases = [
    ['{"path":"a","nested":{"ok":true}}', { path: 'a', nested: { ok: true } }],
    ['[1,2]', { value: [1, 2] }],
    ['null', { value: null }],
    ['42', { value: 42 }],
    ['"text"', { value: 'text' }],
    ['not JSON', { value: 'not JSON' }],
  ];
  for (const [args, expected] of cases) {
    const [turn] = importedTurnsFor([
      { kind: 'tool-call', id: 'c1', name: 'tool', args },
    ]);
    t.is(turn.kind, 'tool');
    if (turn.kind !== 'tool') throw Error('Expected a tool turn');
    t.deepEqual(turn.input, expected);
    t.false(Array.isArray(turn.input));
  }
});
