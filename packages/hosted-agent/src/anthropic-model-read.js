// @ts-check

import { Fail } from '@endo/errors';

import { boundedJson } from './bounded-json.js';
import { normalizeHostedModelDescriptor } from './hosted-backend.js';

const MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
// Local resource bounds, not claims about the provider's model capacity.
const MAX_MODELS = 4096;
const MAX_PAGES = 16;
const PAGE_LIMIT = 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const READ_TIMEOUT_MS = 20_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BETA = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:,[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;

/**
 * Project one page of the provider's model list. Only picker metadata
 * crosses this boundary. The provider says nothing of reasoning effort: that
 * is the Claude Code runtime's knob, and the runtime adapter declares it.
 *
 * @param {any} payload
 * @returns {{ models: ReturnType<typeof normalizeHostedModelDescriptor>[], next: string | null }}
 */
export const modelsFromAnthropicPage = payload => {
  (payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Array.isArray(payload.data) &&
    Number(payload.data.length) <= MAX_MODELS &&
    typeof payload.has_more === 'boolean' &&
    (payload.last_id == null || typeof payload.last_id === 'string')) ||
    Fail`Invalid Anthropic model catalog`;
  const models = /** @type {any[]} */ (payload.data).map(row => {
    (row && typeof row === 'object' && !Array.isArray(row)) ||
      Fail`Invalid Anthropic model catalog entry`;
    const id = /** @type {unknown} */ (row.id);
    const title = /** @type {unknown} */ (row.display_name);
    (row.type === 'model' &&
      typeof id === 'string' &&
      MODEL_ID.test(id) &&
      typeof title === 'string' &&
      title !== '' &&
      title.length <= 1024) ||
      Fail`Invalid Anthropic model catalog entry`;
    return normalizeHostedModelDescriptor({
      id,
      title,
      description: '',
      default: false,
      defaultReasoningEffort: null,
      reasoningEfforts: [],
    });
  });
  const next =
    payload.has_more === true
      ? (typeof payload.last_id === 'string' &&
          MODEL_ID.test(payload.last_id) &&
          payload.last_id) ||
        Fail`Invalid Anthropic model catalog page`
      : null;
  return harden({ models, next });
};
harden(modelsFromAnthropicPage);

/**
 * Host-only, account-scoped catalog read over the broker's existing
 * credential. No conversation, inference, cache or credential owner is
 * created; the credential is asked for on each read and discarded with it.
 *
 * `readAuthorization` answers how this account authenticates: an API key
 * (sent as `x-api-key`) or a subscription's OAuth access token (a bearer
 * token, with the OAuth beta the Messages API requires of it).
 *
 * @param {object} powers
 * @param {() => Promise<{ header: 'x-api-key' | 'bearer', token: string }>} powers.readAuthorization
 * @param {typeof globalThis.fetch} powers.fetch
 * @param {string} [powers.anthropicBeta] Sent with a bearer token.
 * @param {() => number} [powers.now]
 */
export const makeAnthropicModelRead = ({
  readAuthorization,
  fetch,
  anthropicBeta,
  now = Date.now,
}) => {
  (typeof readAuthorization === 'function' && typeof fetch === 'function') ||
    Fail`Anthropic model reader requires credential and transport callbacks`;
  anthropicBeta === undefined ||
    (typeof anthropicBeta === 'string' && BETA.test(anthropicBeta)) ||
    Fail`Invalid Anthropic beta capabilities`;
  const read = async () => {
    const { header, token } = await readAuthorization();
    ((header === 'x-api-key' || header === 'bearer') &&
      typeof token === 'string' &&
      token.length > 0 &&
      token.length <= 32_768 &&
      !/\s/.test(token)) ||
      Fail`Invalid Anthropic credential`;
    /** @type {Record<string, string>} */
    const authorization =
      header === 'bearer'
        ? {
            authorization: `Bearer ${token}`,
            ...(anthropicBeta === undefined
              ? {}
              : { 'anthropic-beta': anthropicBeta }),
          }
        : { 'x-api-key': token };
    /** @type {ReturnType<typeof normalizeHostedModelDescriptor>[]} */
    const models = [];
    /** @type {string | null} */
    let after = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(MODELS_URL);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (after !== null) url.searchParams.set('after_id', after);
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url.href, {
        method: 'GET',
        headers: {
          ...authorization,
          'anthropic-version': ANTHROPIC_VERSION,
          accept: 'application/json',
        },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!response.ok) {
        // eslint-disable-next-line no-await-in-loop
        await response.body?.cancel();
        throw Fail`Anthropic model read refused`;
      }
      const { models: pageModels, next } = modelsFromAnthropicPage(
        // eslint-disable-next-line no-await-in-loop
        await boundedJson(response, MAX_BODY_BYTES, 'Anthropic model read'),
      );
      models.push(...pageModels);
      models.length <= MAX_MODELS ||
        Fail`Anthropic model catalog exceeds bound`;
      if (next === null) {
        new Set(models.map(model => model.id)).size === models.length ||
          Fail`Duplicate Anthropic model identifier`;
        const observedAt = now();
        (Number.isFinite(observedAt) && observedAt >= 0) ||
          Fail`Invalid Anthropic catalog observation time`;
        return harden({ observedAt, models: harden(models) });
      }
      after = next;
    }
    throw Fail`Anthropic model catalog exceeds page bound`;
  };
  return harden(async () => {
    try {
      return await read();
    } catch (_error) {
      // Even transport and credential-reader errors can contain secret text.
      throw Fail`Anthropic model discovery failed`;
    }
  });
};
harden(makeAnthropicModelRead);
