// @ts-check

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { mustMatch, M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

import { anthropicToolContent } from '@endo/hosted-agent/image-result.js';

import { toAnthropicMessages, toAnthropicTools } from './anthropic.js';
import { sseData } from './sse-data.js';

// This is a sibling of subscription-responses.js rather than a mode of it:
// both consume an InferenceEndpoint, but that adapter speaks the OpenAI
// Responses request and event grammar, and Anthropic Messages has its own.

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** @param {AsyncIterableIterator<Uint8Array>} bytes */
const anthropicEvents = async function* anthropicEventIterator(bytes) {
  for await (const text of sseData(bytes, 'Anthropic Messages')) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      throw Error('Invalid Anthropic Messages stream event');
    }
    yield event;
  }
};

/**
 * `maxTokens` has no upper bound here; the broker's `maxOutputTokens` ceiling
 * refuses an oversized value at the first turn.
 *
 * @param {any} recipe
 */
export const assertBrokeredMessagesRecipe = recipe => {
  const fields = harden(['kind', 'inference', 'model', 'maxTokens']);
  (recipe &&
    recipe.kind === 'brokered-messages' &&
    Reflect.ownKeys(recipe).every(key => fields.includes(String(key))) &&
    typeof recipe.model === 'string' &&
    MODEL_PATTERN.test(recipe.model) &&
    (recipe.maxTokens === undefined ||
      (Number.isSafeInteger(recipe.maxTokens) &&
        Number(recipe.maxTokens) > 0))) ||
    Fail`Invalid brokered Messages recipe`;
  mustMatch(recipe.inference, M.remotable(), 'AgentInference capability');
};
harden(assertBrokeredMessagesRecipe);

// Provider stop reasons are mapped by allowlist so that a refusal, a pause, or
// a context overflow never reads as a clean end of turn.
const STOP_REASONS = harden({
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'toolUse',
  max_tokens: 'length',
});

/**
 * @typedef {{ type: 'text', text: string } |
 *   { type: 'toolCall', id: string, name: string, arguments: any }} TurnBlock
 * @typedef {{ input: number, output: number, cacheRead: number,
 *   cacheWrite: number }} TurnUsage
 * @typedef {{ content: TurnBlock[], usage: TurnUsage,
 *   stopReason: 'stop' | 'toolUse' | 'length' }} Turn
 */

/**
 * One Anthropic Messages exchange over a bounded AgentInference capability.
 * The recipe contains no URL or credential; those remain in the host broker.
 *
 * @param {object} options
 * @param {any} options.inference
 * @param {string} options.model
 * @param {number} [options.maxTokens]
 */
