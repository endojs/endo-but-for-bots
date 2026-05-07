// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  toOpenAIChatMessages,
  toOpenAIChatTools,
  parseOpenAIChatChoice,
  truncateMessages,
} from '../providers/openai-chat.js';

/** @import { CommonChatMessage } from '../providers/openai-chat.js' */

test('toOpenAIChatTools passes tools through unchanged', t => {
  const tools = harden([
    {
      type: 'function',
      function: { name: 'foo', description: 'd', parameters: {} },
    },
  ]);
  t.is(toOpenAIChatTools(tools), tools);
});

test('toOpenAIChatMessages converts system/user/tool/assistant roles', t => {
  /** @type {CommonChatMessage[]} */
  const input = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'tool', content: 'result', tool_call_id: 'call_1' },
  ];
  const result = toOpenAIChatMessages(input);
  t.deepEqual(result, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ]);
});

test('toOpenAIChatMessages emits tool_calls with type: function', t => {
  /** @type {CommonChatMessage[]} */
  const input = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', function: { name: 'foo', arguments: '{"x":1}' } },
      ],
    },
  ];
  const result = toOpenAIChatMessages(input);
  t.deepEqual(result, [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'foo', arguments: '{"x":1}' },
        },
      ],
    },
  ]);
});

test('toOpenAIChatMessages stringifies object arguments', t => {
  /** @type {CommonChatMessage[]} */
  const input = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', function: { name: 'foo', arguments: { x: 1 } } },
      ],
    },
  ];
  const result = toOpenAIChatMessages(input);
  const [msg] = result;
  t.is(msg.role, 'assistant');
  t.is(
    /** @type {any} */ (msg).tool_calls[0].function.arguments,
    '{"x":1}',
  );
});

test('parseOpenAIChatChoice returns empty assistant message for missing choice', t => {
  t.deepEqual(parseOpenAIChatChoice(undefined), {
    role: 'assistant',
    content: '',
  });
});

test('parseOpenAIChatChoice extracts content', t => {
  t.deepEqual(
    parseOpenAIChatChoice({ message: { role: 'assistant', content: 'hi' } }),
    { role: 'assistant', content: 'hi' },
  );
});

test('parseOpenAIChatChoice extracts tool_calls', t => {
  const result = parseOpenAIChatChoice({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          function: { name: 'foo', arguments: '{"x":1}' },
        },
      ],
    },
  });
  t.deepEqual(result, {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', function: { name: 'foo', arguments: '{"x":1}' } },
    ],
  });
});

test('truncateMessages no-ops below threshold', t => {
  /** @type {CommonChatMessage[]} */
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ];
  t.is(truncateMessages(msgs, 5), msgs);
  t.is(truncateMessages(msgs, undefined), msgs);
  t.is(truncateMessages(msgs, 0), msgs);
});

test('truncateMessages slices to last N when over threshold', t => {
  /** @type {CommonChatMessage[]} */
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'user', content: 'c' },
  ];
  const silent = harden({ log: () => {}, error: () => {}, warn: () => {} });
  t.deepEqual(truncateMessages(msgs, 2, silent), [
    { role: 'user', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
});
