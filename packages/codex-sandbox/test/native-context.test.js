// @ts-check
import '@endo/init';
import test from 'ava';
// Test the standalone image helper without adding it to the runtime API.
import {
  makeCodexNativeContextSelector,
  selectCodexNativeContext,
} from '../oci/native-context.mjs'; // eslint-disable-line import/no-relative-packages

const sessionId = '01a0d26e-d933-71c1-a255-d6f7c2e256f0';
const first = '01a0d26e-d945-7253-afcf-857ec39f0136';
const second = '01a0d26e-d985-7991-8e58-28f9dc7ef8c3';
const cwd = '/workspace';
const expected = { sessionId, turnId: first, cwd, cliVersion: '0.152.0' };
const row = (type, payload) => ({
  timestamp: '2026-09-24T08:01:15.081Z',
  type,
  payload,
});
const event = (type, turnId) => row('event_msg', { type, turn_id: turnId });
const message = (role, text) =>
  row('response_item', {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  });
const fixture = () => [
  row('session_meta', {
    id: sessionId,
    session_id: sessionId,
    cwd,
    cli_version: '0.152.0',
    model_provider: 'guest-choice-not-exported',
    base_instructions: { text: 'Synthetic native instructions' },
  }),
  event('task_started', first),
  message('user', 'Blue cat 猫'),
  row('world_state', { synthetic: true }),
  row('turn_context', { turn_id: first, cwd }),
  message('assistant', 'Synthetic answer'),
  event('task_complete', first),
];
const jsonl = rows =>
  `${rows.map((value, ordinal) => JSON.stringify({ ordinal, ...value })).join('\n')}\n`;

test('selector exports exact context row bytes, not runtime identity or operational events', t => {
  const rows = fixture();
  const text = jsonl(rows);
  const result = selectCodexNativeContext(text, expected);
  t.deepEqual(result, {
    sessionId,
    turnId: first,
    baseInstructions: 'Synthetic native instructions',
    payload: `${text.split('\n').slice(2, 6).join('\n')}\n`,
  });
  t.false(result.payload.includes('guest-choice-not-exported'));
});

test('opaque reasoning and tool fields survive unchanged as data', t => {
  const rows = fixture();
  const added = [
    row('response_item', {
      type: 'reasoning',
      id: 'r',
      encrypted_content: 'opaque+bytes/==',
      summary: [],
      vendor_field: { future: true },
    }),
    row('response_item', {
      type: 'function_call',
      call_id: 'call',
      name: 'synthetic',
      arguments: '{"a":1}',
    }),
    row('response_item', {
      type: 'function_call_output',
      call_id: 'call',
      output: '{"result":"ok"}',
    }),
  ];
  rows.splice(-1, 0, ...added);
  const text = jsonl(rows);
  const result = selectCodexNativeContext(text, expected);
  for (const line of text.trimEnd().split('\n').slice(6, 9))
    t.true(result.payload.includes(`${line}\n`));
});

test('imported baseline rows and sparse ordinals survive a later completed turn', t => {
  const old = fixture();
  const selected = selectCodexNativeContext(jsonl(old), expected);
  const baseline = selected.payload
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const rows = [
    old[0],
    ...baseline,
    event('task_started', second),
    message('user', 'Continue'),
    message('assistant', 'Continued'),
    event('task_complete', second),
  ];
  const text = jsonl(rows);
  const result = selectCodexNativeContext(text, {
    ...expected,
    turnId: second,
  });
  t.true(result.payload.startsWith(selected.payload));
  t.true(result.payload.includes('Continued'));
});

