// @ts-check
/* eslint-disable no-await-in-loop */

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { usageFromProviderEvent } from '@endo/hosted-agent/provider-usage.js';
import { canonicalJson } from '@endo/hosted-agent/canonical-json.js';
import { makePromiseKit } from '@endo/promise-kit';
import { M, mustMatch } from '@endo/patterns';

// A transport bound matching the Codex broker, not a model context limit.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const reasoningEffortPattern = /^[a-z][a-z0-9_-]{0,63}$/;
/** @type {Record<string, string>} */
const FAILURE_EXPLANATIONS = harden({
  invalid_encrypted_content: 'Retained reasoning could not be validated.',
  context_length_exceeded: 'Input exceeds the model context window.',
  rate_limit_exceeded: 'Provider rate limit reached.',
  usage_limit_reached: 'Provider usage limit reached.',
  server_error: 'Provider reported a server error.',
  max_output_tokens: 'Output token limit reached.',
  content_filter: 'Provider content filter stopped the response.',
});

/**
 * Error events are provider data, not trusted diagnostics. Retain only bounded
 * symbolic fields and schema paths, never free prose, request ids or a dumped
 * response. In particular, a message may echo input or encrypted context.
 * The broker screens its own credential before handing us any stream bytes.
 * @param {any} event
 */