const makeMessagesTransport = ({ inference, model, maxTokens = 4096 }) => {
  assertBrokeredMessagesRecipe(
    harden({ kind: 'brokered-messages', inference, model, maxTokens }),
  );
  let disposed = false;
  /** @type {Set<(reason: unknown) => void>} */
  const cancellations = new Set();

  /**
   * @param {{ system: string, messages: any[], tools: any[] }} request
   * @param {AbortSignal} [signal]
   * @param {(text: string) => void} [onText]
   * @returns {Promise<Turn>}
   */
  const exchange = async ({ system, messages, tools }, signal, onText) => {
    await null;
    !disposed || Fail`Brokered Messages provider disposed`;
    signal?.throwIfAborted();
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => undefined);
    const wait = promise => Promise.race([promise, cancelled.promise]);
    cancellations.add(cancelled.reject);
    const abort = () =>
      cancelled.reject(
        signal?.reason ?? Error('Brokered Messages inference cancelled'),
      );
    signal?.addEventListener('abort', abort, { once: true });
    const requested = E(inference).requestByteStream(
      harden({
        method: 'POST',
        path: '/v1/messages',
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          system,
          messages,
          ...(tools.length ? { tools } : {}),
        }),
      }),
    );
    // The response's reader has exactly one owner, whenever it arrives.
    const bytes = E.when(requested, response =>
      iterateBytesReader(response.reader),
    );
    void bytes.catch(() => undefined);
    try {
      const response = await wait(requested);
      if (response.status === 401)
        throw Error('Anthropic authentication failed');
      if (response.status === 429) throw Error('Anthropic rate limit reached');
      (response.status === 200 &&
        /^text\/event-stream(?:;|$)/i.test(response.contentType ?? '')) ||
        Fail`Anthropic Messages inference failed`;
      const events = anthropicEvents(await bytes);
      const blocks = new Map();
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let stopped = false;
      let stopReason;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const next = await wait(events.next());
        if (next.done) break;
        const event = next.value;
        if (event.type === 'error')
          throw Error('Anthropic Messages inference failed');
        if (event.type === 'message_start') {
          usage.input = Number(event.message?.usage?.input_tokens) || 0;
          usage.cacheRead =
            Number(event.message?.usage?.cache_read_input_tokens) || 0;
          usage.cacheWrite =
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
              type: 'toolCall',
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
            onText?.(event.delta.text);
          } else if (
            event.delta?.type === 'input_json_delta' &&
            block.type === 'toolCall'
          ) {
            block.json += event.delta.partial_json;
          } else {
            throw Error('Invalid Anthropic content delta');
          }
        } else if (event.type === 'message_delta') {
          usage.output = Number(event.usage?.output_tokens) || usage.output;
          stopReason = event.delta?.stop_reason ?? stopReason;
        } else if (event.type === 'message_stop') {
          stopped = true;
        }
      }
      stopped || Fail`Anthropic Messages stream ended without message_stop`;
      /** @type {TurnBlock[]} */
      const content = [...blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => {
          if (block.type === 'text') return harden(block);
          let input;
          try {
            input = block.json === '' ? {} : JSON.parse(block.json);
          } catch {
            throw Error('Invalid Anthropic tool input');
          }
          const { id, name } = block;
          return harden({ type: 'toolCall', id, name, arguments: input });
        });
      const mapped = Object.hasOwn(STOP_REASONS, String(stopReason))
        ? STOP_REASONS[stopReason]
        : Fail`Unsupported Anthropic stop reason`;
      (mapped === 'toolUse') ===
        content.some(block => block.type === 'toolCall') ||
        mapped === 'length' ||
        Fail`Anthropic stop reason does not match its content`;
      return harden({ content, usage: harden(usage), stopReason: mapped });
    } finally {
      signal?.removeEventListener('abort', abort);
      cancellations.delete(cancelled.reject);
      void bytes.then(iterator => iterator.return?.()).catch(() => undefined);
    }
  };

  return harden({
    exchange,
    async dispose() {
      disposed = true;
      for (const cancel of cancellations) {
        cancel(Error('Brokered Messages provider disposed'));
      }
    },
  });
};

/**
 * Common chat-provider surface (Fae's provider owner) over the transport.
 *
 * @param {object} options
 * @param {any} options.inference
 * @param {string} options.model
 * @param {number} [options.maxTokens]
 */
