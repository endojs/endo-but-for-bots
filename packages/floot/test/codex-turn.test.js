// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeCodexEventTranslator } from '../src/codex-turn.js';

test('translates Codex JSONL events to Floot output', t => {
  const events = [];
  const writer = harden({
    setPhase: phase => events.push(['phase', phase]),
    delta: text => events.push(['delta', text]),
    toolCall: call => events.push(['call', call]),
    toolResult: result => events.push(['result', result]),
  });
  const translator = makeCodexEventTranslator(writer);
  translator.handle({ type: 'thread.started', thread_id: 'thread-1' });
  translator.handle({
    type: 'item.started',
    item: { id: 'cmd-1', type: 'command_execution', command: 'pwd' },
  });
  translator.handle({
    type: 'item.completed',
    item: {
      id: 'cmd-1',
      type: 'command_execution',
      command: 'pwd',
      aggregated_output: '/workspace',
    },
  });
  translator.handle({
    type: 'item.completed',
    item: { id: 'msg-1', type: 'agent_message', text: 'Done.' },
  });
  translator.handle({
    type: 'turn.completed',
    usage: { input_tokens: 12, output_tokens: 3 },
  });

  const result = translator.finish();
  t.is(result.finalText, 'Done.');
  t.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
  t.deepEqual(result.toolCalls, [
    {
      id: 'cmd-1',
      name: 'shell',
      args: '{"command":"pwd"}',
      result: '/workspace',
    },
  ]);
  t.true(events.some(([kind, value]) => kind === 'delta' && value === 'Done.'));
});