const responseFailure = event => {
  const error =
    event.type === 'error' ? (event.error ?? event) : event.response?.error;
  const symbolic = value =>
    typeof value === 'string' &&
    /^[a-z]{1,16}(?:_[a-z]{1,16}){0,5}$/.test(value) &&
    !/(?:^|_)(?:sk|pk|rk|gsk|hf|ghp|gho|ghs|ghu|glpat|xox[a-z]?|bearer)(?:_|$)/i.test(
      value,
    )
      ? value
      : undefined;
  const code =
    typeof error?.code === 'number' &&
    Number.isInteger(error.code) &&
    Number(error.code) >= 0 &&
    Number(error.code) <= 99_999
      ? `${error.code}`
      : symbolic(error?.code);
  const type = error === event ? undefined : symbolic(error?.type);
  const reason = symbolic(event.response?.incomplete_details?.reason);
  const rawParam = error?.param;
  const param =
    typeof rawParam === 'string' &&
    rawParam.length <= 128 &&
    rawParam.split('.').length <= 6 &&
    rawParam.split('.').every(part => {
      const match = /^([a-z_]+)(?:\[[0-9]{1,5}\])?$/.exec(part);
      return match && symbolic(match[1]) !== undefined;
    })
      ? rawParam
      : undefined;
  const facts = Object.entries({ code, type, param, reason })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`);
  const explanationKey = code ?? reason;
  const explanation =
    explanationKey !== undefined &&
    Object.hasOwn(FAILURE_EXPLANATIONS, explanationKey)
      ? FAILURE_EXPLANATIONS[explanationKey]
      : undefined;
  return Error(
    `Subscription inference ended unsuccessfully (${event.type}${
      facts.length ? `; ${facts.join(', ')}` : ''
    })${explanation ? ` ${explanation}` : ''}`,
  );
};

/** @param {any} call */
const assertCall = call => {
  (typeof call?.call_id === 'string' &&
    Number(call.call_id.length) > 0 &&
    typeof call.name === 'string' &&
    Number(call.name.length) > 0 &&
    typeof call.arguments === 'string') ||
    Fail`Invalid Responses function call`;
  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    throw Error('Invalid Responses function arguments');
  }
  (args && typeof args === 'object' && !Array.isArray(args)) ||
    Fail`Responses function arguments must be an object`;
};

/**
 * Keep the provider's complete output, including encrypted reasoning and item
 * identities, on the common message. The tree persists it with that message.
 * It is not a second transcript, nor a server-side previous_response_id.
 * @param {any[]} items
 */
const commonMessage = items => {
  Array.isArray(items) || Fail`Invalid Responses output`;
  let content = '';
  const calls = [];
  const ids = new Set();
  const itemIds = new Set();
  for (const item of items) {
    (item && (item.status === undefined || item.status === 'completed')) ||
      Fail`Unfinished Responses output item`;
    if (item.id !== undefined) {
      (typeof item.id === 'string' && item.id !== '') ||
        Fail`Invalid Responses output item identity`;
      !itemIds.has(item.id) || Fail`Duplicate Responses output item identity`;
      itemIds.add(item.id);
    }
    if (item?.type === 'reasoning') {
      // Opaque provider context: preserve, never execute or interpret it.
    } else if (item?.type === 'function_call') {
      assertCall(item);
      !ids.has(item.call_id) || Fail`Duplicate Responses function call`;
      ids.add(item.call_id);
      calls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item?.type === 'message' && item.role === 'assistant') {
      Array.isArray(item.content) || Fail`Invalid Responses message content`;
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          content += part.text;
        } else if (
          part?.type === 'refusal' &&
          typeof part.refusal === 'string'
        ) {
          content += part.refusal;
        } else {
          throw Error('Unsupported Responses message content');
        }
      }
    } else {
      throw Error('Unsupported Responses output item');
    }
  }
  content.trim() || calls.length > 0 || Fail`Empty Responses assistant output`;
  return {
    role: 'assistant',
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
  };
};

/**
 * Validate retained output and recover its common message without losing native
 * item identities or encrypted reasoning. Used by both conversation owners.
 * @param {any} output
 */
export const messageFromResponsesOutput = output => {
  (output &&
    Object.keys(output).length === 2 &&
    Object.hasOwn(output, 'model') &&
    Object.hasOwn(output, 'items') &&
    typeof output.model === 'string' &&
    output.model !== '' &&
    Array.isArray(output.items)) ||
    Fail`Invalid retained Responses output`;
  return harden({
    ...commonMessage(output.items),
    responsesOutput: { model: output.model, items: output.items },
  });
};
harden(messageFromResponsesOutput);

/** @param {any} recipe */
export const assertSubscriptionResponsesRecipe = recipe => {
  const fields = harden([
    'kind',
    'subscription',
    'model',
    'reasoningEffort',
    'contextLength',
  ]);
  (recipe &&
    recipe.kind === 'subscription-responses' &&
    ['kind', 'subscription', 'model'].every(key =>
      Object.hasOwn(recipe, key),
    ) &&
    Reflect.ownKeys(recipe).every(key => fields.includes(String(key))) &&
    typeof recipe.model === 'string' &&
    recipe.model !== '' &&
    (recipe.reasoningEffort === undefined ||
      (typeof recipe.reasoningEffort === 'string' &&
        reasoningEffortPattern.test(recipe.reasoningEffort))) &&
    (recipe.contextLength === undefined ||
      (typeof recipe.contextLength === 'number' &&
        Number.isInteger(recipe.contextLength) &&
        Number(recipe.contextLength) > 0 &&
        Number(recipe.contextLength) <= 0xffff_ffff))) ||
    Fail`Invalid subscription Responses recipe`;
  mustMatch(recipe.subscription, M.remotable(), 'subscription capability');
};
harden(assertSubscriptionResponsesRecipe);

/**
 * @param {any[]} messages
 * @param {string} model
 */
const requestContext = (messages, model) => {
  const instructions = [];
  const input = [];
  const pending = new Set();
  const seen = new Set();
  const retainCalls = calls => {
    for (const call of calls) {
      assertCall(call);
      !seen.has(call.call_id) || Fail`Duplicate Responses history call`;
      seen.add(call.call_id);
      pending.add(call.call_id);
    }
  };
  for (const message of messages) {
    if (message.role === 'system') {
      typeof message.content === 'string' || Fail`Invalid system instructions`;
      instructions.push(message.content);
    } else if (message.role === 'tool') {
      (pending.delete(message.tool_call_id) &&
        typeof message.content === 'string') ||
        Fail`Unmatched Responses tool outcome`;
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      });
    } else if (
      message.role === 'assistant' &&
      message.responsesOutput !== undefined
    ) {
      message.responsesOutput.model === model ||
        Fail`Incompatible Responses context model`;
      const { items } = message.responsesOutput;
      messageFromResponsesOutput(message.responsesOutput);
      retainCalls(items.filter(item => item.type === 'function_call'));
      input.push(...items);
    } else {
      (['user', 'assistant'].includes(message.role) &&
        typeof message.content === 'string') ||
        Fail`Invalid Responses history message`;
      if (message.content)
        input.push({ role: message.role, content: message.content });
      if (message.tool_calls !== undefined) {
        (message.role === 'assistant' && Array.isArray(message.tool_calls)) ||
          Fail`Invalid history tool calls`;
        const calls = message.tool_calls.map(call => ({
          type: 'function_call',
          call_id: call.id,
          name: call.function?.name,
          arguments:
            typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments),
        }));
        retainCalls(calls);
        input.push(...calls);
      }
    }
  }
  pending.size === 0 || Fail`Responses history has unresolved tool calls`;
  return { instructions: instructions.join('\n\n'), input };
};

/**
 * SSE framing is independent of chunk boundaries and retains multiline data.
 * The broker's usage tap is deliberately not an SSE parser: it skips oversized
 * lines and malformed JSON, whereas an inference consumer must reject them.
 * @param {AsyncIterableIterator<Uint8Array>} bytes
 */
const responseEvents = async function* responseEventIterator(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data = [];
  let size = 0;
  const takeEvent = () => {
    const text = data.join('\n');
    data = [];
    if (text === '[DONE]') return { type: 'stream.done' };
    try {
      return JSON.parse(text);
    } catch {
      throw Error('Invalid Responses stream event');
    }
  };
  for await (const chunk of bytes) {
    size += chunk.byteLength;
    size <= MAX_RESPONSE_BYTES ||
      Fail`Responses stream exceeds transport bound`;
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /^(.*?)(\r\n|\n|\r(?!$))/s.exec(pending);
      if (!match) break;
      pending = pending.slice(match[0].length);
      const line = match[1];
      if (line === '') {
        if (data.length > 0) {
          const event = takeEvent();
          if (event !== undefined) yield event;
        }
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  pending += decoder.decode();
  // A trailing CR is held across chunks to distinguish CRLF. At EOF it is
  // itself the final line ending, including a CR-only blank dispatch line.
  if (pending === '\r') {
    pending = '';
    if (data.length > 0) {
      const event = takeEvent();
      if (event !== undefined) yield event;
    }
  }
  (!pending.trim() && data.length === 0) ||
    Fail`Truncated Responses stream event`;
};

/**
 * Capability-backed Responses provider. No URL, credential, account header,
 * listener, or native CLI belongs here; the Subscription owns those policies.
 * One endpoint per inference call makes cancellation request-scoped, while the
 * stable session id lets the existing pool retain its account affinity.
 * @param {object} options
 * @param {any} options.subscription
 * @param {string} options.sessionId
 * @param {string} options.model
 * @param {string} [options.reasoningEffort]
 * @param {number} [options.contextLength] Provider-observed metadata supplied by
 *   the catalog integration, not an execution budget. Absent means unknown.
 */
export const makeSubscriptionResponsesProvider = ({
  subscription,
  sessionId,
  model,
  reasoningEffort,
  contextLength,
}) => {
  (typeof model === 'string' && model.length > 0) ||
    Fail`Responses model required`;
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) ||
    Fail`Invalid inference session identity`;
  reasoningEffort === undefined ||
    (typeof reasoningEffort === 'string' &&
      reasoningEffortPattern.test(reasoningEffort)) ||
    Fail`Invalid reasoning effort`;
  contextLength === undefined ||
    (Number.isInteger(contextLength) &&
      Number(contextLength) > 0 &&
      Number(contextLength) <= 0xffff_ffff) ||
    Fail`Invalid model context length`;
  let disposed = false;
  /** @type {Set<() => Promise<void>>} */
  const cleanups = new Set();
  /** @type {Set<(reason: unknown) => void>} */
  const cancellations = new Set();
  let cleanupFailed = false;

  /**
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {(text: string) => void} [onToken]
   * @param {AbortSignal} [signal]
   * @param {(usage: any) => void} [onUsage]
   */
  const chatStream = async (messages, tools, onToken, signal, onUsage) => {
    await null;
    !disposed || Fail`Subscription provider disposed`;
    !cleanupFailed || Fail`Subscription provider cleanup pending`;
    signal?.throwIfAborted();
    const context = requestContext(messages, model);
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => undefined);
    const wait = promise => Promise.race([promise, cancelled.promise]);
    let wasCancelled = false;
    /** @type {unknown} */
    let cancellationReason;
    const assertLive = () => {
      if (wasCancelled) throw cancellationReason;
      !disposed || Fail`Subscription provider disposed`;
    };
    let endpoint;
    let iterator;
    let cleanupFlight;
    // Retain the obligation before acquisition, including late endpoints.
    const admission = makePromiseKit();
    const endpointP = admission.promise.then(() =>
      E(subscription).openEndpoint({ sessionId }),
    );
    const cleanup = () => {
      cleanupFlight ??= endpointP
        .then(
          value => E(value).revoke(),
          () => undefined,
        )
        .then(() => {
          cleanups.delete(cleanup);
          cancellations.delete(cancel);
        })
        .catch(error => {
          cleanupFailed = true;
          cleanupFlight = undefined;
          throw error;
        });
      return cleanupFlight;
    };
    cleanups.add(cleanup);
    /** @param {unknown} reason */
    const cancel = reason => {
      if (!wasCancelled) cancellationReason = reason;
      wasCancelled = true;
      cancelled.reject(reason);
      admission.reject(reason);
      void cleanup().catch(() => undefined);
    };
    cancellations.add(cancel);
    const abort = () => {
      cancel(
        signal ? signal.reason : Error('Subscription inference cancelled'),
      );
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const catalog = await wait(E(subscription).describe());
      assertLive();
      // Subscription describes admitted ids, not picker metadata. A bounded
      // share may narrow these ids; the broker still admits every dispatch.
      (Array.isArray(catalog.models) && catalog.models.includes(model)) ||
        Fail`Model absent from subscription catalog`;
      const wireTools = tools.map(tool => {
        (tool.type === 'function' &&
          typeof tool.function?.name === 'string' &&
          tool.function.name !== '' &&
          tool.function.parameters &&
          typeof tool.function.parameters === 'object') ||
          Fail`Invalid Responses tool schema`;
        return { type: 'function', ...tool.function };
      });
      admission.resolve(undefined);
      endpoint = await wait(endpointP);
      assertLive();
      const response = await wait(
        E(endpoint).requestByteStream(
          harden({
            method: 'POST',
            path: '/v1/responses',
            body: JSON.stringify({
              model,
              ...context,
              store: false,
              stream: true,
              include: ['reasoning.encrypted_content'],
              ...(reasoningEffort
                ? { reasoning: { effort: reasoningEffort } }
                : {}),
              ...(tools.length ? { tools: wireTools } : {}),
            }),
          }),
        ),
      );
      assertLive();
      (response.status === 200 &&
        /^text\/event-stream(?:;|$)/i.test(response.contentType ?? '')) ||
        Fail`Subscription inference failed (HTTP ${response.status})`;
      iterator = iterateBytesReader(response.reader);
      const events = responseEvents(iterator);
      let completed;
      const addedItems = new Map();
      const completedItems = new Map();
      let doneMarker = false;
      let usage;
      for (;;) {
        const next = await wait(events.next());
        assertLive();
        if (next.done) break;
        const event = next.value;
        typeof event?.type === 'string' || Fail`Invalid Responses event type`;
        !doneMarker || Fail`Responses event after stream end`;
        if (event.type === 'stream.done') {
          completed !== undefined ||
            Fail`Responses stream ended without completion`;
          doneMarker = true;
        } else {
          completed === undefined || Fail`Responses event after completion`;
        }
        const counts = usageFromProviderEvent(event);
        if (counts) {
          usage = harden({
            ...counts,
            context: {
              usedTokens: Object.values(counts).reduce(
                (sum, count) => sum + count,
                0,
              ),
              windowTokens: contextLength ?? 0,
            },
          });
          onUsage?.(usage);
          assertLive();
        }
        if (
          ['error', 'response.failed', 'response.incomplete'].includes(
            event.type,
          )
        ) {
          throw responseFailure(event);
        }
        if (
          event.type === 'response.output_item.added' ||
          event.type === 'response.output_item.done'
        ) {
          const index = event.output_index;
          (typeof index === 'number' &&
            Number.isSafeInteger(index) &&
            index >= 0 &&
            index <= 0xffff_ffff &&
            event.item &&
            typeof event.item.type === 'string') ||
            Fail`Invalid Responses completed item`;
          if (event.type === 'response.output_item.added') {
            (!addedItems.has(index) && !completedItems.has(index)) ||
              Fail`Duplicate Responses added item`;
            addedItems.set(index, {
              type: event.item.type,
              id: event.item.id,
            });
          } else {
            !completedItems.has(index) ||
              Fail`Duplicate Responses completed item`;
            const added = addedItems.get(index);
            !added ||
              (added.type === event.item.type && added.id === event.item.id) ||
              Fail`Responses item identity changed`;
            completedItems.set(index, event.item);
          }
        } else if (event.type === 'response.output_text.delta') {
          (completed === undefined && typeof event.delta === 'string') ||
            Fail`Invalid Responses text delta`;
          onToken?.(event.delta);
        } else if (event.type === 'response.completed') {
          (completed === undefined && event.response?.status === 'completed') ||
            Fail`Invalid Responses completion`;
          completed = event.response;
        }
      }
      completed !== undefined ||
        Fail`Responses stream ended without completion`;
      Array.isArray(completed.output) ||
        Fail`Invalid Responses completed output`;
      [...addedItems.keys()].every(index => completedItems.has(index)) ||
        Fail`Unfinished Responses added item`;
      const streamed = [...completedItems.entries()].sort(([a], [b]) => a - b);
      streamed.every(([index], position) => index === position) ||
        Fail`Incomplete Responses completed item sequence`;
      const streamedOutput = streamed.map(([, item]) => item);
      // ChatGPT subscription streams complete each item, then acknowledge the
      // response with an empty output array. Retain those completed snapshots,
      // never reconstruct tool arguments or opaque context from partial deltas.
      if (completed.output.length && streamedOutput.length) {
        canonicalJson(completed.output) === canonicalJson(streamedOutput) ||
          Fail`Responses completion disagrees with completed items`;
      }
      const output = completed.output.length
        ? completed.output
        : streamedOutput;
      return harden({
        message: messageFromResponsesOutput({ model, items: output }),
        ...(usage ? { usage } : {}),
      });
    } finally {
      admission.reject(Error('Inference acquisition not admitted'));
      signal?.removeEventListener('abort', abort);
      // Do not hide a stalled acquisition/read behind stalled caller cancellation.
      // Its retained cleanup must still finish before dispose() acknowledges it.
      if (wasCancelled) void cleanup().catch(() => undefined);
      else await cleanup();
      if (iterator) void iterator.return?.().catch(() => undefined);
    }
  };
  return harden({
    chatStream,
    /**
     * @param {any[]} messages
     * @param {any[]} tools
     * @param {AbortSignal} [signal]
     */
    chat: (messages, tools, signal) =>
      chatStream(messages, tools, undefined, signal),
    async dispose() {
      disposed = true;
      for (const cancel of cancellations) {
        cancel(Error('Subscription provider disposed'));
      }
      await Promise.all([...cleanups].map(cleanup => cleanup()));
    },
  });
};
harden(makeSubscriptionResponsesProvider);