test('pinned restored baseline reexports appended rows without ordinals', t => {
  const old = fixture();
  const selected = selectCodexNativeContext(jsonl(old), expected);
  const baseline = selected.payload
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const rows = [
    old[0],
    ...baseline,
    event('task_started', second),
    message('user', 'Continue'),
    message('assistant', 'Continued'),
    event('task_complete', second),
  ];
  const text = `${rows.map(value => JSON.stringify(value)).join('\n')}\n`;
  const result = selectCodexNativeContext(text, {
    ...expected,
    turnId: second,
  });
  t.true(result.payload.startsWith(selected.payload));
  t.true(result.payload.includes('Continued'));
  for (const ordinal of [null, -1, 0.5, '1']) {
    const invalid = rows.map((value, index) =>
      index === rows.length - 1 ? { ...value, ordinal } : value,
    );
    t.throws(() =>
      selectCodexNativeContext(
        `${invalid.map(value => JSON.stringify(value)).join('\n')}\n`,
        { ...expected, turnId: second },
      ),
    );
  }
});

test('a second compaction supersedes the previous compacted row and suffix', t => {
  const rows = fixture();
  rows.splice(
    3,
    0,
    row('compacted', {
      message: '',
      replacement_history: [{ type: 'compaction', encrypted_content: 'old' }],
    }),
  );
  rows.push(
    event('task_started', second),
    row('compacted', {
      message: '',
      replacement_history: [
        { type: 'compaction', encrypted_content: 'latest' },
      ],
    }),
    event('task_complete', second),
  );
  const result = selectCodexNativeContext(jsonl(rows), {
    ...expected,
    turnId: second,
  });
  t.false(result.payload.includes('"old"'));
  t.true(result.payload.includes('"latest"'));
  t.is(result.payload.trimEnd().split('\n').length, 1);
});

test('latest compacted replacement supersedes old history and retains following context', t => {
  const rows = fixture();
  const compacted = row('compacted', {
    message: '',
    replacement_history: [
      {
        type: 'compaction',
        id: 'c',
        encrypted_content: 'SYNTHETIC_COMPACTED_CONTEXT',
      },
    ],
    window_number: 1,
    first_window_id: 'first',
    previous_window_id: 'first',
    window_id: 'second',
  });
  rows.push(
    event('task_started', second),
    compacted,
    message('assistant', 'after compact'),
    event('task_complete', second),
  );
  const text = jsonl(rows);
  t.is(
    selectCodexNativeContext(text, { ...expected, turnId: second }).payload,
    `${text.split('\n')[8]}\n${text.split('\n')[9]}\n`,
  );
});

for (const change of [
  'missing-meta',
  'duplicate-meta',
  'wrong-session',
  'wrong-version',
  'wrong-cwd',
  'missing-start',
  'missing-end',
  'wrong-terminal',
  'later-turn',
  'unknown-row',
  'unknown-item',
  'unsupported-compacted',
  'context-after-terminal',
  'wrong-context-turn',
  'negative-ordinal',
]) {
  test(`selector refuses ${change}`, t => {
    const rows = fixture();
    if (change === 'missing-meta') rows.shift();
    if (change === 'duplicate-meta') rows.splice(2, 0, rows[0]);
    if (change === 'wrong-session') rows[0].payload.id = second;
    if (change === 'wrong-version') rows[0].payload.cli_version = '0.0.0';
    if (change === 'wrong-cwd') rows[0].payload.cwd = '/other';
    if (change === 'missing-start') rows.splice(1, 1);
    if (change === 'missing-end') rows.pop();
    if (change === 'wrong-terminal')
      rows[rows.length - 1].payload.turn_id = second;
    if (change === 'later-turn') rows.push(event('task_started', second));
    if (change === 'unknown-row')
      rows.splice(3, 0, row('future_context_reset', {}));
    if (change === 'unknown-item') rows[2].payload.type = 'unsupported';
    if (change === 'unsupported-compacted')
      rows.splice(3, 0, row('compacted', { message: 'legacy summary' }));
    if (change === 'context-after-terminal')
      rows.push(message('assistant', 'late'));
    if (change === 'wrong-context-turn') rows[4].payload.turn_id = second;
    let text = jsonl(rows);
    if (change === 'negative-ordinal')
      text = text.replace('"ordinal":0', '"ordinal":-1');
    t.throws(() => selectCodexNativeContext(text, expected));
  });
}

