// @ts-check
import '@endo/init';
import test from 'ava';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { makeClaudeContextCoverage } from '../src/claude-context-coverage.js';

const id = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const sessionId = id(1);
const prompt = 'Current prompt';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const emptyPrefix = sha256('');
const makeCoverage = () => makeClaudeContextCoverage({ sha256 });

test('actual pinned max-turns failure proves the captured current-turn cut', async t => {
  await null;
  const f = JSON.parse(
    await readFile(
      new URL('./fixtures/coverage-failed-turn.json', import.meta.url),
      'utf8',
    ),
  );
  const coverage = makeCoverage();
  for (const event of f.events) coverage.observe(event);
  const native = `${f.rows.map(row => JSON.stringify(row)).join('\n')}\n`;
  const before = f.rows.findIndex(row => row.uuid === f.cut.beforeUuid);
  const prefixSha256 = sha256(
    `${f.rows
      .slice(0, before + 1)
      .map(row => JSON.stringify(row))
      .join('\n')}\n`,
  );
  t.notThrows(() =>
    coverage.assertCaptured(native, {
      ...f.cut,
      prefixSha256,
      outcome: 'failure',
    }),
  );
});
const fixture = () => {
  const coverage = makeCoverage();
  const events = [];
  const rows = [
    {
      type: 'user',
      sessionId,
      uuid: id(2),
      parentUuid: null,
      message: { role: 'user', content: prompt },
    },
  ];
  const emit = event => {
    const full = { ...event, session_id: sessionId };
    events.push(full);
    coverage.observe(full);
  };
  const stream = event => emit({ type: 'stream_event', event });
  emit({ type: 'system', subtype: 'init' });
  let serial = 3;
  const start = () =>
    stream({
      type: 'message_start',
      message: {
        id: 'm',
        type: 'message',
        model: 'synthetic-model',
        role: 'assistant',
        content: [],
      },
    });
  const block = (value, deltas, final, index = 0) => {
    stream({ type: 'content_block_start', index, content_block: value });
    for (const delta of deltas)
      stream({ type: 'content_block_delta', index, delta });
    const uuid = id(serial);
    serial += 1;
    emit({
      type: 'assistant',
      uuid,
      message: {
        id: 'm',
        type: 'message',
        model: 'synthetic-model',
        role: 'assistant',
        content: [final],
      },
    });
    rows.push({
      type: 'assistant',
      sessionId,
      uuid,
      parentUuid: rows.at(-1).uuid,
      message: {
        id: 'm',
        type: 'message',
        model: 'synthetic-model',
        role: 'assistant',
        content: [final],
      },
    });
    stream({ type: 'content_block_stop', index });
  };
  const stop = () => stream({ type: 'message_stop' });
  const text = (value = 'answer') => {
    start();
    block({ type: 'text', text: '' }, [{ type: 'text_delta', text: value }], {
      type: 'text',
      text: value,
    });
    stop();
  };
  const jsonl = () => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
  let finished = false;
  const finish = (
    result = { type: 'result', subtype: 'success', is_error: false },
  ) => {
    if (!finished) {
      emit(result);
      finished = true;
    }
  };
  const assert = (
    cut = { sessionId, beforeUuid: null, prefixSha256: emptyPrefix, prompt },
  ) => {
    finish();
    return coverage.assertCaptured(jsonl(), { ...cut, outcome: 'success' });
  };
  return {
    coverage,
    events,
    rows,
    emit,
    stream,
    start,
    block,
    stop,
    text,
    jsonl,
    assert,
    finish,
  };
};

test('complete block before stop matches native prompt and dialogue', t => {
  const f = fixture();
  f.text();
  t.notThrows(() => f.assert());
  t.notThrows(() => f.assert());
});

for (const expected of ['success', 'failure']) {
  test(`capture requires observed mainline ${expected} terminal evidence`, t => {
    const f = fixture();
    f.text();
    f.finish({
      type: 'result',
      subtype: expected === 'success' ? 'success' : 'error_max_turns',
      is_error: expected === 'failure',
    });
    t.notThrows(() =>
      f.coverage.assertCaptured(f.jsonl(), {
        sessionId,
        beforeUuid: null,
        prefixSha256: emptyPrefix,
        prompt,
        outcome: /** @type {'success'|'failure'} */ (expected),
      }),
    );
    t.throws(() =>
      f.coverage.assertOutcome(expected === 'success' ? 'failure' : 'success'),
    );
  });
}

test('complete dialogue without mainline terminal result cannot certify a cut', t => {
  const f = fixture();
  f.text();
  f.emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    parent_tool_use_id: 'child',
  });
  t.throws(() => f.coverage.assertOutcome('success'));
});

test('opaque redacted thinking matches exact complete block without deltas', t => {
  const f = fixture();
  const value = { type: 'redacted_thinking', data: 'opaque-synthetic-bytes' };
  f.start();
  f.block(value, [], { ...value });
  f.stop();
  t.notThrows(() => f.assert());
});

