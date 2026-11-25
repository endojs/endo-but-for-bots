// @ts-check
/**
 * The catalogue core (harness review HR-SYN-17; M2 W2.2 `designs/m2-
 * interfaces.md` 8.4 and M4 W4.3 `m4-interfaces.md` 5.4; R4-104): what the
 * model catalogue (`catalog.js`, an owner per Backend) and the pool
 * catalogue (`subscriptions/catalog.js`, an owner per member) share.
 *
 * - `makeCatalogOwner({ read, readKey?, now, log? })`: one cached model
 *   list (hosted-agent `makeModelCatalogOwner`). An observation is fresh
 *   for 15 minutes and usable for 24 hours; a failed read is not repeated
 *   for 60 seconds; reads are single-flight. Failure is a state, never an
 *   error, and never carries a cause. With `readKey` the key is read and
 *   checked first (its own text is never kept) and handed to `read`.
 * - `makeOwnerTable(maxOwners)`: owners held strongly per presence, the
 *   oldest dropped past `maxOwners` (which costs only a read).
 * - The bounded readers both catalogues read their lists with: `readJson`
 *   (one GET, its 2xx body at most `maxBytes`, failing closed with a fixed
 *   `CatalogReadError`) and the row helpers (`catalogModel`, `cutUnits`,
 *   `tokenCount`, `byTitleThenId`).
 *
 * Each catalogue keeps its own bounds as parameters: the body bound
 * (`CATALOG_BODY_BYTES`, 16 MB, for the API catalogues; 8 MB for the pool
 * catalogue) and its owner count.
 *
 * Node only (adapter).
 */
import { Buffer } from 'node:buffer';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
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
/** Models one catalogue read may list. */
export const CATALOG_MAX_MODELS = 4096;
/** The API catalogues' body bound (the pool catalogue keeps its own). */
export const CATALOG_BODY_BYTES = 16 * 1024 * 1024;

/**
 * A read failure: the message is fixed and names no URL, key or body. Its
 * `code` is fixed too: `UNREACHABLE` (no response), `REJECTED` (HTTP 401
 * or 403), else `READ_FAILED`; `status` the HTTP status of a refusal.
 */
export class CatalogReadError extends Error {
  /**
   * @param {string} what
   * @param {{ code?: string, status?: number }} [cause]
   */
  constructor(what, { code = 'READ_FAILED', status } = {}) {
    super(`model catalogue read failed: ${what}`);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
harden(CatalogReadError);

/**
 * Fail a read with a fixed text.
 * @param {string} what
 * @param {{ code?: string, status?: number }} [cause]
 * @returns {never}
 */
export const catalogFail = (what, cause) => {
  throw new CatalogReadError(what, cause);
};
harden(catalogFail);

/**
 * Whether a value is an HTTP status (100 to 599).
 * @param {unknown} value
 * @returns {value is number}
 */
export const isHttpStatus = value =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 100 &&
  value <= 599;
harden(isHttpStatus);

/** A failure code: a fixed upper-case word, never a message. */
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * A read failure as a code, an HTTP status at most, and its time: a
 * `CatalogReadError`'s, or the `code` of a coded failure (a credential
 * read's), else `READ_FAILED`. Never a message.
 * @param {unknown} error
 * @param {number} atMs
 * @returns {CatalogFailure}
 */
export const catalogFailureOf = (error, atMs) => {
  const { code, status } = /** @type {any} */ (
    error !== null && typeof error === 'object' ? error : {}
  );
  return harden({
    code:
      typeof code === 'string' && FAILURE_CODE.test(code)
        ? code
        : 'READ_FAILED',
    ...(isHttpStatus(status) ? { status } : {}),
    atMs,
  });
};
harden(catalogFailureOf);

/**
 * @typedef {object} CatalogFailure
 * @property {string} code
 * @property {number} [status]
 * @property {number} atMs
 */

/**
 * @typedef {object} CatalogModel
 * @property {string} id
 * @property {string} title cut to `labelUnits`
 * @property {string} description cut to `modelDescriptionUnits`
 * @property {number} [contextLength]
 * @property {number} [maxOutputTokens]
 */

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

/**
 * A positive uint32 token count, or undefined when absent.
 * @param {unknown} value
 */
export const tokenCount = value => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 0xffff_ffff
  )
    catalogFail('model token count');
  return /** @type {number} */ (value);
};
harden(tokenCount);

/**
 * @param {string} id
 * @param {string} title
 * @param {string} description
 * @param {number | undefined} contextLength
 * @param {number | undefined} maxOutputTokens
 * @returns {CatalogModel}
 */
