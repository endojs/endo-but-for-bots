// @ts-check
/**
 * The pool catalogue (M4 W4.3; `designs/m4-interfaces.md` 5.4; R4-17,
 * R4-18, R4-19, R4-20, R4-21, R4-22, R4-23, R4-104; open decision 13,
 * D-M4-5).
 *
 * The same request and answer shapes as M2's `makeCatalog`
 * (`providers/catalog.js`): `listModels({ backend, spec, request?,
 * maxBytes? })` answers a `ModelPage`, `resolveModel({ backend, spec,
 * modelId?, defaults? })` a `ResolvedModel`; the adapter routes pool specs
 * here (H-4 (g)). Plus `efforts({ backend, spec, modelId })`, the efforts a
 * creation may store (R4-23).
 *
 * Each active member's model list is read with that member's credential
 * (`readCredential(member)`, the audited read of W4.4/W4.6) and cached per
 * member presence with M2's timing (R4-104: fresh 15 min, never older than
 * 24 h, a failed read not repeated for 60 s; single-flight). A listing reads
 * the members whose observation is due, at once, and combines the usable
 * ones:
 *
 * - `codex-pool` (R4-18, Fae `src/subscription-models.js`
 *   `pooledSubscriptionModels`): the models of members whose observation is
 *   current or stale (usable); efforts in the Responses spelling (`ultra` is
 *   `max`, hosted-agent `codex-reasoning.js`); a model several members offer
 *   gets the intersection of their efforts, their default effort only when
 *   all agree, and the smallest context length and output limit (absent
 *   when one member does not say);
 * - `claude-pool` (R4-19): the union of the members' admitted model ids (the
 *   synthetic account `auto`: selection among members is the pool's, not
 *   the creator's), efforts from `claudeEfforts(model)`, no context length
 *   unless the pool spec sets `contextLength`; a creation stores the spec's
 *   `contextLength`, else `subscriptionDefaults.claudeContextLength`
 *   (D-M4-5: M8's compaction needs a window), and `maxOutputTokens` of the
 *   spec, else 16,384 (R4-92).
 *
 * A listing where no member has a usable observation answers `{ rows: [],
 * state: 'unavailable', error: texts.catalogUnavailable }` (R4-17). Rows
 * follow M2 8.4: R4-20 order, `selectionId` `<label>:<model>` unless the
 * pool is the factory's default backend, `default` only for the configured
 * model on the default backend, pages cut to `modelPageRows` and
 * `frameBytes`.
 *
 * Readers (ported from hosted-agent `anthropic-model-read.js` and
 * `codex-model-read.js`): validated and bounded, failing closed with a fixed
 * message; a refused answer's body is never read; no token, header value or
 * body reaches a log line, a failure or a record.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { texts, textOf } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
import { subscriptionLimits } from '../../../../guest/lib/subscription-limits.js';
import { subscriptionTexts } from '../../../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { subscriptionDefaults } from '../../../../config/subscription-defaults.js';
import { ANTHROPIC_VERSION } from '../providers/anthropic.js';
import {
  anthropicPage,
  byTitleThenId,
  CATALOG_FRESH_MS,
  CATALOG_MAX_AGE_MS,
  CATALOG_READ_TIMEOUT_MS,
  CATALOG_RETRY_MS,
  CatalogReadError,
  cutUnits,
  pageOf,
  readJson,
  tokenCount,
} from '../providers/catalog.js';
import { providerBaseUrl } from '../providers/http.js';
import {
  CLAUDE_BASE_URL,
  CLAUDE_OAUTH_BETA,
  claudeEfforts,
} from './messages.js';
import { CODEX_BASE_URL, CODEX_ORIGINATOR, codexEffort } from './responses.js';

/** The Codex model list route (hosted-agent `codex-model-read.js`). */
export const CODEX_MODELS_PATH = '/backend-api/codex/models';
/**
 * The client version the Codex model list is asked for (the reference pins
 * its CLI's; `codex-reasoning.js` names 0.152.0).
 */
export const CODEX_CLIENT_VERSION = '0.152.0';

// Local resource bounds (hosted-agent), not claims about any provider.
const MAX_MODELS = 4096;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ANTHROPIC_PAGES = 16;
const ANTHROPIC_PAGE_LIMIT = 1000;
const CODEX_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,63}$/;
/** Members whose observations one incarnation keeps at once. */
const MAX_OWNERS = 2 * subscriptionLimits.maxMembers;

