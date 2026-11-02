// @ts-check
import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import { makeClaudeContextCoverage } from '../src/claude-context-coverage.js';

// Live 2026-09-25: a turn whose tools took no arguments (`list`,
// `listMessages`) failed at `observe/assistant, check=10`, because the stream
// carries no input JSON for an empty input.
const uuid = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

const run = (deltas, finalInput, name = 'mcp__endo__list') => {
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
  for (const partial of deltas) {
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: partial },
    });
  }
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
  return coverage;
};

for (const deltas of [[], [''], ['', '']]) {
  test(`no-argument tool completes with ${deltas.length} empty input fragments`, t => {
    t.notThrows(() => run(deltas, {}));
  });
}

test('arguments streamed as {} still complete', t => {
  t.notThrows(() => run(['{', '}'], {}));
});

test('an argument missing from the stream is still refused', t => {
  t.throws(() => run([], { path: '/' }), {
    message: /native context coverage unavailable/,
  });
});

// A built-in CLI tool runs inside the guest's sandbox, and its stored input
// may carry schema defaults the model never streamed; see
// claude-context-cli-defaults.test.js. Only MCP tools must match exactly.
test('a built-in tool may carry keys the stream did not show', t => {
  t.notThrows(() => run([], { path: '/' }, 'Read'));
});

test('streamed arguments still must match the completed block', t => {
  t.throws(() => run(['{"path":"/"}'], {}), {
    message: /native context coverage unavailable/,
  });
});
