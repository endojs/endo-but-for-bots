// @ts-check
/* eslint-disable no-await-in-loop */
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { anthropicToolContent } from '@endo/hosted-agent/image-result.js';
import { usageFromProviderEvent } from '@endo/hosted-agent/provider-usage.js';
import { makePromiseKit } from '@endo/promise-kit';
import { M, mustMatch } from '@endo/patterns';

import { responseEvents } from './subscription-events.js';

const emptyMessagesOutputs = new WeakMap();
/** @param {unknown} error */
export const getEmptyMessagesOutput = error =>
  error instanceof Error ? emptyMessagesOutputs.get(error) : undefined;
harden(getEmptyMessagesOutput);

/**
 * Native Messages effort support, independent of the Claude Code CLI knobs.
 * Unknown models remain usable with provider defaults; never guess a knob.
 * @param {string} model
 */
export const claudeMessagesEfforts = model => {
  // Explicit protocol support, not a model admission list. Admission always
  // comes from the account's live catalog. Unknown revisions use defaults.
  if (
    /^claude-(?:(?:opus|sonnet)-5(?:-5)?|haiku-5-5|(?:fable|mythos)-5(?:-1)?|opus-4-[78])(?:-20[0-9]{6})?$/.test(
      model,
    )
  )
    return harden(['low', 'medium', 'high', 'xhigh', 'max']);
  if (
    /^claude-(?:opus|sonnet)-4-6(?:-20[0-9]{6})?$/.test(model) ||
    model === 'claude-mythos-preview'
  )
    return harden(['low', 'medium', 'high', 'max']);
  return harden([]);
};
harden(claudeMessagesEfforts);

/** @param {any} recipe */
export const assertSubscriptionMessagesRecipe = recipe => {
  const fields = [
    'kind',
    'subscription',
    'model',
    'reasoningEffort',
    'contextLength',
  ];
  (recipe &&
    recipe.kind === 'subscription-messages' &&
    ['kind', 'subscription', 'model'].every(key =>
      Object.hasOwn(recipe, key),
    ) &&
    Reflect.ownKeys(recipe).every(key => fields.includes(String(key))) &&
    typeof recipe.model === 'string' &&
    recipe.model !== '' &&
    (recipe.reasoningEffort === undefined ||
      claudeMessagesEfforts(recipe.model).includes(recipe.reasoningEffort)) &&
    (recipe.contextLength === undefined ||
      (Number.isInteger(recipe.contextLength) &&
        Number(recipe.contextLength) > 0 &&
        Number(recipe.contextLength) <= 0xffff_ffff))) ||
    Fail`Invalid subscription Messages recipe`;
  mustMatch(recipe.subscription, M.remotable(), 'subscription capability');
};
harden(assertSubscriptionMessagesRecipe);

/**
 * Validate native blocks before tools can escape the adapter. Signed thinking
 * is persisted verbatim with its assistant message, never exposed as a tool.
 * @param {any} output
 */
export const messageFromMessagesOutput = output => {
  (output &&
    Object.keys(output).length === 2 &&
    typeof output.model === 'string' &&
    output.model !== '' &&
    Array.isArray(output.content)) ||
    Fail`Invalid retained Messages output`;
  let content = '';
  const calls = [];
  const ids = new Set();
  for (const block of output.content) {
    if (block?.type === 'text') {
      typeof block.text === 'string' || Fail`Invalid Messages text`;
      content += block.text;
    } else if (block?.type === 'thinking') {
      (typeof block.thinking === 'string' &&
        typeof block.signature === 'string' &&
        block.signature !== '') ||
        Fail`Unsigned Messages thinking`;
    } else if (block?.type === 'redacted_thinking') {
      (typeof block.data === 'string' && block.data !== '') ||
        Fail`Invalid redacted thinking`;
    } else if (block?.type === 'tool_use') {
      (typeof block.id === 'string' &&
        /^[a-zA-Z0-9_-]+$/.test(block.id) &&
        typeof block.name === 'string' &&
        block.name !== '' &&
        block.input &&
        typeof block.input === 'object' &&
        !Array.isArray(block.input)) ||
        Fail`Invalid Messages tool call`;
      !ids.has(block.id) || Fail`Duplicate Messages tool call`;
      ids.add(block.id);
      calls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    } else throw Error('Unsupported Messages content block');
  }
  return harden({
    role: 'assistant',
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
    messagesOutput: output,
  });
};
harden(messageFromMessagesOutput);

/**
 * @param {any[]} history
 * @param {string} model
 */
