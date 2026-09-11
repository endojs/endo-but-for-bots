// @ts-check
/// <reference types="ses"/>

/** @import { Model } from '@earendil-works/pi-ai' */
/** @import { GetApiKey } from '../harness/types.js' */

import { resolveModelProfile } from '../harness/model.js';

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
export const parseEvalModelSpecs = value =>
  harden(
    (value || '')
      .split(',')
      .map(spec => spec.trim())
      .filter(spec => spec.length > 0),
  );
harden(parseEvalModelSpecs);

/**
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} provider
 * @param {string | undefined} fallbackToken
 * @returns {GetApiKey}
 */
const makeEnvApiKeyGetter = (env, provider, fallbackToken) => requested => {
  const requestedKey = env[`${requested.toUpperCase()}_API_KEY`];
  const configuredKey = provider
    ? env[`${provider.toUpperCase()}_API_KEY`]
    : undefined;
  return requestedKey || configuredKey || fallbackToken;
};

/**
 * Build live eval models from either an openai-compatible env-var contract or
 * comma-separated pi-ai registry model specs.
 *
 * Reads `ENDO_LLM_HOST` / `ENDO_LLM_MODEL` / `ENDO_LLM_AUTH_TOKEN` (with
 * `LAL_*` aliases) from the environment: a base URL, a model id, and a bearer
 * token. The base URL is expected to point at an endpoint that speaks the
 * OpenAI-completions protocol (an OpenRouter base URL such as
 * `https://openrouter.ai/api/v1` is one such endpoint), so the model is built
 * as an `openai-compatible` profile pointed at that base URL.
 *
 * The full model id (such as `nvidia/nemotron-...:free`) is passed with an
 * explicit `provider` so `resolveModelProfile` does not split the leading
 * `nvidia/` segment off as a pi-ai provider name. The whole string is the
 * endpoint's model id and must reach the request body intact.
 *
 * The returned `getApiKey` ignores its provider argument and returns the single
 * configured token: there is exactly one credential, and the token never
 * appears in code, config, or a committed file. It reaches only the in-process
 * environment.
 *
 * For matrix runs, `ENDO_EVAL_MODELS` or `ENDO_LLM_MODELS` may contain a
 * comma-separated list.
 * Without `ENDO_LLM_HOST` / `LAL_HOST`, each entry is
 * resolved as a pi-ai model profile such as `anthropic/claude-...`; the
 * `getApiKey` hook reads `<PROVIDER>_API_KEY` from the environment.
 * With a host
 * configured, each entry is treated as a model id for that OpenAI-compatible
 * endpoint and uses the single configured bearer token.
 *
 * @param {Record<string, string | undefined>} env
 * @param {object} [options]
 * @param {string | string[]} [options.models]
 * @returns {{ model: Model<string>, getApiKey: GetApiKey, name: string }[]}
 */
export const resolveEvalModelsFromEnv = (env, options = {}) => {
  const host = env.ENDO_LLM_HOST || env.LAL_HOST;
  const optionSpecs = Array.isArray(options.models)
    ? options.models
    : parseEvalModelSpecs(options.models);
  const modelSpecs =
    optionSpecs.length > 0
      ? optionSpecs
      : parseEvalModelSpecs(
          env.ENDO_EVAL_MODELS ||
            env.ENDO_LLM_MODELS ||
            env.ENDO_LLM_MODEL ||
            env.LAL_MODEL,
        );
  const token = env.ENDO_LLM_AUTH_TOKEN || env.LAL_AUTH_TOKEN;
  if (modelSpecs.length === 0) {
    return harden([]);
  }
  if (host && !token) {
    return harden([]);
  }

  return harden(
    modelSpecs.map(modelSpec => {
      const parsedProvider =
        !host && modelSpec.includes('/')
          ? modelSpec.slice(0, modelSpec.indexOf('/'))
          : undefined;
      const modelConfig = host
        ? {
            provider: 'openai-compatible',
            baseUrl: host,
            model: modelSpec,
            api: 'openai-completions',
            reasoning: /reasoning|thinking/i.test(modelSpec),
          }
        : { model: modelSpec };
      const { model } = resolveModelProfile(modelConfig);
      return harden({
        model,
        name: model.name || `${model.provider}/${model.id}`,
        getApiKey: makeEnvApiKeyGetter(env, parsedProvider, token),
      });
    }),
  );
};
harden(resolveEvalModelsFromEnv);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ model: Model<string>, getApiKey: GetApiKey } | undefined}
 */
export const resolveEvalModelFromEnv = env => {
  const host = env.ENDO_LLM_HOST || env.LAL_HOST;
  const modelId = env.ENDO_LLM_MODEL || env.LAL_MODEL;
  const token = env.ENDO_LLM_AUTH_TOKEN || env.LAL_AUTH_TOKEN;
  if (!host || !modelId || !token) {
    return undefined;
  }
  const [first] = resolveEvalModelsFromEnv(env, { models: modelId });
  // The preceding gate ensures this configuration always resolves one model.
  if (first === undefined) {
    throw new Error('configured eval model could not be resolved');
  }
  return harden({ model: first.model, getApiKey: first.getApiKey });
};
harden(resolveEvalModelFromEnv);
