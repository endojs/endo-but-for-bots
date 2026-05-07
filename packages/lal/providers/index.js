// @ts-check
/**
 * LLM providers for the Lal agent.
 * Use createProvider(env) to get a provider for the current configuration.
 */

import { makeAnthropicProvider } from './anthropic.js';
import { makeGeminiProvider } from './gemini.js';
import { makeLlamaCppProvider } from './llamacpp.js';
import { makeOllamaProvider } from './ollama.js';
import { makeOpenRouterProvider } from './openrouter.js';
import { detectProviderKind, resolveModelForHost } from './config.js';

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} log
 * @property {(...args: unknown[]) => void} error
 * @property {(...args: unknown[]) => void} warn
 */

/**
 * @typedef {object} Provider
 * @property {(messages: object[], tools: object[]) => Promise<{ message: object }>} chat
 */

/**
 * Create the appropriate chat provider from environment.
 *
 * Provider selection based on LAL_HOST:
 * - Contains 'anthropic.com' -> Anthropic provider
 * - Contains 'openrouter.ai' -> OpenRouter provider
 * - Contains '/v1' suffix -> llama.cpp (OpenAI-compatible) provider
 * - Otherwise (e.g., 'http://localhost:11434') -> Native Ollama provider
 *
 * Environment variables:
 * - LAL_HOST: Base URL for the LLM service (default: http://localhost:11434)
 * - LAL_MODEL: Model name (defaults vary by provider)
 * - LAL_AUTH_TOKEN: API key for authentication
 * - LAL_MAX_TOKENS: Max tokens for completion (llama.cpp / OpenRouter)
 * - LAL_MAX_MESSAGES: Truncate to last N messages (llama.cpp / OpenRouter)
 * - LAL_OPENROUTER_REFERER / LAL_OPENROUTER_TITLE: optional attribution
 *   headers shown on OpenRouter's request dashboard
 *
 * @param {{
 *   LAL_HOST?: string,
 *   LAL_MODEL?: string,
 *   LAL_AUTH_TOKEN?: string,
 *   LAL_MAX_TOKENS?: string,
 *   LAL_MAX_MESSAGES?: string,
 *   LAL_OPENROUTER_REFERER?: string,
 *   LAL_OPENROUTER_TITLE?: string,
 * }} env
 * @param {{ logger?: Logger }} [options]
 * @returns {Provider}
 */
export const createProvider = (env, { logger = console } = {}) => {
  const baseURL = env.LAL_HOST || 'http://localhost:11434';
  const providerKind = detectProviderKind(baseURL);
  const model = resolveModelForHost(baseURL, env.LAL_MODEL);

  if (providerKind === 'anthropic') {
    const apiKey = env.LAL_AUTH_TOKEN;
    if (!apiKey || apiKey === '') {
      throw new Error(
        'LAL_AUTH_TOKEN is required for Anthropic. Set it to your API key.',
      );
    }
    logger.log(`[LAL] Using Anthropic provider with model: ${model}`);
    return makeAnthropicProvider({ apiKey, model, logger });
  }

  if (providerKind === 'gemini') {
    const apiKey = env.LAL_AUTH_TOKEN;
    if (!apiKey || apiKey === '') {
      throw new Error(
        'LAL_AUTH_TOKEN is required for Gemini. Set it to your API key.',
      );
    }
    const maxTokens = env.LAL_MAX_TOKENS
      ? parseInt(env.LAL_MAX_TOKENS, 10)
      : 4096;
    const maxMessages = env.LAL_MAX_MESSAGES
      ? parseInt(env.LAL_MAX_MESSAGES, 10)
      : undefined;
    logger.log(
      `[LAL] Using Gemini provider at ${baseURL} with model: ${model}`,
    );
    return makeGeminiProvider({
      baseURL,
      model,
      apiKey,
      maxTokens,
      maxMessages,
      logger,
    });
  }

  if (providerKind === 'openrouter') {
    const apiKey = env.LAL_AUTH_TOKEN;
    if (!apiKey || apiKey === '') {
      throw new Error(
        'LAL_AUTH_TOKEN is required for OpenRouter. Set it to your API key.',
      );
    }
    const maxTokens = env.LAL_MAX_TOKENS
      ? parseInt(env.LAL_MAX_TOKENS, 10)
      : 4096;
    const maxMessages = env.LAL_MAX_MESSAGES
      ? parseInt(env.LAL_MAX_MESSAGES, 10)
      : undefined;
    logger.log(
      `[LAL] Using OpenRouter provider at ${baseURL} with model: ${model}`,
    );
    return makeOpenRouterProvider({
      baseURL,
      model,
      apiKey,
      maxTokens,
      maxMessages,
      referer: env.LAL_OPENROUTER_REFERER,
      title: env.LAL_OPENROUTER_TITLE,
      logger,
    });
  }

  if (providerKind === 'openai-compatible') {
    // Use llama.cpp (OpenAI-compatible) provider when URL contains /v1
    const apiKey = env.LAL_AUTH_TOKEN || 'ollama';
    const maxTokens = env.LAL_MAX_TOKENS
      ? parseInt(env.LAL_MAX_TOKENS, 10)
      : 4096;
    const maxMessages = env.LAL_MAX_MESSAGES
      ? parseInt(env.LAL_MAX_MESSAGES, 10)
      : undefined;
    logger.log(
      `[LAL] Using llama.cpp provider at ${baseURL} with model: ${model}`,
    );
    return makeLlamaCppProvider({
      baseURL,
      model,
      apiKey,
      maxTokens,
      maxMessages,
      logger,
    });
  }

  // Default: Use native Ollama provider
  const apiKey = env.LAL_AUTH_TOKEN;
  logger.log(
    `[LAL] Using native Ollama provider at ${baseURL} with model: ${model}`,
  );
  return makeOllamaProvider({
    host: baseURL,
    model,
    apiKey,
    logger,
  });
};

export { makeAnthropicProvider } from './anthropic.js';
export { makeGeminiProvider } from './gemini.js';
export { makeLlamaCppProvider } from './llamacpp.js';
export { makeOllamaProvider } from './ollama.js';
export { makeOpenRouterProvider } from './openrouter.js';
