// @ts-check
/**
 * The model catalogue (M2 W2.2; `designs/m2-interfaces.md` 8.4; spec R4-17,
 * R4-20, R4-21, R4-22, R4-33, R4-104).
 *
 * Per backend (a `Backend` presence of the manager vat), the provider's
 * model list read with the backend's key through its grant (`readKey`,
 * W2.3), held in this adapter incarnation only (R4-67: a restart reads the
 * provider again) and cached per R4-104: an observation is fresh for 15
 * minutes, usable for 24 hours, and a failed read is not repeated for 60
 * seconds. Reads are single-flight: a read in flight answers everybody who
 * asks meanwhile (hosted-agent `model-catalog.js`).
 *
 * - `listModels` answers one page of rows (R4-20: default first, then title
 *   ignoring case, then id), or `{ rows: [], state: 'unavailable', error }`
 *   when nothing usable was observed (R4-17). A page holds at most
 *   `modelPageRows` rows and fits `frameBytes`; its cursor is the last
 *   row's selection id.
 * - `resolveModel` checks a model for a creation (R4-21): OpenRouter ids
 *   need the organisation prefix; the model must be in the current
 *   catalogue. The answer (`ResolvedModel`) is what the session stores at
 *   creation and keeps (R4-22): the model id, the catalogue's context
 *   length (R4-33) and the backend spec's output limit (R4-92).
 *
 * Readers (`readOpenRouterModels`, `readAnthropicModels`) are ported from
 * hosted-agent `openrouter-model-read.js` and `anthropic-model-read.js`:
 * validated and bounded, and failing closed: any defect fails the whole
 * read with a fixed message; a non-2xx body is never read, and no provider
 * text other than model titles and descriptions (display data) is kept.
 *
 * Node only (adapter).
 */
import { Buffer } from 'node:buffer';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { messageBytes } from '../../../../guest/lib/bounded.js';
import { texts, textOf } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { discardBody, getJson } from './http.js';

/** R4-104: an observation counts as current this long. */
export const CATALOG_FRESH_MS = 15 * 60_000;
/** R4-104: past this age an observation admits and lists nothing. */
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
/** R4-104: after a failed read, the provider is not asked again this long. */
export const CATALOG_RETRY_MS = 60_000;
/** One catalogue read (hosted-agent: 20 s). */
export const CATALOG_READ_TIMEOUT_MS = 20_000;

// Local resource bounds (hosted-agent), not claims about any provider.
const MAX_MODELS = 4096;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const ANTHROPIC_PAGES = 16;
const ANTHROPIC_PAGE_LIMIT = 1000;
const ANTHROPIC_VERSION = '2023-06-01';

/** OpenRouter's API base (as `openrouter.js`). */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** The Anthropic API's origin (a spec's `baseUrl` replaces it). */
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** `messageBytes({ rows: [], state: 'ok', next: '' })`: the page's keys. */
const PAGE_OVERHEAD_BYTES = 15;

/** The id of the scripted test double's one model (M1a). */
export const SCRIPTED_MODEL_ID = 'scripted';

/**
 * A read failure: the message is fixed and names no URL, key or body.
 */
export class CatalogReadError extends Error {
  /** @param {string} what */
  constructor(what) {
    super(`model catalogue read failed: ${what}`);
  }
}
harden(CatalogReadError);

/**
 * A `shapes.ModelPage`.
 * @typedef {{ rows: any[], state: 'ok' | 'unavailable', next?: string, error?: string }} ModelPage
 */

/**
 * @typedef {object} CatalogModel
 * @property {string} id
 * @property {string} title cut to `labelUnits`
 * @property {string} description cut to `modelDescriptionUnits`
 * @property {number} [contextLength]
 * @property {number} [maxOutputTokens]
 */

/** @param {string} what */
const fail = what => {
  throw new CatalogReadError(what);
};

