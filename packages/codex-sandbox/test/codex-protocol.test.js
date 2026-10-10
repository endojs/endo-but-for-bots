// @ts-check
import '@endo/init';

import test from 'ava';

import {
  encodeJsonLine,
  parseJsonLines,
  renderToolResult,
  toolFromItem,
} from '../src/codex-protocol.js';

const chunks = parts => ({
  async *[Symbol.asyncIterator]() {
    for (const part of parts) yield new TextEncoder().encode(part);
  },
});

test('JSONL parser handles split, joined, and unterminated records', async t => {
  const values = [];
  for await (const value of parseJsonLines(
    chunks(['{"id":', '1}\n{"method":"x"}\n', '{"id":2}']),
  )) {
    values.push(value);
  }
  t.deepEqual(values, [{ id: 1 }, { method: 'x' }, { id: 2 }]);
  t.is(new TextDecoder().decode(encodeJsonLine({ id: 3 })), '{"id":3}\n');
});

test('JSONL parser rejects malformed and oversized records', async t => {
  await t.throwsAsync(
    async () => {
      for await (const _ of parseJsonLines(chunks(['not-json\n']))) {
        // drain
      }
    },
    { message: /malformed JSONL/ },
  );
  await t.throwsAsync(
    async () => {
      for await (const _ of parseJsonLines(chunks(['{"long":"12345"}']), {
        maxLineBytes: 8,
      })) {
        // drain
      }
    },
    { message: /exceeded.*bytes/ },
  );
  await t.throwsAsync(
    async () => {
      for await (const _ of parseJsonLines(chunks(['    ', '     ']), {
        maxLineBytes: 8,
      })) {
        // drain
      }
    },
    { message: /exceeded.*bytes/ },
  );
  await t.throwsAsync(
    async () => {
      for await (const _ of parseJsonLines(chunks(['         \n']), {
        maxLineBytes: 8,
      })) {
        // drain
      }
    },
    { message: /exceeded.*bytes/ },
  );
});

test('JSONL parser bounds highly fragmented records without per-chunk state', async t => {
  const source = `${JSON.stringify({ text: 'x'.repeat(8192) })}\n`;
  const values = [];
  for await (const value of parseJsonLines(chunks([...source]), {
    maxLineBytes: 16 * 1024,
  })) {
    values.push(value);
  }
  t.deepEqual(values, [{ text: 'x'.repeat(8192) }]);
});

test('JSONL encoder bounds outbound requests', t => {
  t.throws(() => encodeJsonLine({ prompt: 'too large' }, 8), {
    message: /request exceeded.*bytes/,
  });
});

test('web search items preserve query, action, and results', t => {
  t.deepEqual(
    toolFromItem({
      type: 'webSearch',
      id: 'search-1',
      query: 'Endo capabilities',
      action: { type: 'search', queries: ['Endo capabilities'] },
      results: [{ title: 'Endo' }],
    }),
    {
      id: 'search-1',
      name: 'web_search',
      args: {
        query: 'Endo capabilities',
        action: { type: 'search', queries: ['Endo capabilities'] },
      },
      result: [{ title: 'Endo' }],
    },
  );
});

test('tool results render as the text the model saw, not the envelope', t => {
  t.is(renderToolResult('plain'), 'plain');
  t.is(renderToolResult(null), '');
  t.is(renderToolResult(undefined), '');
  // A dynamic tool completes with app-server content items; blocks without a
  // text form are kept as JSON rather than dropped.
  t.is(
    renderToolResult([
      { type: 'inputText', text: 'first' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,AA==' },
      { type: 'inputText', text: 'second' },
    ]),
    'first\n{"type":"inputImage","imageUrl":"data:image/png;base64,AA=="}\nsecond',
  );
  // An MCP tool completes with a CallToolResult.
  t.is(
    renderToolResult({
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { ignored: true },
    }),
    'hello',
  );
  t.is(
    renderToolResult({ content: [], structuredContent: { answer: 42 } }),
    '{"answer":42}',
  );
  t.is(renderToolResult({ message: 'tool exploded' }), 'tool exploded');
  t.is(renderToolResult({ status: 'completed' }), '{"status":"completed"}');
  t.is(renderToolResult([{ title: 'Endo' }]), '{"title":"Endo"}');
});

test('dynamic and MCP tool items flatten to text through the same adapter', t => {
  // Field names per the codex-cli 0.152.0 app-server schema.
  const dynamic = toolFromItem({
    type: 'dynamicToolCall',
    id: 'call-1',
    tool: 'lookup',
    arguments: { name: 'workspace' },
    status: 'completed',
    success: true,
    contentItems: [{ type: 'inputText', text: 'found workspace' }],
  });
  t.is(dynamic?.name, 'lookup');
  t.is(renderToolResult(dynamic?.result), 'found workspace');
  const mcp = toolFromItem({
    type: 'mcpToolCall',
    id: 'call-2',
    server: 'docs',
    tool: 'search',
    arguments: {},
    status: 'completed',
    result: { content: [{ type: 'text', text: 'three hits' }] },
  });
  t.is(mcp?.name, 'docs/search');
  t.is(renderToolResult(mcp?.result), 'three hits');
});