export const catalogModel = (
  id,
  title,
  description,
  contextLength,
  maxOutputTokens,
) =>
  harden({
    id,
    title: cutUnits(title === '' ? id : title, limits.labelUnits),
    description: cutUnits(description, limits.modelDescriptionUnits),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
harden(catalogModel);

/**
 * The JSON of a 2xx body, at most `maxBytes`, decoded as fatal UTF-8; a
 * failure is a `CatalogReadError` with a fixed text.
 * @param {Response} response
 * @param {number} maxBytes
 */
export const boundedJson = async (response, maxBytes) => {
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
        catalogFail('body over its bound');
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
    return catalogFail('body is not UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    return catalogFail('body is not JSON');
  }
};
harden(boundedJson);

/**
 * One GET, its 2xx body as JSON (at most `maxBytes`); anything else fails
 * with a fixed text (a `CatalogReadError`).
 * @param {object} options
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {typeof globalThis.fetch | undefined} options.fetch
 * @param {number} options.timeoutMs
 * @param {number} options.maxBytes
 */
export const readJson = async ({
  url,
  headers,
  fetch,
  timeoutMs,
  maxBytes,
}) => {
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
    return catalogFail('no response', { code: 'UNREACHABLE' });
  }
  if (!response.ok) {
    // R4-79: a refusal's body is never read.
    discardBody(response);
    const { status } = response;
    return catalogFail(`HTTP ${status}`, {
      code: status === 401 || status === 403 ? 'REJECTED' : 'READ_FAILED',
      status,
    });
  }
  try {
    return await boundedJson(response, maxBytes);
  } catch (error) {
    if (error instanceof CatalogReadError) throw error;
    return catalogFail('body unreadable');
  }
};
harden(readJson);

/**
 * Sort order of R4-20 after the default row: title ignoring case, then id.
 * @param {{ id: string, title: string }} a
 * @param {{ id: string, title: string }} b
 */
export const byTitleThenId = (a, b) => {
  const ta = a.title.toLowerCase();
  const tb = b.title.toLowerCase();
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
};
harden(byTitleThenId);

/**
 * @template {{ id: string }} T
 * @typedef {object} Observation
 * @property {number} readAt this adapter's clock when the read completed
 * @property {T[]} models as `read` answered them
 * @property {Map<string, number>} indexOf model id -> position in `models`
 */

/**
 * One cached model list (hosted-agent `makeModelCatalogOwner`): failure is
 * a state, never an error, and never carries a cause.
 *
 * @template {{ id: string }} T
 * @param {object} options
 * @param {(key?: string) => Promise<T[]>} options.read the list (with the
 *   key, when `readKey` is given)
 * @param {() => Promise<string>} [options.readKey] the key through its
 *   grant; a failure, or a key that is empty or over
 *   `providerTokenBytes`, fails the read as `key unreadable`
 * @param {() => number} options.now
 * @param {(kind: string, fields?: Record<string, unknown>) => void} [options.log]
 *   `catalog-read` with the model count after a read, `catalog-failed` with
 *   the fixed message after a failure (once per message)
 * @param {{ readAt: number, models: T[] }} [options.initial] a remembered
 *   observation (a restart): used while it is under 24 hours old, read
 *   again as any stale one
 * @param {(outcome: { ok: true, readAt: number, models: T[] } | ({ ok: false } & CatalogFailure)) => void} [options.onRead]
 *   told after each read: the models, or the failure's code, status and
 *   time (never a message)
 */
export const makeCatalogOwner = ({
  read,
  readKey,
  now,
  log = () => {},
  initial,
  onRead = () => {},
}) => {
  /** @type {Observation<T> | undefined} */
  let observation =
    initial === undefined
      ? undefined
      : {
          readAt: initial.readAt,
          models: initial.models,
          indexOf: new Map(
            initial.models.map((model, index) => [model.id, index]),
          ),
        };
  /** @type {CatalogFailure | undefined} the last failure, until a read succeeds */
  let failure;
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

  /** The key, checked (its own text is never kept). */
  const checkedKey = async () => {
    /** @type {unknown} */
    let key;
    try {
      key = await /** @type {() => Promise<string>} */ (readKey)();
    } catch {
      // The key path's own text may name a code; it is not kept.
      throw new CatalogReadError('key unreadable');
    }
    if (
      typeof key !== 'string' ||
      key.trim() === '' ||
      Buffer.byteLength(key) > limits.providerTokenBytes
    )
      throw new CatalogReadError('key unreadable');
    return key;
  };

  const refresh = () => {
    if (refreshing !== undefined) return refreshing;
    const attempt = (async () => {
      await null;
      counters.reads += 1;
      try {
        const models =
          readKey === undefined ? await read() : await read(await checkedKey());
        observation = {
          readAt: now(),
          models,
          indexOf: new Map(models.map((model, index) => [model.id, index])),
        };
        failed = false;
        failedAt = undefined;
        failure = undefined;
        lastLogged = undefined;
        log('catalog-read', { models: models.length });
        onRead(harden({ ok: true, readAt: observation.readAt, models }));
      } catch (error) {
        failed = true;
        failedAt = now();
        failure = catalogFailureOf(error, failedAt);
        counters.failures += 1;
        onRead(harden({ ok: false, ...failure }));
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
     * @returns {Promise<Observation<T> | undefined>}
     */
    snapshot: async () => {
      if (refreshing !== undefined || due()) await refresh();
      return usable() ? observation : undefined;
    },
    /**
     * For a creation: answer from a usable observation at once (reading
     * again in the background when due); wait only when nothing is usable.
     * @returns {Promise<Observation<T> | undefined>}
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
    /** The last read's failure (code, status, time), until a read succeeds. */
    failure: () => failure,
  });
};
harden(makeCatalogOwner);

/**
 * Owners held strongly per presence (W2.9: with a WeakMap the adapter's
 * presence was collected between calls and every call read again), the
 * oldest dropped past `maxOwners`, which costs only a read.
 * @template O
 * @param {number} maxOwners
 */
export const makeOwnerTable = maxOwners => {
  /** @type {Map<any, O>} */
  const owners = new Map();
  return harden({
    /** @param {any} key */
    get: key => owners.get(key),
    /**
     * The owner of `key`, made by `make` on first use; `make` may answer
     * undefined (nothing to cache), which is not kept.
     * @param {any} key
     * @param {() => O | undefined} make
     * @returns {O | undefined}
     */
    ownerOf: (key, make) => {
      const known = owners.get(key);
      if (known !== undefined) return known;
      const owner = make();
      if (owner === undefined) return undefined;
      if (owners.size >= maxOwners) {
        const [oldest] = owners.keys();
        owners.delete(oldest);
      }
      owners.set(key, owner);
      return owner;
    },
  });
};
harden(makeOwnerTable);
