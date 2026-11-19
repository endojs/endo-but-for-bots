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
 * Which list a backend reads, and its model id shape, are its kind's
 * (`kinds.js`: `readModels`, `acceptsModelId`; the readers live with their
 * kinds, `openrouter.js` and `anthropic.js`); a kind with no read is the
 * scripted double's one model. The owner, its timing and the bounded
 * readers are the catalogue core's (`catalog-core.js`), shared with M4's
 * pool catalogue.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { messageBytes } from '../../../../guest/lib/bounded.js';
import { texts, textOf } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  byTitleThenId,
  CatalogReadError,
  catalogModel,
  makeCatalogOwner,
  makeOwnerTable,
} from './catalog-core.js';
import { backendKinds, kindOf } from './kinds.js';

export {
  CATALOG_FRESH_MS,
  CATALOG_MAX_AGE_MS,
  CATALOG_READ_TIMEOUT_MS,
  CATALOG_RETRY_MS,
} from './catalog-core.js';

/** `messageBytes({ rows: [], state: 'ok', next: '' })`: the page's keys. */
const PAGE_OVERHEAD_BYTES = 15;

/** The id of the scripted test double's one model (M1a). */
export const SCRIPTED_MODEL_ID = 'scripted';

/**
 * A `shapes.ModelPage`.
 * @typedef {{ rows: any[], state: 'ok' | 'unavailable', next?: string, error?: string }} ModelPage
 */

/**
 * @typedef {object} CatalogRequest
 * @property {any} backend the Backend presence (the cache key)
 * @property {any} spec its `BackendSpec`
 * @property {() => Promise<string>} [readKey] the key through its grant
 * @property {(kind: string, fields?: Record<string, unknown>) => void} [log]
 */

/**
 * The efforts of a row: none for an API backend (M2).
 * @returns {{ reasoningEfforts: readonly string[], defaultReasoningEffort?: string }}
 */
const noEfforts = () => harden({ reasoningEfforts: harden([]) });

/**
 * One page of a sorted catalogue in R4-20 order for this request (M2 8.4):
 * the default row first on the default backend, `selectionId` `<label>:<id>`
 * elsewhere, a cursor naming no row ends the listing, at most
 * `modelPageRows` rows and one frame with room for the cursor. M4's pool
 * catalogue pages with it too, giving each row its efforts (`efforts`).
 * @template {import('./catalog-core.js').CatalogModel} T
 * @param {object} options
 * @param {any} options.backend
 * @param {any} options.spec
 * @param {readonly T[]} options.sorted
 * @param {Map<string, number>} options.indexOf
 * @param {any} [options.request]
 * @param {number} [options.maxBytes]
 * @param {(model: T) => { reasoningEfforts: readonly string[], defaultReasoningEffort?: string }} [options.efforts]
 * @returns {ModelPage}
 */
export const pageOf = ({
  backend,
  spec,
  sorted,
  indexOf,
  request = {},
  maxBytes = limits.frameBytes,
  efforts = noEfforts,
}) => {
  const isDefault =
    request.defaultBackend !== undefined && request.defaultBackend === backend;
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
      const { reasoningEfforts, defaultReasoningEffort } = efforts(model);
      const row = harden({
        backend,
        modelId: model.id,
        selectionId,
        title: model.title,
        default: model.id === configured,
        reasoningEfforts,
        ...(model.description === '' ? {} : { description: model.description }),
        ...(defaultReasoningEffort === undefined
          ? {}
          : { defaultReasoningEffort }),
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
harden(pageOf);

/** Backends whose catalogue one adapter incarnation keeps at once. */
const MAX_OWNERS = 4 * limits.maxBackends;

/**
 * @param {object} [options]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now] the cache ages by this clock; a
 *   read's timeout is its request's (the contract's `timers` option is
 *   accepted and not needed)
 * @param {readonly import('./kinds.js').BackendKind[]} [options.kinds] the
 *   kind table whose `readModels` and `acceptsModelId` apply (default:
 *   `backendKinds`)
 */
export const makeCatalog = ({
  fetch,
  now = () => Date.now(),
  kinds = backendKinds,
} = {}) => {
  /**
   * The cache per Backend presence. Held strongly (W2.9): with a WeakMap
   * the adapter's presence was collected between calls, a later call
   * arrived on a fresh presence of the same Backend, and every such call
   * read the catalogue again (m2-catalog: a creation and the next listing
   * 5.5 s apart read twice). Bounded: the oldest owner is dropped past
   * MAX_OWNERS, which costs only a read.
   * @type {ReturnType<typeof makeOwnerTable<ReturnType<typeof makeCatalogOwner<import('./catalog-core.js').CatalogModel>>>>}
   */
  const owners = makeOwnerTable(MAX_OWNERS);

  /**
   * The backend's owner, or undefined for a kind with no model read (the
   * scripted double).
   * @param {CatalogRequest} request
   */
  const ownerOf = ({ backend, spec, readKey, log = () => {} }) =>
    owners.ownerOf(backend, () => {
      const read = kindOf(spec, kinds)?.readModels?.({ spec, fetch });
      if (read === undefined) return undefined;
      return makeCatalogOwner({
        // R4-20: sorted once per read, by title then id.
        read: async key =>
          [...(await read(/** @type {string} */ (key)))].sort(byTitleThenId),
        readKey:
          readKey ??
          (async () => {
            throw new CatalogReadError('no key');
          }),
        now,
        log,
      });
    });

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
        sorted: observation.models,
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
      // R4-21: the kind's id shape (OpenRouter: `org/model`).
      const accepts = kindOf(spec, kinds)?.acceptsModelId;
      if (accepts !== undefined && !accepts(chosen))
        throw Error(texts.openRouterModelPrefix);
      const observation = await owner.admitting();
      if (observation === undefined) throw Error(texts.catalogUnavailable);
      const index = observation.indexOf.get(chosen);
      if (index === undefined) throw Error(textOf.unknownProviderModel(chosen));
      const model = observation.models[index];
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
