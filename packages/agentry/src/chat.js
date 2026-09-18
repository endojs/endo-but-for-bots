// @ts-check

/** @import { AssistantMessage, Context, Message, Model, Tool } from '@earendil-works/pi-ai' */

import { completeSimple, streamSimple } from '@earendil-works/pi-ai/compat';

import { resolveModelProfile } from './harness/model.js';

/** @typedef {{ id?: string, type?: string, function: { name: string, arguments: string | object } }} ChatToolCall */
/** @typedef {{ role: 'system' | 'user' | 'assistant' | 'tool', content?: string | null, tool_calls?: ChatToolCall[], tool_call_id?: string }} ChatMessage */
/** @typedef {{ type: 'function', function: { name: string, description?: string, parameters: object } }} ChatTool */

const emptyUsage = harden({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: harden({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

const zeroCost = harden({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

/**
 * Detect the provider kind historically implied by an Endo agent's host URL.
 *
 * @param {string} baseUrl
 * @returns {'anthropic' | 'google' | 'openai-compatible' | 'ollama'}
 */
export const detectProviderKind = baseUrl => {
  if (baseUrl.includes('anthropic.com')) return 'anthropic';
  if (
    baseUrl.includes('googleapis.com') ||
    baseUrl.includes('generativelanguage')
  ) {
    return 'google';
  }
  if (baseUrl.includes('/v1')) return 'openai-compatible';
  return 'ollama';
};
harden(detectProviderKind);

const defaultModels = harden({
  anthropic: 'claude-sonnet-4-6-20250514',
  google: 'gemini-2.5-pro',
  'openai-compatible': 'qwen3',
  ollama: 'qwen3.6',
});

/** @param {string} baseUrl */
export const getDefaultModelForHost = baseUrl =>
  defaultModels[detectProviderKind(baseUrl)];
harden(getDefaultModelForHost);

/**
 * @param {string} baseUrl
 * @param {string} [explicitModel]
 */
export const resolveModelForHost = (baseUrl, explicitModel) => {
  const providerDefault = getDefaultModelForHost(baseUrl);
  if (
    !explicitModel ||
    explicitModel === 'qwen3' ||
    explicitModel === 'qwen3.6'
  ) {
    return providerDefault;
  }
  return explicitModel;
};
harden(resolveModelForHost);

/**
 * Resolve a model from pi-ai's catalog when possible, while preserving the
 * historical agent-provider contract that permits an arbitrary model id.
 *
 * @param {'anthropic' | 'google' | 'openai-compatible' | 'ollama'} provider
 * @param {string} modelName
 * @param {string} baseUrl
 * @returns {Model<string>}
 */
const resolveChatModel = (provider, modelName, baseUrl) => {
  try {
    return resolveModelProfile(
      provider === 'anthropic' || provider === 'google'
        ? { provider, model: modelName }
        : { provider, model: modelName, baseUrl },
    ).model;
  } catch (error) {
    if (
      (provider !== 'anthropic' && provider !== 'google') ||
      !(/** @type {Error} */ (error).message.startsWith('Unknown pi-ai model:'))
    ) {
      throw error;
    }
    return harden({
      id: modelName,
      name: `${provider}/${modelName}`,
      api:
        provider === 'anthropic'
          ? 'anthropic-messages'
          : 'google-generative-ai',
      provider,
      baseUrl,
      reasoning: true,
      input: ['text'],
      cost: zeroCost,
      contextWindow: 200_000,
      maxTokens: 8192,
    });
  }
};

/**
 * @param {ChatMessage[]} chatMessages
 * @param {Model<string>} model
 * @returns {Context}
 */
const toPiContext = (chatMessages, model) => {
  let systemPrompt;
  /** @type {Message[]} */
  const messages = [];
  /** @type {Map<string, string>} */
  const toolNames = new Map();

  for (const message of chatMessages) {
    if (message.role === 'system') {
      systemPrompt = message.content || '';
      continue;
    }
    if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: message.content || '',
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === 'assistant') {
      /** @type {AssistantMessage['content']} */
      const content = [];
      if (message.content)
        content.push({ type: 'text', text: message.content });
      for (const [index, call] of (message.tool_calls || []).entries()) {
        const id = call.id || `tool_${messages.length}_${index}`;
        toolNames.set(id, call.function.name);
        let args = call.function.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        content.push({
          type: 'toolCall',
          id,
          name: call.function.name,
          arguments: args,
        });
      }
      messages.push({
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage,
        stopReason: message.tool_calls?.length ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      });
      continue;
    }
    const toolCallId = message.tool_call_id || 'unknown';
    messages.push({
      role: 'toolResult',
      toolCallId,
      toolName: toolNames.get(toolCallId) || 'unknown',
      content: [{ type: 'text', text: message.content || '' }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  return { ...(systemPrompt === undefined ? {} : { systemPrompt }), messages };
};

/**
 * @param {AssistantMessage} response
 * @returns {{ message: ChatMessage }}
 */
const fromPiMessage = response => {
  let content = '';
  /** @type {ChatToolCall[]} */
  const toolCalls = [];
  for (const block of response.content) {
    if (block.type === 'text') content += block.text;
    if (block.type === 'toolCall') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.arguments),
        },
      });
    }
  }
  return {
    message: {
      role: 'assistant',
      content,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    },
  };
};

/**
 * Build the common chat-provider adapter used by Fae, Jaine, and Floot on top
 * of agentry's pi-ai model resolver.
 *
 * @param {{ LAL_HOST?: string, LAL_MODEL?: string, LAL_AUTH_TOKEN?: string, LAL_MAX_TOKENS?: string }} env
 * @param {{ model?: Model<string>, complete?: typeof completeSimple, stream?: typeof streamSimple }} [powers]
 */
export const createChatProvider = (
  env,
  {
    model: modelOverride,
    complete = completeSimple,
    stream = streamSimple,
  } = {},
) => {
  const baseUrl = env.LAL_HOST || 'http://localhost:11434';
  const provider = detectProviderKind(baseUrl);
  const modelName = resolveModelForHost(baseUrl, env.LAL_MODEL);
  const model = modelOverride || resolveChatModel(provider, modelName, baseUrl);
  const maxTokens = env.LAL_MAX_TOKENS
    ? Number.parseInt(env.LAL_MAX_TOKENS, 10)
    : undefined;

  /**
   * @param {ChatMessage[]} messages
   * @param {ChatTool[]} tools
   */
  const makeRequest = (messages, tools) => {
    const context = toPiContext(messages, model);
    /** @type {Tool[]} */
    context.tools = tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      // The common provider contract already requires JSON Schema here.
      parameters: /** @type {any} */ (tool.function.parameters),
    }));
    return {
      context,
      options: {
        ...(env.LAL_AUTH_TOKEN ? { apiKey: env.LAL_AUTH_TOKEN } : {}),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      },
    };
  };

  return harden({
    /**
     * @param {ChatMessage[]} messages
     * @param {ChatTool[]} tools
     */
    async chat(messages, tools) {
      const { context, options } = makeRequest(messages, tools);
      const response = await complete(model, context, options);
      return fromPiMessage(response);
    },
    /**
     * @param {ChatMessage[]} messages
     * @param {ChatTool[]} tools
     * @param {(delta: string) => void} [onToken]
     * @param {AbortSignal} [signal]
     */
    async chatStream(messages, tools, onToken, signal) {
      const { context, options } = makeRequest(messages, tools);
      const eventStream = stream(model, context, {
        ...options,
        ...(signal ? { signal } : {}),
      });
      for await (const event of eventStream) {
        if (event.type === 'text_delta') onToken?.(event.delta);
      }
      return fromPiMessage(await eventStream.result());
    },
  });
};
harden(createChatProvider);