/**
 * One model as a member's catalogue lists it.
 * @typedef {object} PoolModel
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {readonly string[]} reasoningEfforts
 * @property {string} [defaultReasoningEffort]
 * @property {number} [contextLength]
 * @property {number} [maxOutputTokens]
 */

/** @param {string} what */
const fail = what => {
  throw new CatalogReadError(what);
};

/**
 * One GET with the member's headers; its 2xx body as JSON (M2's bounded
 * reader, `providers/catalog.js`, with this catalogue's body bound).
 * @param {object} options
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {typeof globalThis.fetch | undefined} options.fetch
 */
const readMemberJson = ({ url, headers, fetch }) =>
  readJson({
    url,
    headers,
    fetch,
    timeoutMs: CATALOG_READ_TIMEOUT_MS,
    maxBytes: MAX_BODY_BYTES,
  });

/**
 * The Codex model list payload as models (hosted-agent
 * `modelsFromCodexCatalog`): listed rows only, by priority then provider
 * order; efforts as the catalogue names them (combined later).
 * @param {any} payload
 * @returns {PoolModel[]}
 */
export const codexModels = payload => {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Array.isArray(payload.models) ||
    Number(payload.models.length) > MAX_MODELS
  )
    fail('catalogue shape');
  const seen = new Set();
  /** @type {{ model: PoolModel, visibility: string, priority: number }[]} */
  const rows = /** @type {any[]} */ (payload.models).map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      fail('model entry');
    if (
      typeof row.slug !== 'string' ||
      !CODEX_SLUG.test(row.slug) ||
      seen.has(row.slug)
    )
      fail('model identifier');
    seen.add(row.slug);
    if (!['list', 'hide', 'none'].includes(row.visibility))
      fail('model visibility');
    const priority = row.priority;
    if (
      typeof priority !== 'number' ||
      !Number.isInteger(priority) ||
      priority < -2_147_483_648 ||
      priority > 2_147_483_647
    )
      fail('model priority');
    if (
      !Array.isArray(row.supported_reasoning_levels) ||
      Number(row.supported_reasoning_levels.length) > 64
    )
      fail('model efforts');
    const efforts = row.supported_reasoning_levels.map(
      (/** @type {any} */ option) => {
        if (
          !option ||
          typeof option !== 'object' ||
          typeof option.effort !== 'string' ||
          !EFFORT.test(option.effort)
        )
          fail('model effort');
        return /** @type {string} */ (option.effort);
      },
    );
    const title =
      typeof row.display_name === 'string' && row.display_name !== ''
        ? row.display_name
        : row.slug;
    const description =
      typeof row.description === 'string' ? row.description : '';
    const preferred =
      typeof row.default_reasoning_level === 'string'
        ? row.default_reasoning_level
        : undefined;
    const contextLength = tokenCount(row.context_window);
    /** @type {PoolModel} */
    const model = {
      id: row.slug,
      title: cutUnits(title, limits.labelUnits),
      description: cutUnits(description, limits.modelDescriptionUnits),
      reasoningEfforts: efforts,
      ...(preferred === undefined ? {} : { defaultReasoningEffort: preferred }),
      ...(contextLength === undefined ? {} : { contextLength }),
    };
    return { model, visibility: row.visibility, priority };
  });
  return rows
    .filter(row => row.visibility === 'list')
    .sort((a, b) => a.priority - b.priority)
    .map(row => row.model);
};
harden(codexModels);

/**
 * A member's Claude model list (`GET <baseUrl>/v1/models`, paged) with its
 * OAuth bearer.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.accessToken
 * @param {typeof globalThis.fetch} [options.fetch]
 * @returns {Promise<PoolModel[]>}
 */
export const readClaudeModels = async ({ baseUrl, accessToken, fetch }) => {
  /** @type {PoolModel[]} */
  const models = [];
  /** @type {string | undefined} */
  let after;
  for (let page = 0; page < ANTHROPIC_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: `${ANTHROPIC_PAGE_LIMIT}` });
    if (after !== undefined) query.set('after_id', after);
    // eslint-disable-next-line no-await-in-loop
    const payload = await readMemberJson({
      url: `${baseUrl}/v1/models?${query}`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      fetch,
    });
    const { models: more, next } = anthropicPage(payload);
    for (const model of more) {
      models.push({
        id: model.id,
        title: model.title,
        description: '',
        reasoningEfforts: claudeEfforts(model.id),
      });
    }
    if (models.length > MAX_MODELS) fail('catalogue over its bound');
    if (next === undefined) {
      if (new Set(models.map(model => model.id)).size !== models.length)
        fail('duplicate model');
      return models;
    }
    after = next;
  }
  return fail('catalogue over its page bound');
};
harden(readClaudeModels);