test('a prior completed turn is not accepted after a later turn has completed', t => {
  const rows = fixture();
  rows.push(
    event('task_started', second),
    message('assistant', 'later'),
    event('task_complete', second),
  );
  t.throws(() => selectCodexNativeContext(jsonl(rows), expected));
});

test('torn JSONL and oversized input refuse without a partial selection', t => {
  const text = jsonl(fixture());
  t.throws(() => selectCodexNativeContext(text.slice(0, -1), expected));
  t.throws(() => selectCodexNativeContext(`${text}{\n`, expected));
  t.throws(() =>
    selectCodexNativeContext(`${' '.repeat(16 * 1024 * 1024)}\n`, expected),
  );
});

for (const type of [
  'future_context_reset',
  'turn_aborted',
  'task_aborted',
  'thread_rolled_back',
  'error',
]) {
  test(`unsupported event ${type} refuses even with a later task_complete`, t => {
    const rows = fixture();
    rows.splice(-1, 0, event(type, first));
    t.throws(() => selectCodexNativeContext(jsonl(rows), expected));
  });
}

test('known observation events do not enter the exported native context', t => {
  const rows = fixture();
  for (const type of [
    'user_message',
    'agent_message',
    'item_completed',
    'token_count',
    'thread_settings_applied',
  ]) {
    rows.splice(-1, 0, event(type, first));
  }
  const result = selectCodexNativeContext(jsonl(rows), expected);
  t.false(result.payload.includes('event_msg'));
  t.true(result.payload.includes('Synthetic answer'));
});

test('incremental selector resets discarded oversized history at compaction', t => {
  const selector = makeCodexNativeContextSelector(expected);
  const emit = value =>
    selector.accept(
      JSON.stringify({ timestamp: '2026-09-24T08:01:15Z', ...value }),
    );
  emit(fixture()[0]);
  emit(event('task_started', first));
  const large = message('assistant', 'x'.repeat(1024 * 1024));
  for (let i = 0; i < 17; i += 1) emit(large);
  emit(
    row('compacted', {
      message: '',
      replacement_history: [
        { type: 'compaction', encrypted_content: 'small final cut' },
      ],
    }),
  );
  emit(event('task_complete', first));
  const result = selector.finish();
  t.true(result.payload.includes('small final cut'));
  t.true(result.payload.length < 1000);
});

test('an oversized current context is refused without silent truncation', t => {
  const selector = makeCodexNativeContextSelector(expected);
  const emit = value =>
    selector.accept(
      JSON.stringify({ timestamp: '2026-09-24T08:01:15Z', ...value }),
    );
  emit(fixture()[0]);
  emit(event('task_started', first));
  const large = message('assistant', 'x'.repeat(1024 * 1024));
  for (let i = 0; i < 17; i += 1) emit(large);
  emit(event('task_complete', first));
  t.throws(() => selector.finish());
});

test('structural refusal stays sticky even when later history could compact', t => {
  const selector = makeCodexNativeContextSelector(expected);
  selector.accept(JSON.stringify(fixture()[0]));
  t.throws(() => selector.accept(JSON.stringify(row('unknown_context', {}))));
  t.throws(() =>
    selector.accept(
      JSON.stringify(
        row('compacted', {
          message: '',
          replacement_history: [{ type: 'compaction' }],
        }),
      ),
    ),
  );
  t.throws(() => selector.finish());
});

test('requested turn cannot recur after an intervening completed turn', t => {
  const rows = [
    ...fixture(),
    event('task_started', second),
    message('assistant', 'Intervening turn'),
    event('task_complete', second),
    event('task_started', first),
    message('assistant', 'Ambiguous repeated target'),
    event('task_complete', first),
  ];
  t.throws(() => selectCodexNativeContext(jsonl(rows), expected));
});
