// @ts-check
/**
 * llama.cpp server provider for the Lal agent.
 * Thin wrapper over the shared OpenAI Chat Completions shape that
 * injects llama.cpp-typical defaults (e.g. a placeholder API key for
 * servers that don't require auth).
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

/**
 * Create a llama.cpp-backed chat provider (OpenAI-compatible API).
 * Uses LAL_HOST as baseURL and LAL_MODEL; optional LAL_AUTH_TOKEN.
 * Optional LAL_MAX_TOKENS sets max_tokens for completion (default 4096).
 * If the server returns "context size" errors, increase the server's n_ctx
 * or set LAL_MAX_MESSAGES to truncate to the last N messages before sending.
 *
 * @param {{ baseURL: string, model: string, apiKey?: string, maxTokens?: number, maxMessages?: number, logger?: Logger }} options
 * @returns {{ chat: (messages: CommonChatMessage[], tools: CommonTool[]) => Promise<{ message: CommonChatMessage }> }}
 */
export const makeLlamaCppProvider = ({
  baseURL,
  model,
  apiKey = 'ollama',
  maxTokens = 4096,
  maxMessages = undefined,
  logger = console,
}) => {
  const client = new OpenAI({
    apiKey,
    baseURL,
  });

  return {
    async chat(messages, tools) {
      const sendMessages = truncateMessages(messages, maxMessages, logger);
      logger.log(`[LAL] Calling llama.cpp at ${baseURL} with model: ${model}`);
      let response;
      try {
        response = await client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          tools: toOpenAIChatTools(tools),
          messages: toOpenAIChatMessages(sendMessages),
        });
      } catch (error) {
        logger.error('[LAL] llama.cpp API error:', error);
        throw error;
      }
      return { message: parseOpenAIChatChoice(response.choices?.[0]) };
    },
  };
};
