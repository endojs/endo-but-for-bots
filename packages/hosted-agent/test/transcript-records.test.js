// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  assertTranscriptRecord,
  encodeTranscript,
  encodeTranscriptRecord,
  pairToolCalls,
  parseTranscript,
  readResponsesApiItems,
  renderTranscriptDialogue,
  responsesApiItems,
  selectActiveTranscript,
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
  // A tool result need not carry `failed`.
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
  const { superseded, active } = selectActiveTranscript(compacted);
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
  t.is(selectActiveTranscript(twice).active.length, 1);

  // A CLI with no compaction concept sees the whole stream as active.
  t.deepEqual(selectActiveTranscript(conversation), {
    superseded: [],
    active: [...conversation],
  });
});

test('retained context is canonical, immutable, and expanded exactly once', t => {
  const checkpoint = assertTranscriptRecord({
    retainedTail: [{ content: 'recent', role: 'user', kind: 'message' }],
    summary: 'older context',
    kind: 'compaction',
  });
  t.is(
    encodeTranscriptRecord(checkpoint),
    '{"kind":"compaction","summary":"older context","retainedTail":[{"kind":"message","role":"user","content":"recent"}]}',
  );
  t.deepEqual(parseTranscript(encodeTranscript([checkpoint])), [checkpoint]);
  const records = harden([...conversation, checkpoint]);
  const { active, superseded } = selectActiveTranscript(records);
  t.deepEqual(active, [
    { kind: 'compaction', summary: 'older context' },
    { kind: 'message', role: 'user', content: 'recent' },
  ]);
  t.deepEqual(superseded, conversation);
  t.deepEqual(selectActiveTranscript(active).active, active);
  t.deepEqual(
    selectActiveTranscript([...records, { kind: 'compaction', summary: 'new' }])
      .active,
    [{ kind: 'compaction', summary: 'new' }],
  );
  t.true(Object.isFrozen(checkpoint));
});

test('retained context refuses nested boundaries and non-record authority', t => {
  for (const retainedTail of [
    undefined,
    {},
    [null],
    [{ kind: 'compaction', summary: 'nested' }],
    [{ kind: 'message', role: 'system', content: 'authority' }],
    [{ kind: 'message', role: 'user', content: 'x', capability: {} }],
  ]) {
    t.throws(() =>
      assertTranscriptRecord({
        kind: 'compaction',
        summary: 'summary',
        retainedTail,
      }),
    );
  }
});

const native = harden({
  kind: 'native-context',
  format: 'claude-code-jsonl-v1',
  payload: '{"signed":"native context"}\n',
  context: harden([
    { kind: 'compaction', summary: 'portable summary' },
    ...conversation,
  ]),
});

test('native context round-trips atomically with deterministic nested ordering', t => {
  const ordered = assertTranscriptRecord(native);
  t.deepEqual(parseTranscript(encodeTranscript([native])), [ordered]);
  t.is(
    encodeTranscriptRecord({
      context: native.context.map(record =>
        Object.fromEntries(Object.entries(record).reverse()),
      ),
      payload: native.payload,
      format: native.format,
      kind: native.kind,
    }),
    encodeTranscriptRecord(native),
  );
  t.true(Object.isFrozen(ordered));
  t.true(Object.isFrozen(ordered.context));
  t.true(Object.isFrozen(ordered.context[1]));
});

test('native context replaces the entire active prefix without expansion', t => {
  const checkpoint = assertTranscriptRecord(native);
  const later = assertTranscriptRecord({
    kind: 'message',
    role: 'user',
    content: 'continue',
  });
  const records = [...conversation, checkpoint, later];
  const { superseded, active } = selectActiveTranscript(records);
  t.deepEqual(superseded, conversation);
  t.deepEqual(active, [checkpoint, later]);
  t.deepEqual(selectActiveTranscript(active).active, active);
  const replacement = assertTranscriptRecord({
    ...native,
    payload: 'new native snapshot',
  });
  t.deepEqual(selectActiveTranscript([...records, replacement]).active, [
    replacement,
  ]);
  t.deepEqual(
    selectActiveTranscript([
      ...records,
      { kind: 'compaction', summary: 'new summary' },
    ]).active,
    [{ kind: 'compaction', summary: 'new summary' }],
  );
});