/**
 * A member's Codex model list with its OAuth bearer and account.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {import('./types.js').Credential} options.credential
 * @param {string} [options.clientVersion]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @returns {Promise<PoolModel[]>}
 */
export const readCodexModels = async ({
  baseUrl,
  credential,
  clientVersion = CODEX_CLIENT_VERSION,
  fetch,
}) => {
  const query = new URLSearchParams({ client_version: clientVersion });
  const payload = await readMemberJson({
    url: `${baseUrl}${CODEX_MODELS_PATH}?${query}`,
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      ...(typeof credential.accountId === 'string' &&
      /^[A-Za-z0-9_-]{1,256}$/.test(credential.accountId)
        ? { 'chatgpt-account-id': credential.accountId }
        : {}),
      originator: CODEX_ORIGINATOR,
    },
    fetch,
  });
  return codexModels(payload);
};
harden(readCodexModels);

/**
 * @typedef {object} Observation
 * @property {number} readAt
 * @property {PoolModel[]} models
 */

/**
 * One member's catalogue owner (M2 `makeOwner`'s rule: failure is a state,
 * never an error, and never carries a cause).
 * @param {object} options
 * @param {() => Promise<PoolModel[]>} options.read
 * @param {() => number} options.now
 */
const makeMemberOwner = ({ read, now }) => {
  /** @type {Observation | undefined} */
  let observation;
  let failed = false;
  /** @type {number | undefined} */
  let failedAt;
  /** @type {Promise<void> | undefined} */
  let refreshing;
  const counters = { reads: 0, failures: 0 };
  const age = () =>
    observation === undefined ? Infinity : now() - observation.readAt;
  const usable = () => age() < CATALOG_MAX_AGE_MS;
  const fresh = () => age() < CATALOG_FRESH_MS;
  const due = () =>
    (!fresh() || failed) &&
    (failedAt === undefined || now() - failedAt >= CATALOG_RETRY_MS);
  const refresh = () => {
    if (refreshing !== undefined) return refreshing;
    const attempt = (async () => {
      await null;
      counters.reads += 1;
      try {
        const models = await read();
        observation = { readAt: now(), models };
        failed = false;
        failedAt = undefined;
      } catch {
        failed = true;
        failedAt = now();
        counters.failures += 1;
      }
    })().finally(() => {
      if (refreshing === attempt) refreshing = undefined;
    });
    refreshing = attempt;
    return attempt;
  };
  return harden({
    /** For a listing: read again when due, then answer what is usable. */
    snapshot: async () => {
      if (refreshing !== undefined || due()) await refresh();
      return usable() ? observation : undefined;
    },
    /** For a creation: a usable observation at once, refreshed behind. */
    admitting: async () => {
      if (!usable()) {
        if (refreshing !== undefined || due()) await refresh();
      } else if (due()) {
        void refresh();
      }
      return usable() ? observation : undefined;
    },
    stats: () => harden({ ...counters, failed }),
  });
};

/**
 * Efforts a row may carry (the `ModelRow` bounds): known shape, at most
 * `maxEfforts`, each at most `effortUnits`.
 * @param {readonly string[]} efforts
 */
const rowEfforts = efforts =>
  harden(
    efforts
      .filter(effort => effort.length <= limits.effortUnits)
      .slice(0, limits.maxEfforts),
  );

/**
 * The codex pool's combined models (R4-18; Fae `pooledSubscriptionModels`),
 * members in declaration order.
 * @param {PoolModel[][]} lists
 * @returns {PoolModel[]}
 */
