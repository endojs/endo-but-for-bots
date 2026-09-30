// @ts-check
/** Streaming providers selected from the factory's resolved configuration. */

import { Fail, q } from '@endo/errors';
import { makeOpenRouterProvider } from '@endo/lal/providers/index.js';

import { makeStreamingAnthropicProvider } from './anthropic-streaming.js';
import { assertProviderKind } from './config.js';

/**
 * @typedef {object} StreamingProvider
 * @property {(messages: object[], tools: object[]) => Promise<{ message: object }>} chat
 * @property {(messages: object[], tools: object[], onToken?: (delta: string) => void, signal?: AbortSignal, onUsage?: (usage: Partial<import('@endo/hosted-agent/token-usage.js').TokenUsage>) => void) => Promise<{ message: object, usage?: Partial<import('@endo/hosted-agent/token-usage.js').TokenUsage> }>} chatStream
 * The optional usage callback reports incremental usage before success or
 * failure. If invoked, its counts replace (not add to) the returned usage.
 * All notifications must occur before the chatStream promise settles.
 */

/**
 * Environment parsing belongs to setup; Secrets resolution precedes this call.
 * @param {{ provider?: string, model?: string, apiKey?: string }} config
 * @returns {StreamingProvider}
 */
export const createStreamingProvider = config => {
  for (const key of Reflect.ownKeys(config)) {
    key === 'provider' ||
      key === 'model' ||
      key === 'apiKey' ||
      Fail`Unexpected Floot provider configuration field ${q(key)}`;
  }
  const { provider = 'anthropic', model, apiKey = '' } = config;
  assertProviderKind(provider);
  if (provider === 'openrouter') {
    return makeOpenRouterProvider({ apiKey, model: model || '' });
  }
  apiKey || Fail`Anthropic API key is required`;
  return makeStreamingAnthropicProvider({
    apiKey,
    model: model || 'claude-sonnet-4-6',
  });
};
harden(createStreamingProvider);

export { makeStreamingAnthropicProvider } from './anthropic-streaming.js';