/**
 * The first `units` UTF-16 units of `text`, never ending inside a pair.
 * @param {string} text
 * @param {number} units
 */
export const cutUnits = (text, units) => {
  if (text.length <= units) return text;
  let end = units;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
};
harden(cutUnits);

/** Printable ASCII, no space (hosted-agent's identifier rule). */
const IDENTIFIER = /^[\x21-\x7e]+$/;

/**
 * @param {unknown} value
 * @param {number} limit
 */
const textField = (value, limit) => {
  if (typeof value !== 'string' || value.length > limit) fail('model text');
  return /** @type {string} */ (value);
};

/** @param {unknown} value */
const identifier = value => {
  const result = textField(value, 256);
  if (!IDENTIFIER.test(result)) fail('model identifier');
  return result;
};

/** @param {unknown} value */
const identifiers = value => {
  if (!Array.isArray(value) || value.length > 64) fail('model capabilities');
  const result = /** @type {unknown[]} */ (value).map(identifier);
  if (new Set(result).size !== result.length) fail('model capabilities');
  return result;
};

/**
 * A positive uint32 token count, or undefined when absent.
 * @param {unknown} value
 */
const tokenCount = value => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 0xffff_ffff
  )
    fail('model token count');
  return /** @type {number} */ (value);
};

/**
 * @param {string} id
 * @param {string} title
 * @param {string} description
 * @param {number | undefined} contextLength
 * @param {number | undefined} maxOutputTokens
 * @returns {CatalogModel}
 */
const catalogModel = (id, title, description, contextLength, maxOutputTokens) =>
  harden({
    id,
    title: cutUnits(title === '' ? id : title, limits.labelUnits),
    description: cutUnits(description, limits.modelDescriptionUnits),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });

/**
 * The JSON of a 2xx body, at most `maxBytes`, decoded as fatal UTF-8.
 * @param {Response} response
 * @param {number} maxBytes
 */
const boundedJson = async (response, maxBytes) => {
  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  if (response.body !== null) {
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
      /** @type {unknown} */ (response.body)
    )) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        discardBody(response);
        fail('body over its bound');
      }
      parts.push(chunk);
    }
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(parts),
    );
  } catch {
    return fail('body is not UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail('body is not JSON');
  }
};

/**
 * One GET, its 2xx body as JSON; anything else fails with a fixed text.
 * @param {object} options
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {typeof globalThis.fetch | undefined} options.fetch
 * @param {number} options.timeoutMs
 * @param {number} options.maxBytes
 */
const readJson = async ({ url, headers, fetch, timeoutMs, maxBytes }) => {
  /** @type {Response} */
  let response;
  try {
    response = await getJson({
      url,
      headers: { accept: 'application/json', ...headers },
      timeoutMs,
      ...(fetch === undefined ? {} : { fetch }),
    });
  } catch {
    return fail('no response');
  }
  if (!response.ok) {
    // R4-79: a refusal's body is never read.
    discardBody(response);
    return fail(`HTTP ${response.status}`);
  }
  try {
    return await boundedJson(response, maxBytes);
  } catch (error) {
    if (error instanceof CatalogReadError) throw error;
    return fail('body unreadable');
  }
};

/**
 * One OpenRouter model, validated (hosted-agent `normalizeModel`), or
 * undefined when it cannot serve the harness (no text in and out, or no
 * tool use: `modelsFromOpenRouterCatalog`).
 * @param {any} model
 * @returns {CatalogModel | undefined}
 */
