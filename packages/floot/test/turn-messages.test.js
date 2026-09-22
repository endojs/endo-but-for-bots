// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { UNSETTLED_TOOL_RESULT } from '../src/hosted-turn.js';
import { hostedTurnMessages } from '../src/turn-messages.js';

test('segments commit in the order the backend reported them', t => {
  const messages = hostedTurnMessages({
    replyText: 'ignored when segments exist',
    segments: [
      { type: 'text', text: 'Let me look.' },
      {
        type: 'thinking',
        text: 'privately',
        startedAt: 1,
        endedAt: 2,
        truncated: false,
      },
      {
        type: 'tools',
        calls: [{ id: 'c1', name: 'read', args: '{"p":1}', result: 'A' }],
      },
      { type: 'compaction', summary: 'so far' },
      { type: 'text', text: '' },
      { type: 'text', text: 'Done.' },
    ],
  });
  t.deepEqual(messages, [
    { role: 'assistant', content: 'Let me look.' },
    {
      role: 'thinking',
      content: 'privately',
      thinking: { startedAt: 1, endedAt: 2, truncated: false },
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'read', arguments: '{"p":1}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'A' },
    { role: 'compaction', content: 'so far' },
    { role: 'assistant', content: 'Done.' },
  ]);
});

test('a backend without segments commits one tool round and then the reply', t => {
  t.deepEqual(
    hostedTurnMessages({
      replyText: 'Answer',
      toolCalls: [{ id: 'c1', name: 'read', args: '{}', result: null }],
    }),
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
        ],
      },
      // A call the turn ended before settling says so.
      { role: 'tool', tool_call_id: 'c1', content: UNSETTLED_TOOL_RESULT },
      { role: 'assistant', content: 'Answer' },
    ],
  );
});

test('an empty reply is recorded for a completed turn and omitted for a mirrored one', t => {
  t.deepEqual(hostedTurnMessages({ replyText: '', recordEmptyReply: true }), [
    { role: 'assistant', content: '' },
  ]);
  t.deepEqual(hostedTurnMessages({ replyText: '' }), []);
  t.deepEqual(hostedTurnMessages({ replyText: '', segments: [] }), []);
  // A mirrored turn that stopped after its tool round and before any reply
  // records the round and nothing after it.
  t.deepEqual(
    hostedTurnMessages({
      replyText: '',
      toolCalls: [{ id: 'c1', name: 'read', args: '{}', result: 'A' }],
    }).map(message => message.role),
    ['assistant', 'tool'],
  );
});