test('redacted thinking rejects empty data and any delta', t => {
  for (const data of ['', 'opaque']) {
    const f = fixture();
    f.start();
    const start = () =>
      f.stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data },
      });
    if (!data) t.throws(start);
    else {
      start();
      t.throws(() =>
        f.stream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        }),
      );
    }
    t.throws(() => f.assert());
  }
});

test('thinking/signature and tool JSON deltas must match complete frames', t => {
  const f = fixture();
  f.start();
  f.block(
    { type: 'thinking', thinking: '' },
    [
      { type: 'thinking_delta', thinking: 'reason' },
      { type: 'signature_delta', signature: 'signed' },
    ],
    { type: 'thinking', thinking: 'reason', signature: 'signed' },
  );
  f.block(
    { type: 'tool_use', id: 'call', name: 'Bash', input: {} },
    [
      { type: 'input_json_delta', partial_json: '{"command":' },
      { type: 'input_json_delta', partial_json: '"true"}' },
    ],
    { type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'true' } },
    1,
  );
  f.stop();
  const content = [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }];
  f.emit({ type: 'user', uuid: id(5), message: { role: 'user', content } });
  f.rows.push({
    type: 'user',
    sessionId,
    uuid: id(5),
    parentUuid: id(4),
    message: { role: 'user', content },
  });
  f.rows.push(
    /** @type {any} */ ({
      type: 'attachment',
      sessionId,
      uuid: id(6),
      parentUuid: id(5),
      attachment: { type: 'max_turns_reached', maxTurns: 1, turnCount: 2 },
    }),
  );
  t.notThrows(() => f.assert());
});

test('previous native cut must exist and immediately precede admitted prompt', t => {
  const f = fixture();
  f.text();
  f.rows[0].parentUuid = id(9);
  f.rows.unshift({
    type: 'assistant',
    sessionId,
    uuid: id(9),
    parentUuid: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
  });
  const prefixSha256 = sha256(`${JSON.stringify(f.rows[0])}\n`);
  t.notThrows(() =>
    f.assert({ sessionId, beforeUuid: id(9), prefixSha256, prompt }),
  );
  t.throws(() =>
    f.assert({ sessionId, beforeUuid: id(99), prefixSha256, prompt }),
  );
});

test('same pre-turn leaf cannot conceal modified historical prefix', t => {
  const f = fixture();
  f.text();
  f.rows[0].parentUuid = id(9);
  f.rows.unshift({
    type: 'assistant',
    sessionId,
    uuid: id(9),
    parentUuid: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
  });
  const cut = {
    sessionId,
    beforeUuid: id(9),
    prefixSha256: sha256(`${JSON.stringify(f.rows[0])}\n`),
    prompt,
  };
  t.notThrows(() => f.assert(cut));
  f.rows[0].message.content = [{ type: 'text', text: 'tampered history' }];
  t.throws(() => f.assert(cut));
});

test('prefix receipt binds exact serialization rather than parsed row equality', t => {
  const f = fixture();
  f.text();
  f.rows[0].parentUuid = id(9);
  f.rows.unshift({
    type: 'assistant',
    sessionId,
    uuid: id(9),
    parentUuid: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
  });
  const cut = {
    sessionId,
    beforeUuid: id(9),
    prefixSha256: sha256(`${JSON.stringify(f.rows[0])}\n`),
    prompt,
  };
  const changedBytes = ` ${f.jsonl()}`;
  f.finish();
  t.throws(() =>
    f.coverage.assertCaptured(changedBytes, { ...cut, outcome: 'success' }),
  );
});

for (const change of ['signature', 'grouping', 'duplicate-cut']) {
  test(`trusted receipt rejects historical ${change} mutation`, t => {
    const f = fixture();
    f.text();
    f.rows[0].parentUuid = id(9);
    const prior = {
      type: 'assistant',
      sessionId,
      uuid: id(9),
      parentUuid: null,
      message: {
        id: 'old-group',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'old', signature: 'old-signature' },
        ],
      },
    };
    f.rows.unshift(prior);
    const cut = {
      sessionId,
      beforeUuid: id(9),
      prefixSha256: sha256(`${JSON.stringify(prior)}\n`),
      prompt,
    };
    if (change === 'signature') prior.message.content[0].signature = 'changed';
    if (change === 'grouping') prior.message.id = 'changed';
    if (change === 'duplicate-cut') f.rows.splice(1, 0, { ...prior });
    t.throws(() => f.assert(cut));
  });
}

for (const digest of [undefined, '', 'x'.repeat(64), '0'.repeat(64)]) {
  test(`missing, malformed, or incorrect prefix receipt refuses: ${digest}`, t => {
    const f = fixture();
    f.text();
    t.throws(() =>
      f.assert({ sessionId, beforeUuid: null, prefixSha256: digest, prompt }),
    );
  });
}

