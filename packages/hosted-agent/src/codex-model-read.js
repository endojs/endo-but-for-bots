// @ts-check

import { Fail } from '@endo/errors';

import { boundedJson } from './bounded-json.js';
import { normalizeHostedModelDescriptor } from './hosted-backend.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const READ_TIMEOUT_MS = 20_000;

/**
 * Project the pinned Codex protocol's /models payload, not model/list's
 * bundled/cache fallback. Only picker metadata crosses this boundary; model
 * instructions and other provider fields are deliberately discarded.
 * @param {any} payload
 */
export const modelsFromCodexCatalog = payload => {
  (payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Array.isArray(payload.models)) ||
    Fail`Invalid Codex model catalog`;
  const rawModels = /** @type {any[]} */ (payload.models);
  rawModels.length <= 4096 || Fail`Codex model catalog exceeds entry bound`;
  const seen = new Set();
  const rows = rawModels.map(row => {
    (row && typeof row === 'object' && !Array.isArray(row)) ||
      Fail`Invalid Codex model catalog entry`;
    (typeof row.slug === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(row.slug) &&
      !seen.has(row.slug)) ||
      Fail`Invalid or duplicate Codex model identity`;
    seen.add(row.slug);
    ['list', 'hide', 'none'].includes(row.visibility) ||
      Fail`Invalid Codex model visibility`;
    // The pinned protocol defines priority as i32, not an arbitrary counter.
    const priority = /** @type {unknown} */ (row.priority);
    (typeof priority === 'number' &&
      Number.isInteger(priority) &&
      priority >= -2_147_483_648 &&
      priority <= 2_147_483_647) ||
      Fail`Invalid Codex model priority`;
    Array.isArray(row.supported_reasoning_levels) ||
      Fail`Invalid Codex model reasoning levels`;
    const rawEfforts = /** @type {any[]} */ (row.supported_reasoning_levels);
    rawEfforts.length <= 64 || Fail`Codex reasoning levels exceed entry bound`;
    const reasoningEfforts = rawEfforts.map((/** @type {any} */ option) => {
      (option &&
        typeof option === 'object' &&
        !Array.isArray(option) &&
        typeof option.effort === 'string' &&
        /^[a-z][a-z0-9_-]{0,63}$/.test(option.effort)) ||
        Fail`Invalid Codex model reasoning level`;
      return option.effort;
    });
    const model = normalizeHostedModelDescriptor({
      id: row.slug,
      title: row.display_name,
      description: row.description ?? '',
      default: false,
      defaultReasoningEffort: row.default_reasoning_level ?? null,
      reasoningEfforts,
    });
    return { model, visibility: row.visibility, priority };
  });
  // Stable ordering preserves provider order for equal priorities. In ChatGPT
  // mode supported_in_api is not a filter. The first visible model is default.
  const visible = rows
    .filter((/** @type {any} */ row) => row.visibility === 'list')
    .sort(
      (/** @type {any} */ a, /** @type {any} */ b) => a.priority - b.priority,
    );
  return harden(
    visible.map((/** @type {any} */ row, /** @type {number} */ index) =>
      harden({ ...row.model, default: index === 0 }),
    ),
  );
};
harden(modelsFromCodexCatalog);

/**
 * Host-only metadata read using an existing broker's renewing credential.
 * No sessions, inference, cache, new credential owner or runtime are created.
 * The caller supplies the version from its pinned runtime package metadata.
 * @param {object} powers
 * @param {() => Promise<{state: {accessToken: string, accountId: string}}>} powers.current
 * @param {string} powers.accountRef
 * @param {string} powers.clientVersion
 * @param {typeof globalThis.fetch} powers.fetch
 * @param {() => number} [powers.now]
 */
export const makeCodexModelRead = ({
  current,
  accountRef,
  clientVersion,
  fetch,
  now = Date.now,
}) => {
  (typeof current === 'function' && typeof fetch === 'function') ||
    Fail`Codex model reader requires credential and transport callbacks`;
  (typeof accountRef === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(accountRef)) ||
    Fail`Invalid Codex catalog account`;
  (typeof clientVersion === 'string' &&
    /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(
      clientVersion,
    )) ||
    Fail`Invalid pinned Codex client version`;
  const url = `https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion}`;
  return async () => {
    try {
      const { state } = await current();
      (state?.accountId === accountRef &&
        typeof state.accessToken === 'string' &&
        state.accessToken.length > 0 &&
        state.accessToken.length <= 32_768 &&
        !/\s/.test(state.accessToken)) ||
        Fail`Codex catalog credential account mismatch or invalid token`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${state.accessToken}`,
          'chatgpt-account-id': accountRef,
          originator: 'codex_cli_rs',
          'user-agent': `codex_cli_rs/${clientVersion} (Endo model catalog)`,
          accept: 'application/json',
        },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Fail`Codex catalog request refused`;
      }
      const models = modelsFromCodexCatalog(
        await boundedJson(response, MAX_BODY_BYTES, 'Codex catalog read'),
      );
      const observedAt = now();
      (Number.isFinite(observedAt) && observedAt >= 0) ||
        Fail`Invalid Codex catalog observation time`;
      return harden({ accountRef, observedAt, models });
    } catch (_error) {
      // Credential failures, network errors and parse errors may quote secrets
      // or upstream bodies. Do not attach them as a cause or interpolate them.
      throw Fail`Codex model catalog unavailable`;
    }
  };
};
harden(makeCodexModelRead);
