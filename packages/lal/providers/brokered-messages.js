// @ts-check
// prefer-endo-primitives-exempt: this provider is the SSE/TextDecoder bridge.

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { mustMatch, M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

import { toAnthropicMessages, toAnthropicTools } from './anthropic.js';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** @param {AsyncIterableIterator<Uint8Array>} bytes */
const anthropicEvents = async function* anthropicEventIterator(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data = [];
  let size = 0;
  const takeEvent = () => {
    const text = data.join('\n');
    data = [];
    try {
      return JSON.parse(text);
    } catch {
      throw Error('Invalid Anthropic Messages stream event');
    }
  };
  /**
   * Split complete lines off `pending`. Until the stream ends, a trailing CR
   * may be the first half of a CRLF, so it waits for the next chunk.
   *
   * @param {boolean} ended
   */
  const takeLines = function* takeLineIterator(ended) {
    const terminator = ended
      ? /^(.*?)(\r\n|\n|\r)/s
      : /^(.*?)(\r\n|\n|\r(?!$))/s;
    for (;;) {
      const match = terminator.exec(pending);
      if (!match) break;
      pending = pending.slice(match[0].length);
      const line = match[1];
      if (line === '') {
        if (data.length > 0) yield takeEvent();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  };
  for await (const chunk of bytes) {
    size += Number(chunk.byteLength);
    size <= MAX_RESPONSE_BYTES ||
      Fail`Anthropic stream exceeds transport bound`;
    pending += decoder.decode(chunk, { stream: true });
    yield* takeLines(false);
  }
  pending += decoder.decode();
  yield* takeLines(true);
  (!pending.trim() && data.length === 0) ||
    Fail`Truncated Anthropic Messages stream event`;
};

/** @param {any} recipe */
export const assertBrokeredMessagesRecipe = recipe => {
  const fields = harden(['kind', 'inference', 'model', 'maxTokens']);
  (recipe &&
    recipe.kind === 'brokered-messages' &&
    Reflect.ownKeys(recipe).every(key => fields.includes(String(key))) &&
    MODEL_PATTERN.test(recipe.model) &&
    (recipe.maxTokens === undefined ||
      (Number.isSafeInteger(recipe.maxTokens) &&
        Number(recipe.maxTokens) > 0))) ||
    Fail`Invalid brokered Messages recipe`;
  mustMatch(recipe.inference, M.remotable(), 'AgentInference capability');
};
harden(assertBrokeredMessagesRecipe);

/**
 * Anthropic Messages adapter over a bounded AgentInference capability. The
 * recipe contains no URL or credential; those remain in the host broker.
 *
 * @param {object} options
 * @param {any} options.inference
 * @param {string} options.model
 * @param {number} [options.maxTokens]
 */
export const makeBrokeredMessagesProvider = ({
  inference,
  model,
  maxTokens = 4096,
}) => {
  assertBrokeredMessagesRecipe(
    harden({ kind: 'brokered-messages', inference, model, maxTokens }),
  );
  let disposed = false;
  /** @type {Set<(reason: unknown) => void>} */
  const cancellations = new Set();

  /**
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {(text: string) => void} [onToken]
   * @param {AbortSignal} [signal]
   * @param {(usage: any) => void} [onUsage]
   */
  const chatStream = async (messages, tools, onToken, signal, onUsage) => {
    await null;
    !disposed || Fail`Brokered Messages provider disposed`;
    signal?.throwIfAborted();
    const { system, messages: anthropicMessages } =
      toAnthropicMessages(messages);
    const request = harden({
      method: 'POST',
      path: '/v1/messages',
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        system,
        messages: anthropicMessages,
        ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
      }),
    });
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => undefined);
    const wait = promise => Promise.race([promise, cancelled.promise]);
    /** @type {AsyncIterableIterator<Uint8Array> | undefined} */
    let iterator;
    /** @param {unknown} reason */
    const cancel = reason => {
      cancelled.reject(reason);
      void iterator?.return?.().catch(() => undefined);
    };
    cancellations.add(cancel);
    const abort = () =>
      cancel(signal?.reason ?? Error('Brokered Messages inference cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await wait(E(inference).requestByteStream(request));
      if (response.status === 401)
        throw Error('Anthropic authentication failed');
      if (response.status === 429) throw Error('Anthropic rate limit reached');
      (response.status === 200 &&
        /^text\/event-stream(?:;|$)/i.test(response.contentType ?? '')) ||
        Fail`Anthropic Messages inference failed`;
      iterator = iterateBytesReader(response.reader);
      const events = anthropicEvents(iterator);
      const blocks = new Map();
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let stopped = false;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const next = await wait(events.next());
        if (next.done) break;
        const event = next.value;
        if (event.type === 'error')
          throw Error('Anthropic Messages inference failed');
        if (event.type === 'message_start') {
          inputTokens = Number(event.message?.usage?.input_tokens) || 0;
          cacheReadTokens =
            Number(event.message?.usage?.cache_read_input_tokens) || 0;
          cacheWriteTokens =
            Number(event.message?.usage?.cache_creation_input_tokens) || 0;
        } else if (event.type === 'content_block_start') {
          const index = Number(event.index);
          (Number.isSafeInteger(index) && index >= 0 && !blocks.has(index)) ||
            Fail`Invalid Anthropic content block`;
          if (event.content_block?.type === 'text') {
            blocks.set(index, {
              type: 'text',
              text: event.content_block.text || '',
            });
          } else if (event.content_block?.type === 'tool_use') {
            blocks.set(index, {
              type: 'tool_use',
              id: event.content_block.id,
              name: event.content_block.name,
              json: '',
            });
          } else {
            throw Error('Unsupported Anthropic content block');
          }
        } else if (event.type === 'content_block_delta') {
          const block = blocks.get(event.index);
          block !== undefined || Fail`Anthropic delta has no content block`;
          if (event.delta?.type === 'text_delta' && block.type === 'text') {
            block.text += event.delta.text;
            onToken?.(event.delta.text);
          } else if (
            event.delta?.type === 'input_json_delta' &&
            block.type === 'tool_use'
          ) {
            block.json += event.delta.partial_json;
          } else {
            throw Error('Invalid Anthropic content delta');
          }
        } else if (event.type === 'message_delta') {
          outputTokens = Number(event.usage?.output_tokens) || outputTokens;
        } else if (event.type === 'message_stop') {
          stopped = true;
        }
      }
      stopped || Fail`Anthropic Messages stream ended without message_stop`;
      const message = { role: 'assistant', content: '' };
      const toolCalls = [];
      for (const [, block] of [...blocks.entries()].sort(
        ([left], [right]) => left - right,
      )) {
        if (block.type === 'text') {
          message.content += block.text;
        } else {
          let input;
          try {
            input = block.json === '' ? {} : JSON.parse(block.json);
          } catch {
            throw Error('Invalid Anthropic tool input');
          }
          toolCalls.push({
            id: block.id,
            function: { name: block.name, arguments: JSON.stringify(input) },
          });
        }
      }
      if (toolCalls.length) message.tool_calls = toolCalls;
      const usage = harden({
        inputTokens,
        outputTokens,
        cachedInputTokens: cacheReadTokens,
        cacheWriteInputTokens: cacheWriteTokens,
        reasoningOutputTokens: 0,
        context: {
          usedTokens:
            inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
          windowTokens: 0,
        },
      });
      onUsage?.(usage);
      return harden({ message: harden(message), usage });
    } finally {
      signal?.removeEventListener('abort', abort);
      cancellations.delete(cancel);
      void iterator?.return?.().catch(() => undefined);
    }
  };

  return harden({
    chat: (messages, tools, signal) =>
      chatStream(messages, tools, undefined, signal, undefined),
    chatStream,
    async dispose() {
      disposed = true;
      for (const cancel of cancellations) {
        cancel(Error('Brokered Messages provider disposed'));
      }
    },
  });
};
harden(makeBrokeredMessagesProvider);

