// @ts-check
/**
 * Pin the eval harness's observation seam: the trial runner records the
 * agent's trace by subscribing to pi-agent-core's NATIVE event stream
 * (`piAgent.subscribe`), not via a custom `Hooks` object. `spawnWorkerLoop`
 * forwards an optional `onEvent` subscriber once to `piAgent.subscribe`, and
 * `makeTraceRecorder` (in `optimizer/trial-runner.js`) maps each pi
 * `AgentEvent` onto the `TraceEvent` shape `@endo/agentry/optimizer/trace-metric`
 * scores.
 *
 * Strategy: construct a `PiAgent` the same way `spawnWorkerLoop` does (same
 * tool surface, same `convertToLlm`), subscribe the recorder's `onEvent`,
 * and drive the agent with a scripted `streamFn` so no provider is called.
 * The scripted stream emits one assistant turn carrying a tool call, then a
 * second turn with assistant prose that stops. We then assert the recorded
 * `TraceEvent[]` has the expected `tool-call` (with rawArgs + ok) and the
 * trailing `message` event — proving the subscribe→map path end to end
 * against real pi events, without a live LLM.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

import { makeExecuteTool, toAgentTool } from '../../tool-dispatch.js';
import { tools } from '../../tools/index.js';
import { makeMockPowers } from '../../tools/mock-powers.js';
import { makeTraceRecorder } from '../../optimizer/trial-runner.js';

/**
 * Minimal pi-ai Model placeholder; the scripted streamFn ignores it.
 *
 * @type {any}
 */
const stubModel = harden({
  id: 'stub-model',
  name: 'stub/stub-model',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://invalid.example',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
});

/**
 * Build a scripted streamFn that yields a fresh AssistantMessage per LLM
 * call from a pre-recorded queue; a stop-only message ends the loop once the
 * queue is exhausted.
 *
 * @param {Array<{content: any[], stopReason: string}>} script
 */
const makeScriptedStreamFn = script => {
  let turn = 0;
  return (_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    /** @type {any} */
    const partial = harden({
      role: 'assistant',
      content: [],
      api: stubModel.api,
      provider: stubModel.provider,
      model: stubModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const next = script[turn] || {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'stop',
    };
    turn += 1;
    /** @type {any} */
    const finalMessage = harden({
      ...partial,
      content: next.content,
      stopReason: next.stopReason,
    });
    stream.push({ type: 'start', partial });
    stream.push({
      type: 'done',
      reason: /** @type {'toolUse' | 'stop'} */ (
        next.stopReason === 'toolUse' ? 'toolUse' : 'stop'
      ),
      message: finalMessage,
    });
    stream.end(finalMessage);
    return stream;
  };
};

test('trace recorder maps pi events to TraceEvent[] via piAgent.subscribe', async t => {
  const { powers } = makeMockPowers({
    initialMessage: {
      number: 1,
      from: '@host',
      to: 'lal-self-id',
      strings: ['placeholder; this test drives PiAgent directly'],
      names: [],
      ids: [],
    },
  });

  const executeTool = makeExecuteTool(powers);
  const agentTools = tools.map(({ name, summary }) =>
    toAgentTool(name, summary, executeTool),
  );

  // Turn 1: one `send` tool call with normal args. Turn 2: assistant prose
  // that stops.
  const streamFn = makeScriptedStreamFn([
    {
      content: [
        {
          type: 'toolCall',
          id: 'call-1-send',
          name: 'send',
          arguments: {
            recipientName: '@host',
            strings: ['hello from the recorder test'],
            edgeNames: [],
            petNames: [],
          },
        },
      ],
      stopReason: 'toolUse',
    },
    {
      content: [{ type: 'text', text: 'All done.' }],
      stopReason: 'stop',
    },
  ]);

  const piAgent = new PiAgent({
    initialState: {
      systemPrompt: 'You are a test stub.',
      model: stubModel,
      tools: agentTools,
      messages: [],
      thinkingLevel: 'off',
    },
    convertToLlm: msgs =>
      msgs.filter(
        m =>
          m.role === 'user' ||
          m.role === 'assistant' ||
          m.role === 'toolResult',
      ),
    toolExecution: 'sequential',
    streamFn,
  });

  // This is the seam under test: subscribe the recorder to pi's native
  // event stream, exactly as `spawnWorkerLoop` forwards its `onEvent`.
  const { onEvent, trace } = makeTraceRecorder();
  piAgent.subscribe(onEvent);

  await piAgent.prompt('start');
  await piAgent.waitForIdle();

  // The recorder turned the pi tool-execution event pair into one
  // `tool-call` TraceEvent with the LLM's literal call shape.
  const toolCalls = trace.filter(e => e.kind === 'tool-call');
  t.is(toolCalls.length, 1, 'exactly one tool-call recorded');
  const [call] = /** @type {any[]} */ (toolCalls);
  t.is(call.name, 'send', 'tool-call names the dispatched tool');
  t.true(call.ok, 'successful tool call is recorded ok:true');
  t.true(
    call.rawArgs.includes('hello from the recorder test'),
    'rawArgs carries the JSON-encoded literal call arguments',
  );
  t.deepEqual(
    call.args.strings,
    ['hello from the recorder test'],
    'args record exposes the decoded strings array',
  );

  // The trailing assistant prose was recorded as a `message` TraceEvent.
  const messages = trace.filter(e => e.kind === 'message');
  t.true(messages.length >= 1, 'at least one assistant message recorded');
  const assistant = /** @type {any[]} */ (messages).find(
    m => m.role === 'assistant' && m.content === 'All done.',
  );
  t.truthy(assistant, 'final assistant prose surfaces as a message event');
});