export const pooledCodexModels = lists => {
  /** @type {Map<string, PoolModel>} */
  const byId = new Map();
  for (const list of lists) {
    for (const raw of list) {
      const choices = [
        ...new Set(
          raw.reasoningEfforts
            .map(codexEffort)
            .filter(effort => effort !== undefined),
        ),
      ];
      const preferred = codexEffort(raw.defaultReasoningEffort);
      /** @type {PoolModel} */
      const model = {
        ...raw,
        reasoningEfforts: choices,
        ...(preferred !== undefined && choices.includes(preferred)
          ? { defaultReasoningEffort: preferred }
          : { defaultReasoningEffort: undefined }),
      };
      const previous = byId.get(model.id);
      if (previous === undefined) {
        byId.set(model.id, model);
      } else {
        const efforts = previous.reasoningEfforts.filter(effort =>
          choices.includes(effort),
        );
        const contextLength =
          previous.contextLength !== undefined &&
          model.contextLength !== undefined
            ? Math.min(previous.contextLength, model.contextLength)
            : undefined;
        const maxOutputTokens =
          previous.maxOutputTokens !== undefined &&
          model.maxOutputTokens !== undefined
            ? Math.min(previous.maxOutputTokens, model.maxOutputTokens)
            : undefined;
        byId.set(model.id, {
          ...previous,
          reasoningEfforts: efforts,
          defaultReasoningEffort:
            previous.defaultReasoningEffort !== undefined &&
            efforts.includes(previous.defaultReasoningEffort) &&
            previous.defaultReasoningEffort === model.defaultReasoningEffort
              ? previous.defaultReasoningEffort
              : undefined,
          contextLength,
          maxOutputTokens,
        });
      }
    }
  }
  return [...byId.values()];
};
harden(pooledCodexModels);

/**
 * The claude pool's combined models (R4-19): the union of the members'
 * admitted ids, the first member's title, efforts by model, and the spec's
 * context length only.
 * @param {PoolModel[][]} lists
 * @param {number | undefined} contextLength
 * @returns {PoolModel[]}
 */
export const pooledClaudeModels = (lists, contextLength) => {
  /** @type {Map<string, PoolModel>} */
  const byId = new Map();
  for (const list of lists) {
    for (const raw of list) {
      if (!byId.has(raw.id)) {
        byId.set(raw.id, {
          id: raw.id,
          title: raw.title,
          description: raw.description,
          reasoningEfforts: claudeEfforts(raw.id),
          ...(contextLength === undefined ? {} : { contextLength }),
        });
      }
    }
  }
  return [...byId.values()];
};
harden(pooledClaudeModels);

/**
 * @typedef {object} PoolCatalogRequest
 * @property {any} backend the pool's Backend presence
 * @property {any} spec its `PoolSpec`
 * @property {(kind: string, fields?: Record<string, unknown>) => void} [log]
 */

/**
 * @param {object} options
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {(member: import('./types.js').MemberEntry) => Promise<import('./types.js').Credential>} options.readCredential
 *   the member's credential (audited read); its failure is the member's
 *   read failure
 * @param {(backend: any, spec: any) => Promise<import('./types.js').MemberEntry[]>} options.members
 *   the pool's members in declaration order (`PoolStateBridge.load`)
 * @param {{ claudeContextLength: number, claudeMaxOutputTokens: number }} [options.settings]
 * @param {string} [options.clientVersion] the Codex model list's
 */