/** @param {any[]} messages */
const commonMessages = messages =>
  messages.map(message => {
    if (message.role === 'system' || message.role === 'user') {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter(part => part.type === 'text')
              .map(part => part.text)
              .join('\n');
      return harden({ role: message.role, content });
    }
    if (message.role === 'assistant') {
      const text = message.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('');
      const calls = message.content
        .filter(part => part.type === 'toolCall')
        .map(part => ({
          id: part.id,
          function: {
            name: part.name,
            arguments: JSON.stringify(part.arguments),
          },
        }));
      return harden({
        role: 'assistant',
        content: text,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    }
    if (message.role === 'toolResult') {
      return harden({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n'),
      });
    }
    throw Error('Unsupported brokered Messages history');
  });

/** @param {{ messages: any[], tools?: any[] }} context */
const currentTools = context => {
  const messages = context.messages;
  const tools = new Map();
  // pi-ai carries the turn's tools in `context.tools`; the system-message
  // `toolsAdded`/`toolsRemoved` deltas are a legacy history shape.
  for (const tool of context.tools || []) tools.set(tool.name, tool);
  for (const message of messages) {
    if (message.role === 'system') {
      for (const tool of message.toolsAdded || []) tools.set(tool.name, tool);
      for (const tool of message.toolsRemoved || []) tools.delete(tool.name);
    }
  }
  return [...tools.values()].map(tool =>
    harden({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }),
  );
};

/**
 * Pi stream function over the brokered provider. It deliberately emits one
 * completed event after the broker stream is validated; the provider adapter
 * remains the only Anthropic wire-format owner.
 *
 * @param {object} options
 * @param {any} options.inference
 * @param {string} options.model
 * @param {number} [options.maxTokens]
 */
export const makeBrokeredMessagesStream = options => {
  const provider = makeBrokeredMessagesProvider(options);
  return (_model, context, streamOptions = {}) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const result = await provider.chat(
          commonMessages([
            ...(context.systemPrompt
              ? [{ role: 'system', content: context.systemPrompt }]
              : []),
            ...context.messages,
          ]),
          currentTools(context),
          streamOptions.signal,
        );
        const content = [];
        if (result.message.content) {
          content.push({ type: 'text', text: result.message.content });
        }
        for (const call of result.message.tool_calls || []) {
          content.push({
            type: 'toolCall',
            id: call.id,
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments),
          });
        }
        const usage = result.usage || {};
        const piUsage = {
          input: usage.inputTokens || 0,
          output: usage.outputTokens || 0,
          cacheRead: usage.cachedInputTokens || 0,
          cacheWrite: usage.cacheWriteInputTokens || 0,
          totalTokens:
            (usage.inputTokens || 0) +
            (usage.outputTokens || 0) +
            (usage.cachedInputTokens || 0) +
            (usage.cacheWriteInputTokens || 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const stopReason = result.message.tool_calls?.length
          ? 'toolUse'
          : 'stop';
        /** @type {any} */
        const message = harden({
          role: 'assistant',
          content: harden(content),
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: options.model,
          usage: harden(piUsage),
          stopReason,
          timestamp: Date.now(),
        });
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: stopReason, message });
        stream.end(message);
      } catch (error) {
        /** @type {any} */
        const message = harden({
          role: 'assistant',
          content: [],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: options.model,
          usage: harden({
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          }),
          stopReason: streamOptions.signal?.aborted ? 'aborted' : 'error',
          errorMessage:
            error instanceof Error ? error.message : 'Inference failed',
          timestamp: Date.now(),
        });
        stream.push({
          type: 'error',
          reason: streamOptions.signal?.aborted ? 'aborted' : 'error',
          error: message,
        });
        stream.end(message);
      }
    })();
    return stream;
  };
};
harden(makeBrokeredMessagesStream);
