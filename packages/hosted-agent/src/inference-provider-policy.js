// @ts-check

import { Fail } from '@endo/errors';
import { encodeUtf8 } from '@endo/utf8/encode.js';

const LIMIT_FIELDS = harden([
  'concurrentTurns',
  'requestsPerMinute',
  'dailyDollars',
  'dailyTokens',
  'maxOutputTokens',
  'maxRequestBytes',
]);

export const DEFAULT_PROVIDER_LIMITS = harden({
  concurrentTurns: 2,
  requestsPerMinute: 20,
  dailyDollars: 5,
  maxOutputTokens: 4096,
  maxRequestBytes: 8 * 1024 * 1024,
});
harden(DEFAULT_PROVIDER_LIMITS);

export const DEFAULT_AGENT_LIMITS = harden({
  ...DEFAULT_PROVIDER_LIMITS,
  concurrentTurns: 1,
  requestsPerMinute: 10,
  dailyDollars: 2,
});
harden(DEFAULT_AGENT_LIMITS);

export const DEFAULT_OWNER_INFERENCE_LIMITS = DEFAULT_PROVIDER_LIMITS;

const positiveInteger = (value, name) => {
  (Number.isSafeInteger(value) && Number(value) > 0) ||
    Fail`Invalid inference limit ${name}`;
  return Number(value);
};

/**
 * Validate and complete one provider, owner, or agent limit record.
 * A token budget replaces the default dollar budget so an unpriced typed
 * model can be used without pretending its cost is zero.
 *
 * @param {any} proposed
 * @param {Record<string, number>} [defaults]
 * @param {Record<string, number>} [ceilings]
 */
export const validateInferenceLimits = (
  proposed = {},
  defaults = DEFAULT_PROVIDER_LIMITS,
  ceilings = harden({}),
) => {
  (proposed && typeof proposed === 'object' && !Array.isArray(proposed)) ||
    Fail`Invalid inference limits`;
  Reflect.ownKeys(proposed).every(key => LIMIT_FIELDS.includes(String(key))) ||
    Fail`Invalid inference limit field`;
  !(
    Object.hasOwn(proposed, 'dailyDollars') &&
    Object.hasOwn(proposed, 'dailyTokens')
  ) || Fail`Inference limits require exactly one daily budget`;
  const limits = { ...defaults, ...proposed };
  if (Object.hasOwn(proposed, 'dailyTokens')) delete limits.dailyDollars;
  if (Object.hasOwn(proposed, 'dailyDollars')) delete limits.dailyTokens;
  const checked = {};
  for (const [name, value] of Object.entries(limits)) {
    if (name === 'dailyDollars') {
      (typeof value === 'number' && Number.isFinite(value) && value > 0) ||
        Fail`Invalid inference limit ${name}`;
      checked[name] = value;
    } else {
      checked[name] = positiveInteger(value, name);
    }
    const ceiling = ceilings[name];
    ceiling === undefined ||
      Number(checked[name]) <= ceiling ||
      Fail`Inference limit exceeds deployment ceiling`;
  }
  Object.hasOwn(checked, 'dailyDollars') !==
    Object.hasOwn(checked, 'dailyTokens') ||
    Fail`Inference limits require exactly one daily budget`;
  // A ceiling on one budget kind must not be escaped by choosing the other.
  for (const kind of ['dailyDollars', 'dailyTokens']) {
    Object.hasOwn(checked, kind) ||
      ceilings[kind] === undefined ||
      Object.hasOwn(
        ceilings,
        kind === 'dailyDollars' ? 'dailyTokens' : 'dailyDollars',
      ) ||
      Fail`Inference limit exceeds deployment ceiling`;
  }
  return harden(checked);
};
harden(validateInferenceLimits);

/** @param {Record<string, number>} prior @param {Record<string, number>} next */
export const raisedInferenceLimits = (prior, next) => {
  const raised = [];
  for (const name of LIMIT_FIELDS) {
    const before = prior[name];
    const after = next[name];
    if (after !== undefined && (before === undefined || after > before)) {
      raised.push(harden({ name, oldValue: before ?? null, newValue: after }));
    }
  }
  if (
    Object.hasOwn(prior, 'dailyDollars') !== Object.hasOwn(next, 'dailyDollars')
  ) {
    raised.push(
      harden({
        name: 'dailyBudgetKind',
        oldValue: Object.hasOwn(prior, 'dailyDollars') ? 'dollars' : 'tokens',
        newValue: Object.hasOwn(next, 'dailyDollars') ? 'dollars' : 'tokens',
      }),
    );
  }
  return harden(raised);
};
harden(raisedInferenceLimits);

