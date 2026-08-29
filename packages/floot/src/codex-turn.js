// @ts-check
// Translate `codex exec --json` events from @endo/codex-sandbox into Floot's
// normalized reply stream. Codex owns its agent loop and conversation thread;
// Floot mirrors text/tool activity for display and persistence only.

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

const itemTool = item => {
  if (item.type === 'command_execution') {
    return harden({ name: 'shell', args: { command: item.command || '' } });
  }
  if (item.type === 'mcp_tool_call') {
    return harden({
      name: `${item.server || 'mcp'}/${item.tool || item.name || 'tool'}`,
      args: item.arguments || item.args || {},
    });
  }
  if (item.type === 'file_change') {
    return harden({ name: 'file_change', args: item.changes || item });
  }
  if (item.type === 'web_search') {
    return harden({ name: 'web_search', args: { query: item.query || '' } });
  }
  return undefined;
};

const itemResult = item => {
  for (const key of ['aggregated_output', 'output', 'result', 'error']) {
    if (item[key] !== undefined) {
      return typeof item[key] === 'string'
        ? item[key]
        : JSON.stringify(item[key]);
    }
  }
  return item.status ? `${item.status}` : '';
};

/** @param {object} writer */
export const makeCodexEventTranslator = writer => {
  const w = /** @type {any} */ (writer);
  /** @type {Array<{ id: string, name: string, args: string, result: string | null }>} */
  const toolCalls = [];
  /** @type {Map<string, { id: string, name: string, args: string, result: string | null }>} */
  const callsById = new Map();
  let finalText = '';
  let errorReason;
  /** @type {{ inputTokens: number, outputTokens: number } | undefined} */
  let usage;

  const handle = event => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'thread.started') {
      w.setPhase('codex session starting');
      return;
    }
    if (event.type === 'turn.started') {
      w.setPhase('thinking');
      return;
    }
    if (event.type === 'item.started' || event.type === 'item.completed') {
      const item = event.item;
      if (!item || typeof item !== 'object') return;
      if (
        event.type === 'item.completed' &&
        item.type === 'agent_message' &&
        typeof item.text === 'string'
      ) {
        finalText += item.text;
        w.setPhase('responding');
        w.delta(item.text);
        return;
      }
      if (item.type === 'reasoning' || item.type === 'plan_update') {
        w.setPhase('thinking');
        return;
      }
      const tool = itemTool(item);
      if (!tool) return;
      const id = `${item.id || `${item.type}-${toolCalls.length + 1}`}`;
      const args = JSON.stringify(tool.args);
      let call = callsById.get(id);
      if (!call) {
        call = { id, name: tool.name, args, result: null };
        callsById.set(id, call);
        toolCalls.push(call);
        w.toolCall({ id, name: tool.name, args });
      }
      w.setPhase('using tools');
      if (event.type === 'item.completed') {
        const result = itemResult(item);
        call.result = result;
        w.toolResult({ id, name: call.name, result });
      }
      return;
    }
    if (event.type === 'turn.completed') {
      usage = {
        inputTokens: Number(event.usage?.input_tokens) || 0,
        outputTokens: Number(event.usage?.output_tokens) || 0,
      };
      return;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      errorReason = `${
        event.error?.message || event.message || event.error || event.type
      }`;
    }
  };

  const finish = () =>
    harden({
      finalText,
      usage,
      errorReason,
      toolCalls: toolCalls.map(call => harden({ ...call })),
    });
  return harden({ handle, finish });
};
harden(makeCodexEventTranslator);

/**
 * @param {{ client: any, text: string, writer: object, signal?: AbortSignal, model?: string, thinking?: string, systemPrompt?: string }} options
 */
export const runCodexTurn = async ({
  client,
  text,
  writer,
  signal,
  model,
  thinking,
  systemPrompt,
}) => {
  const translator = makeCodexEventTranslator(writer);
  const reader = await E(client).send(
    text,
    harden({
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    }),
  );
  const iterator = iterateReader(/** @type {any} */ (reader));
  const onAbort = () => {
    iterator.return().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    for await (const rawEvent of iterator) {
      const event = /** @type {any} */ (rawEvent);
      if (event?.type === 'end') break;
      if (event?.type === 'abort') {
        throw new Error(`${event.reason || 'codex turn aborted'}`);
      }
      translator.handle(event);
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  const result = translator.finish();
  if (result.errorReason !== undefined && !signal?.aborted) {
    throw new Error(`codex turn failed: ${result.errorReason}`);
  }
  return harden({
    finalContent: result.finalText,
    usage: result.usage,
    toolCalls: result.toolCalls,
  });
};
harden(runCodexTurn);
