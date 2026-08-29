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

test('translates Codex programmatic tool calls with separate results', t => {
  const events = [];
  const writer = harden({
    setPhase: phase => events.push(['phase', phase]),
    delta: text => events.push(['delta', text]),
    toolCall: call => events.push(['call', call]),
    toolResult: result => events.push(['result', result]),
  });
  const translator = makeCodexEventTranslator(writer);
  translator.handle({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'custom-1',
      call_id: 'call-1',
      name: 'exec',
      input: 'const result = await tools.exec_command({ cmd: "uptime" });',
    },
  });
  translator.handle({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-1',
      output: 'bwrap: setting up uid map: Operation not permitted',
    },
  });

  t.deepEqual(translator.finish().toolCalls, [
    {
      id: 'call-1',
      name: 'exec',
      args: JSON.stringify({
        input: 'const result = await tools.exec_command({ cmd: "uptime" });',
      }),
      result: 'bwrap: setting up uid map: Operation not permitted',
    },
  ]);
  t.true(events.some(([kind]) => kind === 'call'));
  t.true(events.some(([kind]) => kind === 'result'));
});

test('preserves a programmatic MCP approval failure', t => {
  const events = [];
  const writer = harden({
    setPhase: phase => events.push(['phase', phase]),
    delta: text => events.push(['delta', text]),
    toolCall: call => events.push(['call', call]),
    toolResult: result => events.push(['result', result]),
  });
  const translator = makeCodexEventTranslator(writer);
  translator.handle({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      call_id: 'call-health',
      name: 'exec',
      input: 'const r = await tools.mcp__endo__exec({ code: "health" });',
    },
  });
  translator.handle({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-health',
      output: [
        { type: 'input_text', text: 'Script completed' },
        {
          type: 'input_text',
          text: 'MCP tool call requires approval, but approval policy is never',
        },
      ],
    },
  });

  const result = translator.finish();
  t.is(
    result.toolCalls[0].result,
    'Script completed\nMCP tool call requires approval, but approval policy is never',
  );
  t.deepEqual(events.find(([kind]) => kind === 'result')?.[1], {
    id: 'call-health',
    name: 'exec',
    result:
      'Script completed\nMCP tool call requires approval, but approval policy is never',
  });
});

test('reports a missing Codex tool result instead of persisting null', t => {
  const events = [];
  const writer = harden({
    setPhase: phase => events.push(['phase', phase]),
    delta: text => events.push(['delta', text]),
    toolCall: call => events.push(['call', call]),
    toolResult: result => events.push(['result', result]),
  });
  const translator = makeCodexEventTranslator(writer);
  translator.handle({
    type: 'item.started',
    item: {
      id: 'mcp-1',
      type: 'mcp_tool_call',
      server: 'endo',
      tool: 'exec',
      arguments: { code: 'return 1' },
    },
  });

  const result = translator.finish();
  t.is(
    result.toolCalls[0].result,
    'Codex completed the turn without reporting a tool result.',
  );
  t.true(events.some(([kind]) => kind === 'result'));
});