const ANTHROPIC_MESSAGE_FIELDS = harden([
  'model',
  'messages',
  'system',
  'max_tokens',
  'stop_sequences',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'tools',
  'tool_choice',
  'metadata',
]);
const ANTHROPIC_COUNT_FIELDS = harden([
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
]);
/**
 * Validate an untrusted provider-wire request before admission or secret read.
 *
 * @param {any} message
 * @param {{ model: string, maxOutputTokens: number, maxRequestBytes: number }} policy
 */
export const validateAnthropicInferenceRequest = (message, policy) => {
  (message && typeof message === 'object' && !Array.isArray(message)) ||
    Fail`inference-request-refused`;
  const fields = harden(['method', 'path', 'body', 'headers']);
  Reflect.ownKeys(message).every(key => fields.includes(String(key))) ||
    Fail`inference-request-refused`;
  message.method === 'POST' || Fail`inference-request-refused`;
  message.path === '/v1/messages' ||
    message.path === '/v1/messages/count_tokens' ||
    Fail`inference-request-refused`;
  const headers = message.headers ?? {};
  (headers && typeof headers === 'object' && !Array.isArray(headers)) ||
    Fail`inference-request-refused`;
  Object.keys(headers).every(
    name =>
      !['authorization', 'x-api-key', 'base-url'].includes(name.toLowerCase()),
  ) || Fail`inference-request-refused`;
  typeof message.body === 'string' || Fail`inference-request-refused`;
  encodeUtf8(message.body).length <= policy.maxRequestBytes ||
    Fail`inference-request-refused`;
  let body;
  try {
    body = JSON.parse(message.body);
  } catch {
    throw Fail`inference-request-refused`;
  }
  (body && typeof body === 'object' && !Array.isArray(body)) ||
    Fail`inference-request-refused`;
  const allowed =
    message.path === '/v1/messages'
      ? ANTHROPIC_MESSAGE_FIELDS
      : ANTHROPIC_COUNT_FIELDS;
  Reflect.ownKeys(body).every(key => allowed.includes(String(key))) ||
    Fail`inference-request-refused`;
  body.model === policy.model || Fail`inference-request-refused`;
  (Array.isArray(body.messages) && Number(body.messages.length) <= 256) ||
    Fail`inference-request-refused`;
  body.tools === undefined ||
    (Array.isArray(body.tools) && Number(body.tools.length) <= 128) ||
    Fail`inference-request-refused`;
  body.stop_sequences === undefined ||
    (Array.isArray(body.stop_sequences) &&
      Number(body.stop_sequences.length) <= 16 &&
      body.stop_sequences.every(
        value => typeof value === 'string' && value.length <= 1024,
      )) ||
    Fail`inference-request-refused`;
  if (message.path === '/v1/messages') {
    (Number.isSafeInteger(body.max_tokens) &&
      Number(body.max_tokens) > 0 &&
      Number(body.max_tokens) <= policy.maxOutputTokens) ||
      Fail`inference-request-refused`;
  }
  // Forward the bytes that were validated, not the caller's string. A
  // repeated key parses last-wins here but may parse differently upstream.
  const forwardBody = JSON.stringify(body);
  const inputBytes = encodeUtf8(forwardBody).length;
  inputBytes <= policy.maxRequestBytes || Fail`inference-request-refused`;
  return harden({
    body,
    message: harden({ ...message, body: forwardBody }),
    inputBytes,
    maxOutputTokens:
      message.path === '/v1/messages' ? Number(body.max_tokens) : 0,
  });
};
harden(validateAnthropicInferenceRequest);

/**
 * @param {{ inputBytes: number, maxOutputTokens: number }} request
 */
export const conservativeTokenReservation = request =>
  // One token per input byte is deliberately conservative. The second copy
  // covers a worst-case cache-write charge.
  request.inputBytes * 2 + request.maxOutputTokens;
harden(conservativeTokenReservation);

/**
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {number} cacheReadTokens
 * @param {number} cacheWriteTokens
 * @param {any} price
 */
export const priceUsageMicros = (
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  price,
) => {
  if (price === undefined) return undefined;
  return Math.ceil(
    (inputTokens * price.inputPerMillion +
      outputTokens * price.outputPerMillion +
      cacheReadTokens * (price.cacheReadPerMillion ?? price.inputPerMillion) +
      cacheWriteTokens *
        (price.cacheWritePerMillion ?? price.inputPerMillion)) /
      1_000_000,
  );
};
harden(priceUsageMicros);
