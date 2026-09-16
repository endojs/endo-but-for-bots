// @ts-check
/**
 * Streaming-capable provider selection for the Floot agent.
 *
 * Floot uses agentry's pi-ai chat adapter for every backend. The default remains
 * Anthropic, configured through the FLOOT_* variables; setting LAL_HOST retains
 * the historical local/OpenAI-compatible configuration path.
 */

import { createChatProvider } from '@endo/agentry/chat';

/**
 * @typedef {object} StreamingProvider
 * @property {(messages: object[], tools: object[]) => Promise<{ message: object }>} chat
 * @property {(messages: object[], tools: object[], onToken?: (delta: string) => void, signal?: AbortSignal) => Promise<{ message: object, usage?: { inputTokens: number, outputTokens: number } }>} chatStream
 */

/**
 * Create a streaming provider programmatically from an env-shaped config.
 *
 * Selection order:
 *   1. `FLOOT_PROVIDER` if set (`anthropic` | `lal`).
 *   2. otherwise, if legacy `LAL_HOST` is set (to any host) → agentry backend.
 *   3. default → streaming Anthropic API.
 *
 * @param {{
 *   FLOOT_PROVIDER?: string,
 *   FLOOT_MODEL?: string,
 *   FLOOT_AUTH_TOKEN?: string,
 *   FLOOT_MAX_TOKENS?: string,
 *   LAL_HOST?: string,
 *   LAL_MODEL?: string,
 *   LAL_AUTH_TOKEN?: string,
 *   LAL_MAX_TOKENS?: string,
 * }} env
 * @returns {StreamingProvider}
 */
export const createStreamingProvider = env => {
  const kind = env.FLOOT_PROVIDER || (env.LAL_HOST ? 'lal' : 'anthropic');
  const authToken = env.FLOOT_AUTH_TOKEN || env.LAL_AUTH_TOKEN;
  if (kind === 'anthropic' && !authToken) {
    throw new Error(
      'FLOOT_AUTH_TOKEN is required for Anthropic. Set it to your API key.',
    );
  }
  const maxTokens = env.FLOOT_MAX_TOKENS || env.LAL_MAX_TOKENS || '4096';
  if (!/^\d+$/.test(maxTokens) || Number(maxTokens) <= 0) {
    throw new Error(
      `FLOOT_MAX_TOKENS must be a positive integer, got "${maxTokens}".`,
    );
  }
  const config =
    kind === 'anthropic'
      ? {
          LAL_HOST: 'https://api.anthropic.com',
          LAL_MODEL: env.FLOOT_MODEL || env.LAL_MODEL || 'claude-sonnet-4-6',
          LAL_AUTH_TOKEN: authToken,
          LAL_MAX_TOKENS: maxTokens,
        }
      : env;
  return /** @type {StreamingProvider} */ (createChatProvider(config));
};
harden(createStreamingProvider);
