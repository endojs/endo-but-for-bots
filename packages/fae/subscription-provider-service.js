// @ts-check

import { makeError } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { usageFromProviderEvent } from '@endo/hosted-agent/provider-usage.js';
import { M } from '@endo/patterns';

const ServiceI = M.interface('FaeSubscriptionProvider', {
  chat: M.callWhen(M.arrayOf(M.record()), M.arrayOf(M.record())).returns(
    M.record(),
  ),
  getInfo: M.call().returns(M.record()),
});

/**
 * Convert the common Fae transcript without exposing HTTP or credential powers.
 * Thinking is disabled because this transcript does not retain signed thinking.
 * @param {readonly any[]} messages
 * @param {readonly any[]} tools
 * @param {string} model
 * @param {number} maxTokens
 */
const messagesRequest = (messages, tools, model, maxTokens) => {
  const system = [];
  const turns = [];
  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content);
    } else if (message.role === 'user') {
      turns.push({ role: 'user', content: message.content });
    } else if (message.role === 'tool') {
      turns.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: message.content,
          },
        ],
      });
    } else if (message.role === 'assistant') {
      const content = [];
      if (message.content)
        content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || []) {
        if (!call.id) throw Error('Tool call identity required');
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input:
            typeof call.function.arguments === 'string'
              ? JSON.parse(call.function.arguments)
              : call.function.arguments,
        });
      }
      if (content.length) turns.push({ role: 'assistant', content });
    } else {
      throw Error('Unsupported message role');
    }
  }
  return {
    model,
    max_tokens: maxTokens,
    stream: false,
    thinking: { type: 'disabled' },
    system: system.join('\n\n'),
    messages: turns,
    tools: tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    })),
  };
};

/** @param {any} response */
const commonResponse = response => {
  if (!Array.isArray(response.content))
    throw Error('Invalid Messages response');
  let content = '';
  const calls = [];
  for (const block of response.content) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'tool_use')
      calls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
  }
  const usage = usageFromProviderEvent(response);
  return {
    message: {
      role: 'assistant',
      content,
      ...(calls.length ? { tool_calls: calls } : {}),
    },
    ...(usage
      ? {
          usage: {
            ...usage,
            context: {
              usedTokens:
                usage.inputTokens +
                usage.outputTokens +
                usage.cachedInputTokens +
                usage.cacheWriteInputTokens,
              windowTokens: 0,
            },
          },
        }
      : {}),
  };
};

/**
 * Hosted bridge: receives only a Subscription, never a Secrets manager or blob.
 * Each inference acquires and revokes its own broker endpoint. The service can
 * be imported by an older daemon; only its common chat protocol crosses peers.
 * @param {any} powers Namespace containing `llm-subscription`.
 * @param {{kind: 'codex'|'claude', model: string, sessionId: string, maxTokens?: number}} config
 * @param {{makeResponsesProvider?: (options: any) => any}} [dependencies]
 */
export const makeSubscriptionProviderService = (
  powers,
  config,
  dependencies = {},
) => {
  const { kind, model, sessionId, maxTokens = 4096 } = config;
  if (
    !['codex', 'claude'].includes(kind) ||
    typeof model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 32_768 ||
    Object.keys(config).some(
      key => !['kind', 'model', 'sessionId', 'maxTokens'].includes(key),
    )
  ) {
    throw makeError('Invalid subscription provider configuration.');
  }
  return makeExo('FaeSubscriptionProvider', ServiceI, {
    async chat(messages, tools) {
      await null;
      let provider;
      let endpoint;
      try {
        const subscription = await E(powers).lookup('llm-subscription');
        if (kind === 'codex') {
          // The hosted release owns the Responses adapter and its stream parser.
          // The older local daemon need not import that dependency tree.
          const makeResponsesProvider =
            dependencies.makeResponsesProvider ??
            /** @type {any} */ (await import('@endo/lal/providers/index.js'))
              .makeSubscriptionResponsesProvider;
          if (typeof makeResponsesProvider !== 'function')
            throw Error('Hosted Responses adapter unavailable');
          provider = makeResponsesProvider({
            subscription,
            model,
            sessionId,
            reasoningEffort: 'low',
          });
          return harden(await provider.chat([...messages], [...tools]));
        }
        const catalog = await E(subscription).describe();
        // Some Claude brokers have no catalog. A populated catalog is binding.
        if (catalog.models?.length && !catalog.models.includes(model))
          throw Error('Model unavailable');
        endpoint = await E(subscription).openEndpoint(harden({ sessionId }));
        const result = await E(endpoint).request(
          harden({
            method: 'POST',
            path: '/v1/messages',
            body: JSON.stringify(
              messagesRequest(messages, tools, model, maxTokens),
            ),
          }),
        );
        if (
          result.status !== 200 ||
          typeof result.body !== 'string' ||
          Number(result.body.length) > 8_388_608
        )
          throw Error('Subscription request failed');
        return harden(commonResponse(JSON.parse(result.body)));
      } catch {
        // Broker errors or response bodies must never cross this service boundary.
        throw makeError(
          'Subscription inference failed. Check account availability and the selected model, then retry.',
        );
      } finally {
        await Promise.all([
          provider
            ? Promise.resolve().then(() => provider.dispose())
            : undefined,
          endpoint ? E(endpoint).revoke() : undefined,
        ]).catch(() => {
          throw makeError(
            'Subscription endpoint cleanup failed. Retry after checking the hosted broker.',
          );
        });
      }
    },
    getInfo: () =>
      harden({ kind: `${kind}-subscription`, model, authRequired: false }),
  });
};
harden(makeSubscriptionProviderService);

/**
 * @param {any} powers
 * @param {unknown} context
 * @param {{env?: Record<string, string>}} [options]
 */
export const make = (powers, context, { env = {} } = {}) =>
  makeSubscriptionProviderService(powers, {
    kind: /** @type {'codex'|'claude'} */ (env.PROVIDER_KIND),
    model: env.PROVIDER_MODEL,
    sessionId: env.PROVIDER_SESSION_ID,
    maxTokens:
      env.PROVIDER_MAX_TOKENS === undefined
        ? undefined
        : Number(env.PROVIDER_MAX_TOKENS),
  });
harden(make);
