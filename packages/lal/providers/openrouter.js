// @ts-check
/**
 * OpenRouter provider for the Lal agent.
 * Thin wrapper over the shared OpenAI Chat Completions shape that adds:
 *  - optional `HTTP-Referer` / `X-Title` headers for OpenRouter's
 *    request-attribution dashboard
 *  - an optional `reasoning` request-body parameter
 *  - a clearer 401 error message
 *
 * Models are namespaced by upstream vendor (e.g.
 * `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`).
 */

// eslint-disable-next-line import/no-unresolved
import OpenAI from 'openai';

import {
  toOpenAIChatMessages,
  toOpenAIChatTools,
  parseOpenAIChatChoice,
  truncateMessages,
} from './openai-chat.js';

/** @import { Logger, CommonTool, CommonChatMessage } from './openai-chat.js' */
/** @import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions' */

/**
 * @typedef {object} ReasoningConfig
 * @property {'minimal'|'low'|'medium'|'high'|'xhigh'} [effort]
 * @property {number} [max_tokens]
 * @property {boolean} [exclude]
 * @property {boolean} [enabled]
 */

/**
 * Chat Completions request body with the OpenRouter-specific `reasoning`
 * extension. Lets the request shape stay type-checked even though the upstream
 * OpenAI types do not know about `reasoning`.
 *
 * @typedef {ChatCompletionCreateParamsNonStreaming & { reasoning?: ReasoningConfig }} OpenRouterChatBody
 */

/**
 * Create an OpenRouter-backed chat provider.
 *
 * @param {{
 *   baseURL?: string,
 *   model: string,
 *   apiKey: string,
 *   maxTokens?: number,
 *   maxMessages?: number,
 *   referer?: string,
 *   title?: string,
 *   reasoning?: ReasoningConfig,
 *   logger?: Logger,
 * }} options
 * @returns {{ chat: (messages: CommonChatMessage[], tools: CommonTool[]) => Promise<{ message: CommonChatMessage }> }}
 */
export const makeOpenRouterProvider = ({
  baseURL = 'https://openrouter.ai/api/v1',
  model,
  apiKey,
  maxTokens = 4096,
  maxMessages = undefined,
  referer,
  title,
  reasoning,
  logger = console,
}) => {
  /** @type {Record<string, string>} */
  const defaultHeaders = {};
  if (referer) defaultHeaders['HTTP-Referer'] = referer;
  if (title) defaultHeaders['X-Title'] = title;

  const client = new OpenAI({
    apiKey,
    baseURL,
    ...(Object.keys(defaultHeaders).length > 0 && { defaultHeaders }),
  });

  return {
    async chat(messages, tools) {
      const sendMessages = truncateMessages(messages, maxMessages, logger);
      logger.log(`[LAL] Calling OpenRouter at ${baseURL} with model: ${model}`);

      /** @type {OpenRouterChatBody} */
      const body = {
        model,
        max_tokens: maxTokens,
        messages: toOpenAIChatMessages(sendMessages),
        tools: toOpenAIChatTools(tools),
        ...(reasoning && { reasoning }),
      };

      let response;
      try {
        response = await client.chat.completions.create(body);
      } catch (error) {
        logger.error('[LAL] OpenRouter API error:', error);
        const status =
          /** @type {{ status?: number, statusCode?: number }} */ (error)
            .status ??
          /** @type {{ status?: number, statusCode?: number }} */ (error)
            .statusCode;
        if (status === 401) {
          throw new Error(
            'OpenRouter authentication failed (invalid or expired API key). Check LAL_AUTH_TOKEN.',
          );
        }
        throw error;
      }

      return { message: parseOpenAIChatChoice(response.choices?.[0]) };
    },
  };
};
harden(makeOpenRouterProvider);