export const openRouterModel = model => {
  if (!model || typeof model !== 'object' || Array.isArray(model))
    fail('model entry');
  const id = identifier(model.id);
  const title = textField(model.name, 1024);
  const description = textField(model.description ?? '', 16_384);
  const contextLength = tokenCount(model.context_length);
  if (
    model.top_provider != null &&
    (typeof model.top_provider !== 'object' ||
      Array.isArray(model.top_provider))
  )
    fail('model provider metadata');
  const maxOutputTokens = tokenCount(model.top_provider?.max_completion_tokens);
  const inputs = identifiers(model.architecture?.input_modalities);
  const outputs = identifiers(model.architecture?.output_modalities);
  const parameters = identifiers(model.supported_parameters);
  if (
    !inputs.includes('text') ||
    !outputs.includes('text') ||
    !parameters.includes('tools')
  )
    return undefined;
  return catalogModel(id, title, description, contextLength, maxOutputTokens);
};
harden(openRouterModel);

/**
 * An OpenRouter catalogue (`GET <baseUrl>/models`).
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.key
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<CatalogModel[]>}
 */
export const readOpenRouterModels = async ({
  baseUrl,
  key,
  fetch,
  timeoutMs = CATALOG_READ_TIMEOUT_MS,
}) => {
  const payload = await readJson({
    url: `${baseUrl}/models`,
    headers: { authorization: `Bearer ${key}` },
    fetch,
    timeoutMs,
    maxBytes: MAX_BODY_BYTES,
  });
  if (
    !Array.isArray(payload?.data) ||
    Number(payload.data.length) > MAX_MODELS ||
    payload.links?.next != null ||
    (payload.total_count !== undefined &&
      payload.total_count !== Number(payload.data.length))
  )
    fail('catalogue shape');
  /** @type {CatalogModel[]} */
  const models = [];
  const seen = new Set();
  for (const entry of payload.data) {
    const model = openRouterModel(entry);
    if (model !== undefined) {
      if (seen.has(model.id)) fail('duplicate model');
      seen.add(model.id);
      models.push(model);
    }
  }
  return harden(models);
};
harden(readOpenRouterModels);

/** Anthropic model ids (hosted-agent `anthropic-model-read.js`). */
const ANTHROPIC_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * One page of an Anthropic catalogue, validated.
 * @param {any} payload
 * @returns {{ models: CatalogModel[], next: string | undefined }}
 */
export const anthropicPage = payload => {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Array.isArray(payload.data) ||
    Number(payload.data.length) > MAX_MODELS ||
    typeof payload.has_more !== 'boolean' ||
    (payload.last_id != null && typeof payload.last_id !== 'string')
  )
    fail('catalogue shape');
  const models = /** @type {any[]} */ (payload.data).map(row => {
    if (
      !row ||
      typeof row !== 'object' ||
      row.type !== 'model' ||
      typeof row.id !== 'string' ||
      !ANTHROPIC_MODEL_ID.test(row.id) ||
      typeof row.display_name !== 'string' ||
      row.display_name === '' ||
      Number(row.display_name.length) > 1024
    )
      fail('model entry');
    return catalogModel(row.id, row.display_name, '', undefined, undefined);
  });
  let next;
  if (payload.has_more) {
    if (
      typeof payload.last_id !== 'string' ||
      !ANTHROPIC_MODEL_ID.test(payload.last_id)
    )
      fail('catalogue page');
    next = /** @type {string} */ (payload.last_id);
  }
  return harden({ models, next });
};
harden(anthropicPage);

/**
 * An Anthropic API catalogue (`GET <baseUrl>/v1/models`, paged).
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.key
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<CatalogModel[]>}
 */
export const readAnthropicModels = async ({
  baseUrl,
  key,
  fetch,
  timeoutMs = CATALOG_READ_TIMEOUT_MS,
}) => {
  /** @type {CatalogModel[]} */
  const models = [];
  /** @type {string | undefined} */
  let after;
  for (let page = 0; page < ANTHROPIC_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: `${ANTHROPIC_PAGE_LIMIT}` });
    if (after !== undefined) query.set('after_id', after);
    // eslint-disable-next-line no-await-in-loop
    const payload = await readJson({
      url: `${baseUrl}/v1/models?${query}`,
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      fetch,
      timeoutMs,
      maxBytes: MAX_BODY_BYTES,
    });
    const { models: more, next } = anthropicPage(payload);
    models.push(...more);
    if (models.length > MAX_MODELS) fail('catalogue over its bound');
    if (next === undefined) {
      if (new Set(models.map(model => model.id)).size !== models.length)
        fail('duplicate model');
      return harden(models);
    }
    after = next;
  }
  return fail('catalogue over its page bound');
};
harden(readAnthropicModels);

