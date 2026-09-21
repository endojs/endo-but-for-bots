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
// can be compared byte for byte. The read-back models the CLI's own context
// assembly: everything from the latest compaction onward.
testTranscriptRestoration({
  label: 'opencode',
  restore: records => JSON.stringify(importedTurnsFor(records)),
  readBack: native => readImportedTurns(JSON.parse(native)),
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
