// @ts-check
/* global fetch */

import { toOpenAICompatibleMessages } from './openai-compatible-messages.js';

/**
 * OpenRouter's buffered chat API, shared by Fae and Floot.
 * No automatic retries: a failed request may already have incurred charges.
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {number} [options.maxTokens]
 * @param {typeof fetch} [options.fetchImpl]
 */
export const makeOpenRouterProvider = ({
  apiKey,
  model,
  maxTokens,
  fetchImpl = fetch,
}) => {
  if (!apiKey || !apiKey.trim()) throw Error('OpenRouter API key is required');
  if (!model || !model.includes('/')) {
    throw Error('OpenRouter model must include its organization prefix');
  }
  if (
    maxTokens !== undefined &&
    (!Number.isInteger(maxTokens) || maxTokens <= 0)
  ) {
    throw Error('OpenRouter maxTokens must be a positive integer');
  }

  /**
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {AbortSignal} [signal]
   */
  const chat = async (messages, tools, signal) => {
    const response = await fetchImpl(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-OpenRouter-Title': 'Endo Floot/Fae',
        },
        body: JSON.stringify({
          model,
          messages: toOpenAICompatibleMessages(messages),
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          stream: false,
        }),
      },
    );
    // Never echo a provider response body: it can contain credentials or input.
    if (!response.ok)
      throw Error(`OpenRouter request failed (HTTP ${response.status})`);
    const result = await response.json();
    if (result.error) throw Error('OpenRouter returned an API error');
    const choice = result.choices?.[0];
    if (!choice?.message || choice.finish_reason === 'error') {
      throw Error('OpenRouter returned no successful assistant message');
    }
    if (
      choice.finish_reason === 'length' ||
      choice.finish_reason === 'content_filter'
    ) {
      throw Error(`OpenRouter completion stopped: ${choice.finish_reason}`);
    }
    const message = choice.message;
    if (
      message.role !== 'assistant' ||
      (message.content != null && typeof message.content !== 'string') ||
      (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))
    ) {
      throw Error('OpenRouter returned an invalid assistant message');
    }
    for (const call of message.tool_calls || []) {
      if (
        call.type !== 'function' ||
        typeof call.id !== 'string' ||
        !call.id ||
        typeof call.function?.name !== 'string' ||
        !call.function.name ||
        typeof call.function.arguments !== 'string'
      ) {
        throw Error('OpenRouter returned an invalid tool call');
      }
    }
    if (
      result.usage &&
      ![result.usage.prompt_tokens, result.usage.completion_tokens].every(
        count =>
          typeof count === 'number' && Number.isFinite(count) && count >= 0,
      )
    ) {
      throw Error('OpenRouter returned invalid token usage');
    }
    return harden({
      message: { ...message, content: message.content || '' },
      ...(result.usage
        ? {
            usage: {
              inputTokens: result.usage.prompt_tokens || 0,
              outputTokens: result.usage.completion_tokens || 0,
            },
          }
        : {}),
    });
  };
  return harden({
    chat,
    /**
     * @param {any[]} messages
     * @param {any[]} tools
     * @param {(text: string) => void} [onToken]
     * @param {AbortSignal} [signal]
     */
    async chatStream(messages, tools, onToken, signal) {
      const result = await chat(messages, tools, signal);
      if (result.message.content) onToken?.(result.message.content);
      return result;
    },
  });
};
harden(makeOpenRouterProvider);