test('native context has only one nonnested portable projection', t => {
  for (const context of [
    undefined,
    {},
    [null],
    [native],
    [{ kind: 'compaction', summary: 'a', retainedTail: [] }],
    [conversation[0], { kind: 'compaction', summary: 'late summary' }],
    [
      { kind: 'compaction', summary: 'a' },
      { kind: 'compaction', summary: 'b' },
    ],
    [{ kind: 'message', role: 'system', content: 'authority' }],
    [{ kind: 'tool-result', id: 'x', content: 'result', capability: {} }],
  ])
    t.throws(() => assertTranscriptRecord({ ...native, context }));
  for (const field of ['format', 'payload']) {
    for (const value of ['', undefined, {}, () => {}]) {
      t.throws(() => assertTranscriptRecord({ ...native, [field]: value }));
    }
  }
  t.throws(() =>
    assertTranscriptRecord({
      kind: 'compaction',
      summary: 'outer',
      retainedTail: [native],
    }),
  );
  t.notThrows(() => assertTranscriptRecord({ ...native, context: [] }));
});

test('portable translators explicitly refuse native context instead of dropping it', t => {
  const checkpoint = assertTranscriptRecord(native);
  t.throws(() => responsesApiItems([checkpoint]), {
    message: /native-context/,
  });
  t.throws(() => renderTranscriptDialogue([checkpoint]), {
    message: /native-context/,
  });
});

test('native projection is not evidence that an external host tool settled', t => {
  const call = assertTranscriptRecord({
    kind: 'tool-call',
    id: 'call_1',
    name: 'readFile',
    args: '{}',
  });
  const checkpoint = assertTranscriptRecord(native);
  const { pairs, unanswered } = pairToolCalls([call, checkpoint]);
  t.is(pairs.length, 1);
  t.is(pairs[0].result, undefined);
  t.deepEqual(unanswered, [call]);
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

test('pairing per turn starts afresh at each user message', t => {
  /** @type {readonly TranscriptRecord[]} */
  const turns = harden([
    { kind: 'message', role: 'user', content: 'one' },
    { kind: 'tool-call', id: 'c', name: 'readFile', args: '{"path":"a"}' },
    { kind: 'message', role: 'user', content: 'two' },
    { kind: 'tool-call', id: 'c', name: 'readFile', args: '{"path":"b"}' },
    { kind: 'tool-result', id: 'c', content: 'b' },
  ]);
  const answers = ({ pairs }) =>
    pairs.map(pair => [pair.call.args, pair.result?.content]);
  // Across turns, a result answers the earliest unanswered call of its id.
  t.deepEqual(answers(pairToolCalls(turns)), [
    ['{"path":"a"}', 'b'],
    ['{"path":"b"}', undefined],
  ]);
  // Per turn, native ids do not reach back: the first turn's call stays
  // unanswered and the second turn's is answered.
  const perTurn = pairToolCalls(turns, { perTurn: true });
  t.deepEqual(answers(perTurn), [
    ['{"path":"a"}', undefined],
    ['{"path":"b"}', 'b'],
  ]);
  t.deepEqual(
    perTurn.unanswered.map(call => call.args),
    ['{"path":"a"}'],
  );
});

test('records become raw Responses API items', t => {
  const items = responsesApiItems(conversation);
  t.deepEqual(items, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'build the page' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'reading the workspace' }],
    },
    // The property the whole exercise is for: a call restores as a call.
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'readFile',
      arguments: '{"path":"a"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'contents of a',
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    },
  ]);
});

test('an unsettled call still gets an output, and a compaction drops what it replaced', t => {
  // A `function_call` with no answering output is a history the provider
  // rejects, so an interrupted turn must restore as interrupted rather than
  // as a conversation that cannot load.
  const interrupted = responsesApiItems([
    { kind: 'tool-call', id: 'c1', name: 'build', args: '{}' },
  ]);
  t.is(interrupted.length, 2);
  t.regex(String(interrupted[1].output), /did not complete/);

  const compacted = responsesApiItems([
    ...conversation,
    { kind: 'compaction', summary: 'we built the page' },
    { kind: 'message', role: 'user', content: 'now the footer' },
  ]);
  t.deepEqual(
    compacted.map(item => item.content?.[0]?.text ?? item.type),
    ['we built the page', 'now the footer'],
  );
});

test('Responses API items read back as records, skipping what the stack does not record', t => {
  // A thread the CLI extended after restoration carries item kinds the stack
  // has no record for; reading it back must report the conversation those
  // items sit in rather than refuse the thread.
  const items = [
    ...responsesApiItems(conversation),
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'hmm' }] },
    {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'and ' },
        { type: 'output_text', text: 'more' },
      ],
    },
  ];
  t.deepEqual(readResponsesApiItems(items), [
    ...conversation,
    { kind: 'message', role: 'assistant', content: 'and more' },
  ]);
});