/**
 * The read for a backend spec, or undefined for the scripted double.
 * @param {any} spec
 * @param {typeof globalThis.fetch | undefined} fetch
 * @returns {((key: string) => Promise<CatalogModel[]>) | undefined}
 */
const readerFor = (spec, fetch) => {
  const trimmed = (/** @type {string} */ url) => url.replace(/\/+$/, '');
  if (spec.kind === 'openrouter') {
    const baseUrl = trimmed(String(spec.baseUrl ?? OPENROUTER_BASE_URL));
    return key => readOpenRouterModels({ baseUrl, key, fetch });
  }
  if (spec.kind === 'anthropic') {
    const baseUrl = trimmed(String(spec.baseUrl ?? ANTHROPIC_BASE_URL));
    return key => readAnthropicModels({ baseUrl, key, fetch });
  }
  return undefined;
};

/**
 * Sort order of R4-20 after the default row: title ignoring case, then id.
 * @param {CatalogModel} a
 * @param {CatalogModel} b
 */
const byTitleThenId = (a, b) => {
  const ta = a.title.toLowerCase();
  const tb = b.title.toLowerCase();
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
};

/**
 * @typedef {object} Observation
 * @property {number} readAt this adapter's clock when the read completed
 * @property {CatalogModel[]} sorted by title then id (R4-20)
 * @property {Map<string, number>} indexOf model id -> position in `sorted`
 */

/**
 * One backend's catalogue owner (hosted-agent `makeModelCatalogOwner`):
 * failure is a state, never an error, and never carries a cause.
 *
 * @param {object} options
 * @param {(key: string) => Promise<CatalogModel[]>} options.read
 * @param {() => Promise<string>} options.readKey
 * @param {() => number} options.now
 * @param {(kind: string, fields?: Record<string, unknown>) => void} options.log
 */
