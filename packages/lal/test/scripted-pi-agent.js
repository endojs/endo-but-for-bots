// @ts-check
/**
 * Shared test scaffolding for driving a `PiAgent`
 * (from `@earendil-works/pi-agent-core`) with a scripted `streamFn` so no LLM
 * provider is contacted. Several lal test files exercise the same
 * production seam `spawnWorkerLoop` uses — a stub `Model`, a scripted stream
 * that emits pre-recorded assistant turns, and the same `convertToLlm`
 * identity-filter — so that setup is factored here.
 *
 * This module is intentionally *not* a test file (its name does not end in
 * `.test.*`), so AVA's `test/` glob does not pick it up as a test.
 */

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Agent as PiAgent } from '@earendil-works/pi-agent-core';

/**
 * Minimal pi-ai Model placeholder. The scripted streamFn ignores the model;
 * pi-agent-core only reads `api`, `provider`, and `id` for diagnostic fields
 * on the resulting AssistantMessage.
 *
 * @type {any}
 */
export const stubModel = harden({
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
 * The `convertToLlm` the production `spawnWorkerLoop` installs: an
 * identity-filter that keeps only the message roles pi-agent-core forwards to
 * the model.
 *
 * @param {Array<any>} msgs
 * @returns {Array<any>}
 */
export const convertToLlm = msgs =>
  msgs.filter(
    m => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  );

/**
 * Build a scripted streamFn that yields a fresh AssistantMessage for each LLM
 * call from a pre-recorded queue. When the queue is exhausted, returns a
 * stop-only assistant message so the agent loop terminates cleanly. An
 * optional `onContext` sink receives the converted message array
 * pi-agent-core forwarded on each call, so a test can assert how many prior
 * messages the next round carried.
 *
 * @param {Array<{content: any[], stopReason: string}>} [script]
 * @param {(context: any[]) => void} [onContext]
 */
export const makeScriptedStreamFn = (script, onContext) => {
  const turns = script || [];
  let turn = 0;
  return (_model, context, _options) => {
    if (onContext) {
      onContext(context);
    }
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
    const next = turns[turn] || {
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
    // Per the AssistantMessageEvent contract, emit `start` (so the loop
    // attaches the partial), then `done` with the final message.
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
harden(makeScriptedStreamFn);

/**
 * A `makeScriptedStreamFn` variant whose first argument is a `contexts` sink:
 * each LLM call appends the converted message array pi-agent-core forwarded.
 * Equivalent to `makeScriptedStreamFn(script, c => contexts.push(c))`; kept as
 * a named helper because the transcript-continuity tests read more clearly
 * with an explicit recording stream.
 *
 * @param {Array<any[]>} contexts - sink: each call appends the `context`
 *   argument pi-agent-core forwarded.
 * @param {Array<{content: any[], stopReason: string}>} [script]
 */
export const makeRecordingScriptedStreamFn = (contexts, script = []) =>
  makeScriptedStreamFn(script, context => contexts.push(context));
harden(makeRecordingScriptedStreamFn);

/**
 * Construct a tool-less `PiAgent` with a scripted streamFn, seeded with
 * `messages`, recording each round's converted LLM context into `contexts`.
 * Mirrors `spawnWorkerLoop`'s construction shape (same `convertToLlm`, same
 * sequential tool execution) minus the tool surface, which the
 * transcript-continuity tests do not exercise.
 *
 * @param {Array<any>} messages
 * @param {Array<any[]>} contexts
 * @returns {PiAgent}
 */
export const makeScriptedAgent = (messages, contexts) =>
  new PiAgent({
    initialState: {
      systemPrompt: 'You are a test stub.',
      model: stubModel,
      tools: [],
      messages,
      thinkingLevel: 'off',
    },
    convertToLlm,
    toolExecution: 'sequential',
    streamFn: makeRecordingScriptedStreamFn(contexts),
  });
harden(makeScriptedAgent);