export const makeBrokeredMessagesProvider = options => {
  const transport = makeMessagesTransport(options);

  /**
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {(text: string) => void} [onToken]
   * @param {AbortSignal} [signal]
   * @param {(usage: any) => void} [onUsage]
   */
  const chatStream = async (messages, tools, onToken, signal, onUsage) => {
    await null;
    const turn = await transport.exchange(
      harden({
        ...toAnthropicMessages(messages),
        tools: toAnthropicTools(tools),
      }),
      signal,
      onToken,
    );
    const toolCalls = turn.content.flatMap(block =>
      block.type === 'toolCall'
        ? [
            {
              id: block.id,
              function: {
                name: block.name,
                arguments: JSON.stringify(block.arguments),
              },
            },
          ]
        : [],
    );
    const message = harden({
      role: 'assistant',
      content: turn.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join(''),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    const { input, output, cacheRead, cacheWrite } = turn.usage;
    const usage = harden({
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
      reasoningOutputTokens: 0,
      context: {
        usedTokens: input + output + cacheRead + cacheWrite,
        windowTokens: 0,
      },
    });
    onUsage?.(usage);
    return harden({ message, usage, stopReason: turn.stopReason });
  };

  return harden({
    chat: (messages, tools, signal) =>
      chatStream(messages, tools, undefined, signal, undefined),
    chatStream,
    dispose: transport.dispose,
  });
};
harden(makeBrokeredMessagesProvider);

/**
 * @param {any[]} parts
 * @param {string} separator
 */
const joinText = (parts, separator) =>
  parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join(separator);

/**
 * Translate a pi-ai context straight into an Anthropic Messages request.
 *
 * @param {{ systemPrompt?: string, messages: any[], tools?: any[] }} context
 */
const toMessagesRequest = context => {
  let system = context.systemPrompt || '';
  const tools = new Map();
  // pi-ai carries the turn's tools in `context.tools`; the system-message
  // `toolsAdded`/`toolsRemoved` deltas are a legacy history shape.
  for (const tool of context.tools || []) tools.set(tool.name, tool);
  const messages = [];
  for (const message of context.messages) {
    if (message.role === 'system') {
      system = message.content;
      for (const tool of message.toolsAdded || []) tools.set(tool.name, tool);
      for (const tool of message.toolsRemoved || []) tools.delete(tool.name);
    } else if (message.role === 'user') {
      messages.push({
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : joinText(message.content, '\n'),
      });
    } else if (message.role === 'assistant') {
      const text = joinText(message.content, '');
      const content = [
        ...(text ? [{ type: 'text', text }] : []),
        ...message.content
          .filter(part => part.type === 'toolCall')
          .map(part => ({
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: part.arguments,
          })),
      ];
      if (content.length) messages.push({ role: 'assistant', content });
    } else if (message.role === 'toolResult') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: anthropicToolContent(joinText(message.content, '\n')),
          },
        ],
      });
    } else {
      throw Error('Unsupported brokered Messages history');
    }
  }
  return harden({
    system,
    messages,
    tools: [...tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
  });
};

/** @param {TurnUsage} usage */
const piUsage = ({ input, output, cacheRead, cacheWrite }) =>
  harden({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

/**
 * Pi stream function over the brokered transport. It emits one completed
 * event after the broker stream is validated, and carries `dispose`.
 * pi-ai's native Anthropic stream adds fields the request policy refuses and
 * retries on its own, which would be a second admission.
 *
 * @param {object} options
 * @param {any} options.inference
 * @param {string} options.model
 * @param {number} [options.maxTokens]
 */
export const makeBrokeredMessagesStream = options => {
  const transport = makeMessagesTransport(options);
  /** @type {(model: any, context: any, streamOptions?: any) => any} */
  const streamMessages = (_model, context, streamOptions = {}) => {
    const stream = createAssistantMessageEventStream();
    const base = {
      role: 'assistant',
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: options.model,
    };
    void (async () => {
      await null;
      try {
        const turn = await transport.exchange(
          toMessagesRequest(context),
          streamOptions.signal,
        );
        /** @type {any} */
        const message = harden({
          ...base,
          content: turn.content,
          usage: piUsage(turn.usage),
          stopReason: turn.stopReason,
          timestamp: Date.now(),
        });
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: turn.stopReason, message });
        stream.end(message);
      } catch (error) {
        const reason = streamOptions.signal?.aborted ? 'aborted' : 'error';
        /** @type {any} */
        const message = harden({
          ...base,
          content: [],
          usage: piUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
          stopReason: reason,
          errorMessage:
            error instanceof Error ? error.message : 'Inference failed',
          timestamp: Date.now(),
        });
        stream.push({ type: 'error', reason, error: message });
        stream.end(message);
      }
    })();
    return stream;
  };
  return harden(Object.assign(streamMessages, { dispose: transport.dispose }));
};
harden(makeBrokeredMessagesStream);