test('complete A followed by unpersisted partial B never certifies A as full cut', t => {
  const f = fixture();
  f.text('A');
  f.start();
  f.stream({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  f.stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'partial B' },
  });
  t.throws(() => f.assert());
});

test('empty or init-only observations cannot certify a stale native file', t => {
  const f = fixture();
  t.throws(() => f.assert());
  t.throws(() =>
    makeCoverage().assertCaptured(f.jsonl(), {
      sessionId,
      beforeUuid: null,
      prefixSha256: emptyPrefix,
      prompt,
      outcome: 'success',
    }),
  );
});

for (const change of [
  'prompt',
  'content',
  'uuid',
  'message-id',
  'message-type',
  'message-model',
  'order',
  'ancestry',
  'session',
  'missing',
  'extra',
]) {
  test(`captured ${change} mismatch refuses and stays refused`, t => {
    const f = fixture();
    f.text('A');
    f.text('B');
    if (change === 'prompt') f.rows[0].message.content = 'stale';
    if (change === 'content')
      f.rows[1].message.content = [{ type: 'text', text: 'different' }];
    if (change === 'uuid') f.rows[1].uuid = id(99);
    if (change === 'message-id') f.rows[1].message.id = 'changed-group';
    if (change === 'message-type') f.rows[1].message.type = 'changed-type';
    if (change === 'message-model') f.rows[1].message.model = 'changed-model';
    if (change === 'order') [f.rows[1], f.rows[2]] = [f.rows[2], f.rows[1]];
    if (change === 'ancestry') f.rows[2].parentUuid = id(2);
    if (change === 'session') f.rows[1].sessionId = id(99);
    if (change === 'missing') f.rows.pop();
    if (change === 'extra')
      f.rows.push({ ...f.rows[2], uuid: id(99), parentUuid: f.rows[2].uuid });
    t.throws(() => f.assert());
    t.throws(() => f.emit({ type: 'system', subtype: 'status' }));
  });
}

for (const event of [
  { type: 'system', subtype: 'compact_boundary' },
  { type: 'new_protocol' },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'orphan' },
    },
  },
]) {
  test(`unsupported ${JSON.stringify(event)} is sticky refusal`, t => {
    const f = fixture();
    f.text();
    t.throws(() => f.emit(event));
    t.throws(() => f.assert());
  });
}

test('unmatched stop and mutated complete block refuse', t => {
  for (const complete of [false, true]) {
    const f = fixture();
    f.start();
    f.stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    f.stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'actual' },
    });
    if (complete)
      t.throws(() =>
        f.emit({
          type: 'assistant',
          uuid: id(3),
          message: {
            id: 'm',
            role: 'assistant',
            content: [{ type: 'text', text: 'changed' }],
          },
        }),
      );
    else t.throws(() => f.stream({ type: 'content_block_stop', index: 0 }));
  }
});

for (const flag of [
  'isCompactSummary',
  'isVisibleInTranscriptOnly',
  'isMeta',
]) {
  for (const rowIndex of [0, 1]) {
    test(`unobserved loader role ${flag} on current row ${rowIndex} refuses`, t => {
      const f = fixture();
      f.text();
      f.rows[rowIndex][flag] = true;
      t.throws(() => f.assert(), { message: /coverage unavailable/ });
    });
  }
}

test('explicit false loader flags preserve ordinary-turn coverage', t => {
  const f = fixture();
  f.text();
  for (const row of f.rows) {
    row.isCompactSummary = false;
    row.isVisibleInTranscriptOnly = false;
    row.isMeta = false;
  }
  t.notThrows(() => f.assert());
});

test('16Mi observation bound refuses instead of truncating', t => {
  const f = fixture();
  t.throws(() =>
    f.emit({
      type: 'system',
      subtype: 'status',
      ignored: 'x'.repeat(16 * 1024 * 1024),
    }),
  );
  t.throws(() => f.assert());
});

test('caller mutation cannot rewrite retained complete frame evidence', t => {
  const f = fixture();
  f.text();
  const captured = f.jsonl();
  const event = f.events.find(e => e.type === 'assistant');
  event.message.content[0].text = 'changed externally';
  f.finish();
  t.notThrows(() =>
    f.coverage.assertCaptured(captured, {
      sessionId,
      beforeUuid: null,
      prefixSha256: emptyPrefix,
      prompt,
      outcome: 'success',
    }),
  );
});

test('different mainline session refuses; subagent traffic cannot supply proof', t => {
  const f = fixture();
  f.coverage.observe({
    type: 'assistant',
    parent_tool_use_id: 'subagent',
    session_id: id(9),
  });
  f.text();
  t.notThrows(() => f.assert());
  t.throws(() =>
    f.coverage.observe({
      type: 'system',
      subtype: 'status',
      session_id: id(9),
    }),
  );
});