const requestContext = (history, model) => {
  const system = [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=0.0.0; cc_entrypoint=fae;',
    },
  ];
  const messages = [];
  const pending = new Set();
  const seen = new Set();
  const append = (role, content) => {
    if (!content.length) return;
    if (messages.at(-1)?.role === role)
      messages.at(-1).content.push(...content);
    else messages.push({ role, content: [...content] });
  };
  for (const msg of history) {
    if (msg.role === 'system') {
      typeof msg.content === 'string' ||
        Fail`Invalid Messages system instructions`;
      if (msg.content) system.push({ type: 'text', text: msg.content });
    } else if (msg.role === 'tool') {
      (pending.delete(msg.tool_call_id) && typeof msg.content === 'string') ||
        Fail`Unmatched Messages tool result`;
      append('user', [
        {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: anthropicToolContent(msg.content),
          ...(msg.failed ? { is_error: true } : {}),
        },
      ]);
    } else {
      pending.size === 0 || Fail`Messages history has unresolved tool calls`;
      (['user', 'assistant'].includes(msg.role) &&
        typeof msg.content === 'string') ||
        Fail`Invalid Messages history`;
      /** @type {any[]} */
      let content;
      if (msg.messagesOutput !== undefined) {
        (msg.role === 'assistant' && msg.messagesOutput.model === model) ||
          Fail`Incompatible Messages context model`;
        const retained = messageFromMessagesOutput(msg.messagesOutput);
        (retained.content === msg.content &&
          JSON.stringify(retained.tool_calls ?? []) ===
            JSON.stringify(msg.tool_calls ?? [])) ||
          Fail`Messages history differs from retained output`;
        content = msg.messagesOutput.content;
      } else {
        !msg.responsesOutput || Fail`Incompatible Responses context`;
        content = msg.content ? [{ type: 'text', text: msg.content }] : [];
        if (msg.tool_calls !== undefined) {
          (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) ||
            Fail`Invalid Messages history calls`;
          for (const call of msg.tool_calls) {
            let input;
            try {
              input =
                typeof call.function?.arguments === 'string'
                  ? JSON.parse(call.function.arguments)
                  : call.function?.arguments;
            } catch {
              throw Error('Invalid Messages tool arguments');
            }
            content.push({
              type: 'tool_use',
              id: call.id,
              name: call.function?.name,
              input,
            });
          }
          messageFromMessagesOutput({ model, content });
        }
      }
      for (const block of content)
        if (block.type === 'tool_use') {
          !seen.has(block.id) || Fail`Duplicate Messages history call`;
          seen.add(block.id);
          pending.add(block.id);
        }
      append(msg.role, content);
    }
  }
  pending.size === 0 || Fail`Messages history has unresolved tool calls`;
  return { system, messages };
};

/**
 * Direct Claude subscription inference. Credentials and account routing stay
 * in the Subscription broker; all tools and delegation stay in Fae.
 * @param {object} options
 * @param {any} options.subscription
 * @param {string} options.sessionId
 * @param {string} options.model
 * @param {string} [options.reasoningEffort]
 * @param {number} [options.contextLength]
 */