const makeOwner = ({ read, readKey, now, log }) => {
  /** @type {Observation | undefined} */
  let observation;
  let failed = false;
  /** @type {number | undefined} */
  let failedAt;
  /** @type {string | undefined} the last failure logged (once per message) */
  let lastLogged;
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
        let key;
        try {
          key = await readKey();
        } catch {
          // The key path's own text may name a code; it is not kept.
          throw new CatalogReadError('key unreadable');
        }
        if (typeof key !== 'string' || key.trim() === '')
          throw new CatalogReadError('key unreadable');
        const models = await read(key);
        const sorted = [...models].sort(byTitleThenId);
        observation = {
          readAt: now(),
          sorted,
          indexOf: new Map(sorted.map((model, index) => [model.id, index])),
        };
        failed = false;
        failedAt = undefined;
        lastLogged = undefined;
        log('catalog-read', { models: sorted.length });
      } catch (error) {
        failed = true;
        failedAt = now();
        counters.failures += 1;
        // Fixed texts only (CatalogReadError); anything else is unnamed.
        const message =
          error instanceof CatalogReadError
            ? error.message
            : 'model catalogue read failed';
        if (message !== lastLogged) {
          lastLogged = message;
          log('catalog-failed', { message });
        }
      }
    })().finally(() => {
      if (refreshing === attempt) refreshing = undefined;
    });
    refreshing = attempt;
    return attempt;
  };

  return harden({
    /**
     * For a listing: read again when due, then answer what is usable.
     * @returns {Promise<Observation | undefined>}
     */
    snapshot: async () => {
      if (refreshing !== undefined || due()) await refresh();
      return usable() ? observation : undefined;
    },
    /**
     * For a creation: answer from a usable observation at once (reading
     * again in the background when due); wait only when nothing is usable.
     * @returns {Promise<Observation | undefined>}
     */
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
 * @typedef {object} CatalogRequest
 * @property {any} backend the Backend presence (the cache key)
 * @property {any} spec its `BackendSpec`
 * @property {() => Promise<string>} [readKey] the key through its grant
 * @property {(kind: string, fields?: Record<string, unknown>) => void} [log]
 */

/**
 * @param {object} [options]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now] the cache ages by this clock; a
 *   read's timeout is its request's (the contract's `timers` option is
 *   accepted and not needed)
 */
export const makeCatalog = ({ fetch, now = () => Date.now() } = {}) => {
  /** @type {WeakMap<any, ReturnType<typeof makeOwner>>} */
  const owners = new WeakMap();

  /**
   * @param {CatalogRequest} request
   * @returns {ReturnType<typeof makeOwner> | undefined}
   */
  const ownerOf = ({ backend, spec, readKey, log = () => {} }) => {
    const known = owners.get(backend);
    if (known !== undefined) return known;
    const read = readerFor(spec, fetch);
    if (read === undefined) return undefined;
    const owner = makeOwner({
      read,
      readKey:
        readKey ??
        (async () => {
          throw new CatalogReadError('no key');
        }),
      now,
      log,
    });
    owners.set(backend, owner);
    return owner;
  };

  /**
   * The rows of an observation in R4-20 order for this request.
   * @param {object} options
   * @param {any} options.backend
   * @param {any} options.spec
   * @param {CatalogModel[]} options.sorted
   * @param {Map<string, number>} options.indexOf
   * @param {any} [options.request]
   * @param {number} [options.maxBytes]
   * @returns {ModelPage}
   */
  const pageOf = ({
    backend,
    spec,
    sorted,
    indexOf,
    request = {},
    maxBytes = limits.frameBytes,
  }) => {
    const isDefault =
      request.defaultBackend !== undefined &&
      request.defaultBackend === backend;
    const configured = isDefault
      ? (request.defaultModelId ?? spec.modelId)
      : undefined;
    const prefix = `${spec.label}:`;
    /** @param {string} id */
    const selectionOf = id => (isDefault ? id : `${prefix}${id}`);
    const defaultIndex =
      configured === undefined ? undefined : indexOf.get(configured);
    // R4-20: the default row first, then title ignoring case, then id.
    /** @param {number} position */
    const modelAt = position => {
      if (defaultIndex === undefined) return sorted[position];
      if (position === 0) return sorted[defaultIndex];
      return sorted[position <= defaultIndex ? position - 1 : position];
    };
    /** @param {string} id */
    const positionOf = id => {
      const index = indexOf.get(id);
      if (index === undefined) return undefined;
      if (defaultIndex === undefined) return index;
      if (index === defaultIndex) return 0;
      return index < defaultIndex ? index + 1 : index;
    };
    let start = 0;
    if (request.after !== undefined) {
      const after = String(request.after);
      let id;
      if (isDefault) id = after;
      else if (after.startsWith(prefix)) id = after.slice(prefix.length);
      const position = id === undefined ? undefined : positionOf(id);
      // A cursor that names no row of this catalogue ends the listing.
      if (position === undefined) return harden({ rows: [], state: 'ok' });
      start = position + 1;
    }
    const limit = Math.min(
      request.limit ?? limits.modelPageRows,
      limits.modelPageRows,
    );
    /** @type {any[]} */
    const rows = [];
    let position = start;
    let more = false;
    let total = 0;
    for (; position < sorted.length; position += 1) {
      const model = modelAt(position);
      const selectionId = selectionOf(model.id);
      // A model whose id or selection id is over its bound is left out.
      const fits =
        model.id.length <= limits.modelIdUnits &&
        selectionId.length <= limits.modelCursorUnits;
      if (fits) {
        if (rows.length >= limit) {
          more = true;
          break;
        }
        const row = harden({
          backend,
          modelId: model.id,
          selectionId,
          title: model.title,
          default: model.id === configured,
          reasoningEfforts: harden([]),
          ...(model.description === ''
            ? {}
            : { description: model.description }),
          ...(model.contextLength === undefined
            ? {}
            : { contextLength: model.contextLength }),
          ...(model.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: model.maxOutputTokens }),
        });
        // The page must fit one frame (the contract measure) with room for
        // its cursor, which is at most this row's selection id.
        const bytes = messageBytes(row);
        if (
          rows.length > 0 &&
          PAGE_OVERHEAD_BYTES + total + bytes + messageBytes(selectionId) >
            maxBytes
        ) {
          more = true;
          break;
        }
        total += bytes;
        rows.push(row);
      }
    }
    /** @type {ModelPage} */
    const page = {
      rows: harden(rows),
      state: 'ok',
      ...(more && rows.length > 0
        ? { next: rows[rows.length - 1].selectionId }
        : {}),
    };
    return harden(page);
  };

  /** A scripted backend's catalogue: its one model. */
  const scriptedModels = harden([
    catalogModel(SCRIPTED_MODEL_ID, 'Scripted', '', undefined, undefined),
  ]);
  const scriptedIndex = new Map([[SCRIPTED_MODEL_ID, 0]]);

  /** @type {ModelPage} */
  const unavailable = harden({
    rows: harden([]),
    state: 'unavailable',
    error: texts.catalogUnavailable,
  });

  return harden({
    /**
     * One page of the backend's catalogue (R4-17, R4-20).
     * @param {CatalogRequest & { request?: any, maxBytes?: number }} options
     * @returns {Promise<ModelPage>}
     */
    listModels: async options => {
      const { backend, spec, request, maxBytes } = options;
      const owner = ownerOf(options);
      if (owner === undefined)
        return pageOf({
          backend,
          spec,
          sorted: scriptedModels,
          indexOf: scriptedIndex,
          request,
          maxBytes,
        });
      const observation = await owner.snapshot();
      if (observation === undefined) return unavailable;
      return pageOf({
        backend,
        spec,
        sorted: observation.sorted,
        indexOf: observation.indexOf,
        request,
        maxBytes,
      });
    },
    /**
     * Check a creation's model (R4-21) and answer what it stores (R4-22).
     * @param {CatalogRequest & { modelId?: string, defaults?: { modelId?: string } }} options
     */
    resolveModel: async options => {
      const { spec, modelId, defaults } = options;
      const chosen = modelId ?? defaults?.modelId ?? spec.modelId;
      const limit =
        spec.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: spec.maxOutputTokens };
      const owner = ownerOf(options);
      if (owner === undefined)
        return harden({ modelId: chosen ?? SCRIPTED_MODEL_ID, ...limit });
      if (chosen === undefined || chosen === '')
        throw Error(texts.modelRequired);
      // R4-21: `org/model`, both parts present.
      if (spec.kind === 'openrouter' && !/^[^/\s]+\/\S+$/.test(chosen))
        throw Error(texts.openRouterModelPrefix);
      const observation = await owner.admitting();
      if (observation === undefined) throw Error(texts.catalogUnavailable);
      const index = observation.indexOf.get(chosen);
      if (index === undefined) throw Error(textOf.unknownProviderModel(chosen));
      const model = observation.sorted[index];
      return harden({
        modelId: chosen,
        ...(model.contextLength === undefined
          ? {}
          : { contextLength: model.contextLength }),
        ...limit,
      });
    },
    /**
     * Reads and failures of one backend's owner (tests, perf).
     * @param {any} backend
     */
    stats: backend => owners.get(backend)?.stats(),
  });
};
harden(makeCatalog);
