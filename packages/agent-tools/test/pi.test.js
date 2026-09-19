// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';

import { makeTool } from '../src/tool.js';
import { toPiAgentTool } from '../src/adapters/pi.js';

/**
 * @param {unknown} result
 * @returns {import('../src/types.js').ToolRecord}
 */
const toolReturning = result =>
  makeTool({
    name: 'echo',
    description: 'Echo a fixed result.',
    parameters: harden({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    execute: async () => result,
  });

/**
 * @param {unknown} result
 * @param {number} maxBytes
 * @returns {import('../src/types.js').ToolRecord}
 */
const boundedToolReturning = (result, maxBytes) =>
  makeTool({
    name: 'bounded',
    description: 'A bounded result.',
    parameters: harden({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    resultPolicy: { maxBytes },
    execute: async () => result,
  });

/**
 * @param {{ type: string, text?: string }} content
 * @returns {string}
 */
const textOf = content => {
  if (typeof content.text !== 'string') {
    throw new Error('expected text content');
  }
  return content.text;
};

test('toPiAgentTool copies the model-facing surface verbatim', t => {
  const tool = toolReturning('ok');
  const agentTool = toPiAgentTool(tool);
  t.is(agentTool.name, 'echo');
  t.is(agentTool.label, 'echo');
  t.is(agentTool.description, 'Echo a fixed result.');
  t.is(agentTool.parameters, tool.parameters);
});

test('default render passes strings through and JSON-stringifies the rest', async t => {
  const stringTool = toPiAgentTool(toolReturning('plain text'));
  const stringResult = await stringTool.execute('id-1', {});
  t.deepEqual(stringResult.content, [{ type: 'text', text: 'plain text' }]);
  t.is(stringResult.details, 'plain text');

  const objectTool = toPiAgentTool(toolReturning(harden({ a: 1 })));
  const objectResult = await objectTool.execute('id-2', {});
  t.deepEqual(objectResult.content, [{ type: 'text', text: '{"a":1}' }]);
});

test('result policy preserves exact fills and marks over-limit strings', async t => {
  const exact = toPiAgentTool(boundedToolReturning('12345', 5));
  const exactResult = await exact.execute('id-exact', {});
  t.deepEqual(exactResult.content, [{ type: 'text', text: '12345' }]);

  const overText = '1234567890'.repeat(20);
  const over = toPiAgentTool(boundedToolReturning(overText, 100));
  const overResult = await over.execute('id-over', {});
  const text = textOf(overResult.content[0]);
  t.true(text.includes('[truncated:'));
  t.is(new TextEncoder().encode(text).length, 100);
  t.true(text.includes('total 200 bytes'));
  t.is(overResult.details, overText);
});

test('result policy reserves marker space and respects UTF-8 boundaries', async t => {
  const tool = toPiAgentTool(boundedToolReturning('😀'.repeat(100), 100));
  const result = await tool.execute('id-unicode', {});
  const text = textOf(result.content[0]);
  t.true(text.includes('[truncated:'));
  t.true(new TextEncoder().encode(text).length <= 100);
  t.is(text, [...text].join(''), 'never leave a partial surrogate');
  t.is(result.details, '😀'.repeat(100));
});

test('a structured result is clipped only after rendering', async t => {
  const value = { value: 'abcdefghij'.repeat(20) };
  const tool = toPiAgentTool(boundedToolReturning(value, 64));
  const result = await tool.execute('id-structured', {});
  t.true(textOf(result.content[0]).includes('[truncated'));
  t.deepEqual(result.details, value);
});

test('the renderToolResult hook controls the rendered text', async t => {
  const seen = [];
  const tool = toPiAgentTool(toolReturning(harden({ value: 42 })), {
    renderToolResult: result => {
      seen.push(result);
      return 'RENDERED';
    },
  });
  const result = await tool.execute('id-3', {});
  t.deepEqual(result.content, [{ type: 'text', text: 'RENDERED' }]);
  // The raw value is retained as structured details for non-text consumers.
  t.deepEqual(result.details, { value: 42 });
  t.deepEqual(seen, [{ value: 42 }]);
});

test('renderCall and renderResult pass through opaquely when supplied', t => {
  const renderCall = () => 'call-component';
  const renderResult = () => 'result-component';
  const withRenderers = toPiAgentTool(toolReturning('ok'), {
    renderCall,
    renderResult,
  });
  t.is(withRenderers.renderCall, renderCall);
  t.is(withRenderers.renderResult, renderResult);

  const withoutRenderers = toPiAgentTool(toolReturning('ok'));
  t.false('renderCall' in withoutRenderers);
  t.false('renderResult' in withoutRenderers);
});

test('toPiAgentTool forwards pi AbortSignal as invocation context', async t => {
  /** @type {AbortSignal | undefined} */
  let received;
  const tool = makeTool({
    name: 'signal',
    description: 'Observe invocation context.',
    parameters: harden({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    execute: async (_args, context) => {
      received = context?.signal;
      return 'ok';
    },
  });
  const agentTool = toPiAgentTool(tool);
  const controller = new AbortController();
  await agentTool.execute('id-4', {}, controller.signal);
  t.is(received, controller.signal);
});