export const makeSubscriptionMessagesProvider = ({
  subscription,
  sessionId,
  model,
  reasoningEffort,
  contextLength,
}) => {
  assertSubscriptionMessagesRecipe(
    harden({
      kind: 'subscription-messages',
      subscription,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(contextLength === undefined ? {} : { contextLength }),
    }),
  );
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) ||
    Fail`Invalid inference session identity`;
  let disposed = false;
  /** @type {Set<() => Promise<void>>} */
  const cleanups = new Set();
  /** @type {Set<(reason: unknown) => void>} */
  const cancellations = new Set();
  let cleanupFailed = false;

  /**
   * @param {{method: string, path: string, body: string}} request
   * @param {(text: string) => void} [onToken]
   * @param {AbortSignal} [signal]
   * @param {(usage: any) => void} [onUsage]
   */
  const attempt = async (request, onToken, signal, onUsage) => {
    await null;
    !disposed || Fail`Subscription provider disposed`;
    !cleanupFailed || Fail`Subscription provider cleanup pending`;
    signal?.throwIfAborted();
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
      admission.resolve(undefined);
      endpoint = await wait(endpointP);
      assertLive();
      const response = await wait(E(endpoint).requestByteStream(request));
      assertLive();
      (response.status === 200 &&
        /^text\/event-stream(?:;|$)/i.test(response.contentType ?? '')) ||
        Fail`Subscription inference failed (HTTP ${response.status})`;
      iterator = iterateBytesReader(response.reader);
      const events = responseEvents(iterator);
      let started = false;
      let stopped = false;
      let stopReason;
      /** @type {any} */
      let active;
      const blocks = [];
      let counts = {};
      for (;;) {
        const next = await wait(events.next());
        assertLive();
        if (next.done) break;
        const event = next.value;
        typeof event?.type === 'string' || Fail`Invalid Messages event`;
        !stopped || Fail`Messages event after completion`;
        if (event.type === 'error')
          throw Error('Claude subscription inference failed');
        // eslint-disable-next-line no-continue
        if (event.type === 'ping') continue;
        if (event.type === 'message_start') {
          (!started &&
            event.message?.role === 'assistant' &&
            event.message.type === 'message' &&
            Array.isArray(event.message.content) &&
            event.message.content.length === 0) ||
            Fail`Invalid Messages start`;
          started = true;
          counts = { ...event.message.usage };
        } else {
          started || Fail`Messages event before start`;
          if (event.type === 'content_block_start') {
            (active === undefined &&
              stopReason === undefined &&
              event.index === blocks.length) ||
              Fail`Invalid Messages block start`;
            const block = event.content_block;
            messageFromMessagesOutput({
              model,
              content:
                block?.type === 'thinking'
                  ? [{ ...block, signature: 'pending' }]
                  : [block],
            });
            active = { block: { ...block }, json: '' };
          } else if (event.type === 'content_block_delta') {
            (active !== undefined && event.index === blocks.length) ||
              Fail`Invalid Messages block delta`;
            const delta = event.delta;
            const block = active.block;
            if (
              delta?.type === 'text_delta' &&
              block.type === 'text' &&
              typeof delta.text === 'string'
            ) {
              block.text += delta.text;
              onToken?.(delta.text);
            } else if (
              delta?.type === 'thinking_delta' &&
              block.type === 'thinking' &&
              typeof delta.thinking === 'string'
            )
              block.thinking += delta.thinking;
            else if (
              delta?.type === 'signature_delta' &&
              block.type === 'thinking' &&
              typeof delta.signature === 'string'
            )
              block.signature = (block.signature ?? '') + delta.signature;
            else if (
              delta?.type === 'input_json_delta' &&
              block.type === 'tool_use' &&
              typeof delta.partial_json === 'string'
            )
              active.json += delta.partial_json;
            else throw Error('Unsupported Messages block delta');
          } else if (event.type === 'content_block_stop') {
            (active !== undefined && event.index === blocks.length) ||
              Fail`Invalid Messages block stop`;
            if (active.block.type === 'tool_use' && active.json !== '') {
              try {
                active.block.input = JSON.parse(active.json);
              } catch {
                throw Error('Invalid Messages tool arguments');
              }
            }
            messageFromMessagesOutput({ model, content: [active.block] });
            blocks.push(active.block);
            active = undefined;
          } else if (event.type === 'message_delta') {
            (active === undefined &&
              stopReason === undefined &&
              ['end_turn', 'tool_use', 'stop_sequence'].includes(
                event.delta?.stop_reason,
              )) ||
              Fail`Unfinished or invalid Messages completion`;
            stopReason = event.delta.stop_reason;
            counts = { ...counts, ...event.usage };
          } else if (event.type === 'message_stop') {
            (active === undefined && stopReason !== undefined) ||
              Fail`Messages stream ended without completion`;
            stopped = true;
          } else throw Error('Unsupported Messages stream event');
        }
      }
      stopped || Fail`Messages stream ended without completion`;
      const message = messageFromMessagesOutput({ model, content: blocks });
      (stopReason === 'tool_use') === !!message.tool_calls?.length ||
        Fail`Messages stop reason disagrees with tool calls`;
      const usageCounts = usageFromProviderEvent({
        type: 'message',
        usage: counts,
      });
      const usage =
        usageCounts &&
        harden({
          ...usageCounts,
          context: {
            usedTokens: Object.values(usageCounts).reduce(
              (sum, count) => sum + count,
              0,
            ),
            windowTokens: contextLength ?? 0,
          },
        });
      if (usage) onUsage?.(usage);
      assertLive();
      const outcome = harden({ message, ...(usage ? { usage } : {}) });
      if (!message.content.trim() && !message.tool_calls?.length) {
        const error = Error('Empty Messages assistant output');
        emptyMessagesOutputs.set(error, outcome);
        throw error;
      }
      return outcome;
    } finally {
      admission.reject(Error('Inference acquisition not admitted'));
      try {
        if (wasCancelled) void cleanup().catch(() => undefined);
        else {
          await wait(cleanup());
          assertLive();
        }
      } finally {
        signal?.removeEventListener('abort', abort);
        if (iterator) void iterator.return?.().catch(() => undefined);
      }
    }
  };
  /**
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {(text: string) => void} [onToken]
   * @param {AbortSignal} [signal]
    @param {(usage: any) => void} [onUsage] */
  const chatStream = (messages, tools, onToken, signal, onUsage) => {
    const wireTools = tools.map(tool => {
      (tool.type === 'function' &&
        typeof tool.function?.name === 'string' &&
        tool.function.name !== '' &&
        tool.function.parameters &&
        typeof tool.function.parameters === 'object') ||
        Fail`Invalid Messages tool schema`;
      return {
        name: tool.function.name,
        ...(tool.function.description
          ? { description: tool.function.description }
          : {}),
        input_schema: tool.function.parameters,
      };
    });
    return attempt(
      harden({
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          'x-app': 'cli',
          'user-agent': 'endo-fae/0.1.0',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16_384,
          stream: true,
          ...requestContext(messages, model),
          ...(reasoningEffort
            ? {
                thinking: { type: 'adaptive' },
                output_config: { effort: reasoningEffort },
              }
            : {}),
          ...(wireTools.length ? { tools: wireTools } : {}),
        }),
      }),
      onToken,
      signal,
      onUsage,
    );
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
      for (const cancel of cancellations)
        cancel(Error('Subscription provider disposed'));
      await Promise.all([...cleanups].map(cleanup => cleanup()));
    },
  });
};
harden(makeSubscriptionMessagesProvider);
