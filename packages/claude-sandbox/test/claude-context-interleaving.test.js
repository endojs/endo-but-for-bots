// @ts-check
import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import { makeClaudeContextCoverage } from '../src/claude-context-coverage.js';

// The pinned CLI drains completed streaming tools inside its API-stream loop,
// both on tool_drain_tick and after handing off a completed assistant tool block.
// These synthetic frames test that ordering, not real provider signatures.
const uuid = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const fixture = () => {
  const coverage = makeClaudeContextCoverage({
    sha256: text => createHash('sha256').update(text).digest('hex'),
  });
  let sequence = 10;
  /** @type {any[]} */
  const rows = [
    {
      type: 'user',
      uuid: uuid(2),
      parentUuid: null,
      sessionId: uuid(1),
      message: { role: 'user', content: 'prompt' },
    },
  ];
  const observe = event => {
    coverage.observe({ ...event, session_id: uuid(1) });
    if (event.type === 'assistant' || event.type === 'user')
      rows.push({
        type: event.type,
        uuid: event.uuid,
        parentUuid: rows.at(-1).uuid,
        sessionId: uuid(1),
        message: structuredClone(event.message),
      });
  };
  const stream = event => observe({ type: 'stream_event', event });
  const next = () => {
    sequence += 1;
    return uuid(sequence - 1);
  };
  const assistant = content =>
    observe({
      type: 'assistant',
      uuid: next(),
      message: {
        role: 'assistant',
        type: 'message',
        id: 'msg',
        model: 'synthetic',
        content: [content],
      },
    });
  const user = content =>
    observe({
      type: 'user',
      uuid: next(),
      message: { role: 'user', content },
    });
  const result = (id = 'call') =>
    user([{ type: 'tool_result', tool_use_id: id, content: 'done' }]);
  const tool = { type: 'tool_use', id: 'call', name: 'synthetic', input: {} };
  const completeTool = () => {
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    });
    assistant(tool);
  };
  const finish = () => {
    stream({ type: 'message_stop' });
    observe({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
    });
    coverage.assertOutcome('success');
  };
  observe({ type: 'system', subtype: 'init' });
  stream({
    type: 'message_start',
    message: {
      role: 'assistant',
      type: 'message',
      id: 'msg',
      model: 'synthetic',
      content: [],
    },
  });
  stream({ type: 'content_block_start', index: 0, content_block: tool });
  const capture = () =>
    coverage.assertCaptured(
      `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
      {
        sessionId: uuid(1),
        beforeUuid: null,
        beforePayload: '',
        prefixSha256: createHash('sha256').update('').digest('hex'),
        prompt: 'prompt',
        outcome: 'success',
      },
    );
  return {
    coverage,
    stream,
    assistant,
    user,
    result,
    completeTool,
    finish,
    observe,
    capture,
  };
};

test('completed tool result before its stream block stop preserves pending block', t => {
  const f = fixture();
  f.completeTool();
  f.result();
  f.stream({ type: 'content_block_stop', index: 0 });
  t.notThrows(f.finish);
  t.notThrows(f.capture);
});

test('prior completed tool result can interleave a later partial text block', t => {
  const f = fixture();
  f.completeTool();
  f.stream({ type: 'content_block_stop', index: 0 });
  f.stream({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' },
  });
  f.stream({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'before' },
  });
  f.result();
  f.stream({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: ' after' },
  });
  f.assistant({ type: 'text', text: 'before after' });
  f.stream({ type: 'content_block_stop', index: 1 });
  t.notThrows(f.finish);
  t.notThrows(f.capture);
});

test('prior result interleaves partial arguments of a different tool', t => {
  const f = fixture();
  f.completeTool();
  f.stream({ type: 'content_block_stop', index: 0 });
  const second = {
    type: 'tool_use',
    id: 'second',
    name: 'synthetic',
    input: {},
  };
  f.stream({ type: 'content_block_start', index: 1, content_block: second });
  f.stream({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{' },
  });
  f.result();
  f.stream({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '}' },
  });
  f.assistant(second);
  f.result('second');
  f.stream({ type: 'content_block_stop', index: 1 });
  t.notThrows(f.finish);
  t.notThrows(f.capture);
});

test('an interleaved result leaves the open block unfinished', t => {
  const f = fixture();
  f.completeTool();
  f.result();
  // The block was never stopped: the message cannot finish.
  t.throws(() => f.stream({ type: 'message_stop' }));
});

test('a result interleaved once cannot be repeated after the block closes', t => {
  const f = fixture();
  f.completeTool();
  f.result();
  f.stream({ type: 'content_block_stop', index: 0 });
  f.stream({ type: 'message_stop' });
  t.throws(() => f.result());
});

for (const scenario of [
  'unknown',
  'unfinished',
  'duplicate',
  'duplicate-batch',
  'dialogue',
  'mixed',
  'terminal',
]) {
  test(`interleaving refuses ${scenario} without discarding stream requirements`, t => {
    const f = fixture();
    if (scenario !== 'unfinished') f.completeTool();
    if (scenario === 'duplicate' || scenario === 'terminal') f.result();
    t.throws(() => {
      if (scenario === 'duplicate-batch')
        f.user([
          { type: 'tool_result', tool_use_id: 'call', content: 'one' },
          { type: 'tool_result', tool_use_id: 'call', content: 'two' },
        ]);
      else if (scenario === 'dialogue') f.user('unrelated dialogue');
      else if (scenario === 'mixed')
        f.user([
          { type: 'tool_result', tool_use_id: 'call', content: 'done' },
          { type: 'text', text: 'unrelated' },
        ]);
      else if (scenario === 'terminal')
        f.observe({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
        });
      else f.result(scenario === 'unknown' ? 'unknown' : 'call');
    });
    t.throws(() => f.coverage.assertOutcome('success'));
  });
}
