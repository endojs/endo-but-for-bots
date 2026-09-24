// @ts-check
import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import { makeClaudeContextCoverage } from '../src/claude-context-coverage.js';

// Live 2026-09-25: the model streamed Edit's input without `replace_all`;
// the CLI stored it with its schema default filled in, and coverage refused
// at `observe/assistant/input-value`.
const uuid = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

const run = (name, streamedInput, finalInput) => {
  const coverage = makeClaudeContextCoverage({
    sha256: text => createHash('sha256').update(text).digest('hex'),
  });
  const observe = event => coverage.observe({ ...event, session_id: uuid(1) });
  const stream = event => observe({ type: 'stream_event', event });
  const start = { type: 'tool_use', id: 'call', name, input: {} };
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
  stream({ type: 'content_block_start', index: 0, content_block: start });
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: JSON.stringify(streamedInput),
    },
  });
  observe({
    type: 'assistant',
    uuid: uuid(3),
    message: {
      role: 'assistant',
      type: 'message',
      id: 'msg',
      model: 'synthetic',
      content: [{ ...start, input: finalInput }],
    },
  });
  stream({ type: 'content_block_stop', index: 0 });
};

const edit = { file_path: '/workspace/a', old_string: 'x', new_string: 'y' };

test('a built-in tool may gain the CLI schema defaults', t => {
  t.notThrows(() => run('Edit', edit, { replace_all: false, ...edit }));
});

for (const [label, name, finalInput] of [
  ['an MCP tool gaining a key', 'mcp__endo__exec', { ...edit, extra: true }],
  [
    'a built-in tool changing a streamed value',
    'Edit',
    { ...edit, new_string: 'z' },
  ],
  [
    'a built-in tool dropping a streamed key',
    'Edit',
    { file_path: '/workspace/a' },
  ],
]) {
  test(`coverage refuses ${label}`, t => {
    t.throws(() => run(name, edit, finalInput), {
      message: /native context coverage unavailable/,
    });
  });
}
