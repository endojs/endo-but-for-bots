// @ts-check

import { Fail } from '@endo/errors';

import { boundedJson } from './bounded-json.js';
import { normalizeHostedModelDescriptor } from './hosted-backend.js';

const MODELS_URL = 'https://openrouter.ai/api/v1/models/user';
// Local resource bounds, not claims about the provider's model capacity.
const MAX_MODELS = 4096;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * @param {unknown} value
 * @param {number} limit
 */
const text = (value, limit) => {
  if (typeof value !== 'string' || value.length > limit) {
    throw Fail`Invalid OpenRouter model text`;
  }
  return value;
};

/** @param {unknown} value */
const identifier = value => {
  const result = text(value, 256);
  /^[\x21-\x7e]+$/.test(result) || Fail`Invalid OpenRouter model identifier`;
  return result;
};

/** @param {unknown} value */
const identifiers = value => {
  if (!Array.isArray(value) || value.length > 64) {
    throw Fail`Invalid OpenRouter model capabilities`;
  }
  const result = value.map(identifier);
  new Set(result).size === result.length ||
    Fail`Duplicate OpenRouter model capability`;
  return result;
};

/** @param {any} model */
const normalizeModel = model => {
  (model && typeof model === 'object' && !Array.isArray(model)) ||
    Fail`Invalid OpenRouter model`;
  const contextLength = model.context_length ?? null;
  // This reader supports context windows up to uint32 tokens.
  contextLength === null ||
    (typeof contextLength === 'number' &&
      Number.isInteger(contextLength) &&
      contextLength > 0 &&
      contextLength <= 0xffff_ffff) ||
    Fail`Invalid OpenRouter model context length`;
  let reasoning = null;
  if (model.reasoning != null) {
    const raw = model.reasoning;
    (typeof raw === 'object' && !Array.isArray(raw)) ||
      Fail`Invalid OpenRouter reasoning metadata`;
    const supportedEfforts =
      raw.supported_efforts == null ? null : identifiers(raw.supported_efforts);
    const defaultEffort =
      raw.default_effort == null ? null : identifier(raw.default_effort);
    (typeof raw.mandatory === 'boolean' &&
      (raw.default_enabled == null ||
        typeof raw.default_enabled === 'boolean') &&
      (raw.supports_max_tokens == null ||
        typeof raw.supports_max_tokens === 'boolean') &&
      (defaultEffort === null ||
        supportedEfforts === null ||
        supportedEfforts.includes(defaultEffort))) ||
      Fail`Invalid OpenRouter reasoning metadata`;
    reasoning = {
      supportedEfforts,
      defaultEffort,
      mandatory: raw.mandatory,
      defaultEnabled: raw.default_enabled ?? null,
      supportsMaxTokens: raw.supports_max_tokens ?? null,
    };
  }
  return {
    id: identifier(model.id),
    title: text(model.name, 1024),
    description: text(model.description ?? '', 16_384),
    contextLength,
    inputModalities: identifiers(model.architecture?.input_modalities),
    outputModalities: identifiers(model.architecture?.output_modalities),
    supportedParameters: identifiers(model.supported_parameters),
    reasoning,
  };
};

/**
 * Host-only, account-filtered catalog read. No conversation, inference, public
 * catalog fallback, or credential cache. The owner binds each result to the
 * credential generation used by readKey and discards it after rebinding.
 * Omitting both pagination arguments requests the complete provider list.
 * Provider descriptions are untrusted display data, never instructions.
 *
 * @param {object} powers
 * @param {() => Promise<string>} powers.readKey
 * @param {typeof globalThis.fetch} powers.fetch
 * @param {() => number} [powers.now]
 */
export const makeOpenRouterModelRead = ({ readKey, fetch, now = Date.now }) => {
  const read = async () => {
    const apiKey = await readKey();
    (typeof apiKey === 'string' &&
      /^[\x21-\x7e]+$/.test(apiKey) &&
      apiKey.length <= 512) ||
      Fail`Invalid OpenRouter credential`;
    const response = await fetch(MODELS_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Fail`OpenRouter model read refused`;
    }
    const payload = await boundedJson(
      response,
      MAX_BODY_BYTES,
      'OpenRouter model read',
    );
    (Array.isArray(payload?.data) &&
      Number(payload.data.length) <= MAX_MODELS &&
      payload.links?.next == null &&
      (payload.total_count === undefined ||
        payload.total_count === payload.data.length)) ||
      Fail`Invalid or incomplete OpenRouter model catalog`;
    const models = payload.data.map(normalizeModel);
    new Set(models.map(model => model.id)).size === models.length ||
      Fail`Duplicate OpenRouter model identifier`;
    const observedAt = now();
    (Number.isFinite(observedAt) && observedAt >= 0) ||
      Fail`Invalid OpenRouter catalog observation time`;
    return harden({ observedAt, models });
  };
  return harden(async () => {
    try {
      return await read();
    } catch (_error) {
      // Even transport and credential-reader errors can contain secret text.
      throw Fail`OpenRouter model discovery failed`;
    }
  });
};
harden(makeOpenRouterModelRead);

/**
 * Project a validated account catalog for text/tool agent backends. Routes
 * remain provider-native; adapter prefixes belong at the session boundary.
 * A generic reasoning capability does not advertise a list of effort choices.
 * @param {Awaited<ReturnType<ReturnType<typeof makeOpenRouterModelRead>>>['models']} models
 */
export const modelsFromOpenRouterCatalog = models =>
  harden(
    models
      .filter(
        model =>
          model.inputModalities.includes('text') &&
          model.outputModalities.includes('text') &&
          model.supportedParameters.includes('tools'),
      )
      .map(model => {
        const efforts = model.reasoning?.supportedEfforts || [];
        return normalizeHostedModelDescriptor({
          id: model.id,
          title: model.title,
          description: model.description,
          default: false,
          reasoningEfforts: efforts,
          defaultReasoningEffort: efforts.length
            ? (model.reasoning?.defaultEffort ?? null)
            : null,
          ...(model.contextLength === null
            ? {}
            : { contextLength: model.contextLength }),
        });
      }),
  );
harden(modelsFromOpenRouterCatalog);
