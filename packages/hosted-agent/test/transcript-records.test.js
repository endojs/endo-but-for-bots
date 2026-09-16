// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  assertTranscriptRecord,
  encodeTranscript,
  encodeTranscriptRecord,
  pairToolCalls,
  parseTranscript,
  splitAtLastCompaction,
} from '../src/transcript-records.js';

/** @typedef {import('../src/transcript-records.js').TranscriptRecord} TranscriptRecord */

/** @type {readonly TranscriptRecord[]} */
const conversation = harden([
  { kind: 'message', role: 'user', content: 'build the page' },
  { kind: 'message', role: 'assistant', content: 'reading the workspace' },
  { kind: 'tool-call', id: 'call_1', name: 'readFile', args: '{"path":"a"}' },
  { kind: 'tool-result', id: 'call_1', content: 'contents of a' },
  { kind: 'message', role: 'assistant', content: 'done' },
]);

test('a stream round-trips through its encoding', t => {
  const text = encodeTranscript(conversation);
  // One self-describing object per line, no enclosing array, and a trailing
  // newline so the next record appends without reading the file first.
  t.is(text.split('\n').length - 1, conversation.length);
  t.true(text.endsWith('\n'));
  t.false(text.startsWith('['));
  t.deepEqual(parseTranscript(text), conversation);
  t.deepEqual(parseTranscript(''), []);
});

test('the same record always encodes to the same bytes', t => {
  // Producers may build a record in any field order; the encoding may not
  // depend on which. This is what lets a stream be compared or hash-chained.
  t.is(
    encodeTranscriptRecord({ content: 'hi', role: 'user', kind: 'message' }),
    encodeTranscriptRecord({ kind: 'message', role: 'user', content: 'hi' }),
  );
  t.is(
    encodeTranscriptRecord(conversation[2]),
    '{"kind":"tool-call","id":"call_1","name":"readFile","args":"{\\"path\\":\\"a\\"}"}',
  );
});

test('a torn write is refused, not silently truncated', t => {
  const text = encodeTranscript(conversation);
  // A crash between a record and its newline. Dropping the partial line would
  // turn a torn write into a conversation that quietly lost its last turn.
  t.throws(() => parseTranscript(`${text}{"kind":"message"`), {
    message: /ends mid-record/,
  });
  t.throws(() => parseTranscript(`${text}\n`), {
    message: /line 6 is empty/,
  });
  t.throws(() => parseTranscript('not json\n'), {
    message: /line 1 is not JSON/,
  });
});

test('records carry dialogue and tool traffic, and nothing else', t => {
  /** @type {[string, unknown, RegExp][]} */
  const rejected = [
    ['not an object', 'text', /must be an object/],
    ['an unknown kind', { kind: 'system', content: 'x' }, /kind "system"/],
    [
      'an unknown field',
      { kind: 'message', role: 'user', content: 'x', cap: 'y' },
      /unknown field "cap"/,
    ],
    ['a missing field', { kind: 'message', role: 'user' }, /missing "content"/],
    [
      'a role with no dialogue meaning here',
      { kind: 'message', role: 'tool', content: 'x' },
      /role "tool"/,
    ],
    [
      'non-text content',
      { kind: 'message', role: 'user', content: { text: 'x' } },
      /field "content" must be a string/,
    ],
    [
      'a tool call with no id',
      { kind: 'tool-call', id: '', name: 'readFile', args: '{}' },
      /needs a tool call id/,
    ],
    [
      'a non-boolean failure flag',
      { kind: 'tool-result', id: 'c', content: 'x', failed: 'yes' },
      /"failed" must be a boolean/,
    ],
  ];
  for (const [label, bad, message] of rejected) {
    t.throws(() => assertTranscriptRecord(bad), { message }, label);
  }
  // `failed` is the one optional field.
  t.deepEqual(
    assertTranscriptRecord({ kind: 'tool-result', id: 'c', content: 'x' }),
    { kind: 'tool-result', id: 'c', content: 'x' },
  );
});

test('a compaction record is the context boundary, by position', t => {
  /** @type {readonly TranscriptRecord[]} */
  const compacted = harden([
    ...conversation,
    { kind: 'compaction', summary: 'built the page and read a' },
    { kind: 'message', role: 'user', content: 'now add a footer' },
  ]);
  const { superseded, active } = splitAtLastCompaction(compacted);
  t.is(superseded.length, conversation.length);
  // The compaction itself opens the active span — OpenCode selects messages
  // at or after the latest compaction row, so the summary is context, not
  // history.
  t.is(active[0].kind, 'compaction');
  t.is(active.length, 2);

  // The latest wins, as `latestCompaction` does.
  /** @type {readonly TranscriptRecord[]} */
  const twice = harden([
    ...compacted,
    { kind: 'compaction', summary: 'and added a footer' },
  ]);
  t.is(splitAtLastCompaction(twice).active.length, 1);

  // A CLI with no compaction concept sees the whole stream as active.
  t.deepEqual(splitAtLastCompaction(conversation), {
    superseded: [],
    active: [...conversation],
  });
});

test('tool calls pair with their results by id, earliest unanswered first', t => {
  const { pairs, unanswered } = pairToolCalls(conversation);
  t.is(pairs.length, 1);
  t.is(pairs[0].call.name, 'readFile');
  t.is(pairs[0].result?.content, 'contents of a');
  t.deepEqual(unanswered, []);

  // Call ids are provider-local and repeat across turns. A later call reusing
  // an id must not claim the earlier call's result.
  /** @type {readonly TranscriptRecord[]} */
  const reused = harden([
    { kind: 'tool-call', id: 'c', name: 'readFile', args: '{"path":"a"}' },
    { kind: 'tool-call', id: 'c', name: 'readFile', args: '{"path":"b"}' },
    { kind: 'tool-result', id: 'c', content: 'a' },
    { kind: 'tool-result', id: 'c', content: 'b' },
  ]);
  const repeated = pairToolCalls(reused);
  t.deepEqual(
    repeated.pairs.map(pair => [pair.call.args, pair.result?.content]),
    [
      ['{"path":"a"}', 'a'],
      ['{"path":"b"}', 'b'],
    ],
  );

  // An interrupted turn leaves a call unanswered; the CLI must see that
  // rather than have the call silently dropped.
  const interrupted = pairToolCalls(conversation.slice(0, 3));
  t.is(interrupted.unanswered.length, 1);
  t.is(interrupted.unanswered[0].id, 'call_1');

  t.throws(
    () =>
      pairToolCalls([
        /** @type {TranscriptRecord} */ ({
          kind: 'tool-result',
          id: 'ghost',
          content: 'x',
        }),
      ]),
    { message: /answers no call/ },
  );
});