export const makePoolCatalog = ({
  fetch,
  now = () => Date.now(),
  readCredential,
  members,
  settings = subscriptionDefaults,
  clientVersion = CODEX_CLIENT_VERSION,
}) => {
  /**
   * Observations per member presence (a member read once serves every pool
   * it is in). Held strongly, oldest dropped past MAX_OWNERS (a read).
   * @type {Map<any, ReturnType<typeof makeMemberOwner>>}
   */
  const owners = new Map();

  /**
   * @param {import('./types.js').MemberEntry} entry
   * @param {any} spec
   */
  const ownerOf = (entry, spec) => {
    const known = owners.get(entry.member);
    if (known !== undefined) return known;
    /** @type {() => Promise<PoolModel[]>} */
    const read =
      entry.provider === 'claude'
        ? async () => {
            const credential = await readCredential(entry);
            return readClaudeModels({
              baseUrl: providerBaseUrl(spec.baseUrl, CLAUDE_BASE_URL),
              accessToken: credential.accessToken,
              ...(fetch === undefined ? {} : { fetch }),
            });
          }
        : async () => {
            const credential = await readCredential(entry);
            return readCodexModels({
              baseUrl: providerBaseUrl(spec.baseUrl, CODEX_BASE_URL),
              credential,
              clientVersion,
              ...(fetch === undefined ? {} : { fetch }),
            });
          };
    const owner = makeMemberOwner({ read, now });
    if (owners.size >= MAX_OWNERS) {
      const [oldest] = owners.keys();
      owners.delete(oldest);
    }
    owners.set(entry.member, owner);
    return owner;
  };

  /**
   * The pool's combined, sorted models, or undefined when no member has a
   * usable observation.
   * @param {PoolCatalogRequest} request
   * @param {'snapshot' | 'admitting'} how
   */
  const combined = async ({ backend, spec, log = () => {} }, how) => {
    const entries = (await members(backend, spec)).filter(
      entry => entry.state === 'active',
    );
    const observations = await Promise.all(
      entries.map(entry => ownerOf(entry, spec)[how]()),
    );
    /** @type {PoolModel[][]} */
    const lists = [];
    for (const observation of observations) {
      if (observation !== undefined) lists.push(observation.models);
    }
    if (lists.length < entries.length)
      log('catalog-failed', {
        members: entries.length,
        usable: lists.length,
      });
    if (lists.length === 0) return undefined;
    const models =
      spec.kind === 'codex-pool'
        ? pooledCodexModels(lists)
        : pooledClaudeModels(lists, spec.contextLength);
    const sorted = models.sort(byTitleThenId);
    return {
      sorted,
      indexOf: new Map(sorted.map((model, index) => [model.id, index])),
    };
  };

  /**
   * A row's efforts (the `ModelRow` bounds) and its default effort when it
   * is one of them.
   * @param {PoolModel} model
   */
  const effortsOf = model => {
    const efforts = rowEfforts(model.reasoningEfforts);
    return harden({
      reasoningEfforts: efforts,
      ...(model.defaultReasoningEffort !== undefined &&
      efforts.includes(model.defaultReasoningEffort)
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {}),
    });
  };

  /** @type {import('../providers/catalog.js').ModelPage} */
  const unavailable = harden({
    rows: harden([]),
    state: 'unavailable',
    error: texts.catalogUnavailable,
  });

  /**
   * The row of a creation's model (R4-21): the chosen id, its model.
   * @param {PoolCatalogRequest & { modelId?: string, defaults?: { modelId?: string } }} options
   */
  const admitted = async options => {
    const { spec, modelId, defaults } = options;
    const chosen = modelId ?? defaults?.modelId ?? spec.modelId;
    if (chosen === undefined || chosen === '')
      throw Error(subscriptionTexts.subscriptionModelRequired);
    const observation = await combined(options, 'admitting');
    if (observation === undefined) throw Error(texts.catalogUnavailable);
    const index = observation.indexOf.get(chosen);
    if (index === undefined) throw Error(textOf.unknownProviderModel(chosen));
    return { chosen, model: observation.sorted[index] };
  };

  return harden({
    /**
     * One page of the pool's catalogue (R4-17..R4-20).
     * @param {PoolCatalogRequest & { request?: any, maxBytes?: number }} options
     */
    listModels: async options => {
      const observation = await combined(options, 'snapshot');
      if (observation === undefined) return unavailable;
      return pageOf({
        backend: options.backend,
        spec: options.spec,
        sorted: observation.sorted,
        indexOf: observation.indexOf,
        ...(options.request === undefined ? {} : { request: options.request }),
        ...(options.maxBytes === undefined
          ? {}
          : { maxBytes: options.maxBytes }),
        efforts: effortsOf,
      });
    },
    /**
     * Check a creation's model and answer what it stores (R4-21, R4-22;
     * D-M4-5 for Claude's window).
     * @param {PoolCatalogRequest & { modelId?: string, defaults?: { modelId?: string } }} options
     */
    resolveModel: async options => {
      const { spec } = options;
      const { chosen, model } = await admitted(options);
      if (spec.kind === 'claude-pool') {
        return harden({
          modelId: chosen,
          contextLength: spec.contextLength ?? settings.claudeContextLength,
          maxOutputTokens:
            spec.maxOutputTokens ?? settings.claudeMaxOutputTokens,
        });
      }
      const maxOutputTokens = spec.maxOutputTokens ?? model.maxOutputTokens;
      return harden({
        modelId: chosen,
        ...(model.contextLength === undefined
          ? {}
          : { contextLength: model.contextLength }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      });
    },
    /**
     * The efforts a creation on this model may store (R4-23) and the
     * model's default one.
     * @param {PoolCatalogRequest & { modelId?: string }} options
     * @returns {Promise<{ reasoningEfforts: readonly string[], defaultReasoningEffort?: string }>}
     */
    efforts: async options => effortsOf((await admitted(options)).model),
    /**
     * Reads and failures of one member's catalogue (tests, perf).
     * @param {any} member the PoolMember presence
     */
    stats: member => owners.get(member)?.stats(),
  });
};
harden(makePoolCatalog);
