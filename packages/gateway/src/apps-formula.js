// @ts-check

/**
 * @file Formula-backed `@apps` NameHub for the gateway.
 *
 * Phase 1 of the Gateway package landed an in-memory `AppsNameHub`
 * exo (see `./vhost.js`) that maps a `Host`-header value to a
 * weblet formula identifier. This module promotes the same surface
 * to a formula-backed variant: bindings are persisted through a
 * host-supplied store and the in-memory view is hydrated from the
 * store on construction.
 *
 * The `@apps` special-formula convention is described in
 * `designs/familiar-bundled-agents.md`; the gateway's Feature 2
 * routing path is described in `designs/gateway-package.md` § Feature
 * 2. This module is the gateway-side glue between the in-memory
 * routing table and the daemon-side persistence; the daemon-side
 * formula store is the host-supplied power and is out of scope for
 * this package.
 *
 * The hub honors the same exo shape as `makeAppsNameHub`: when the
 * embedder supplies a `formulaStore`, `makeFormulaBackedAppsNameHub`
 * returns a drop-in replacement. The exo's contract (case-insensitive
 * names, first-bind-wins on collision, idempotent rebind to the same
 * id) carries forward unchanged; only the persistence behavior
 * changes.
 *
 * Design Decision (carried forward from prior phases): when the
 * formula store is unavailable, the gateway fails closed. A
 * `formulaStore` that throws on read is a startup error rather than
 * a silent fallback to in-memory, because a silent fallback would
 * mask a broken store and lose bindings on the next restart. This
 * is the same fail-closed posture Phase 5 took for relay policy
 * (see `designs/gateway-package.md` § Feature 5).
 *
 * Construction discipline: `makeFormulaBackedAppsNameHub` is
 * synchronous so it fits the existing `makeGateway` constructor
 * shape (which itself is sync to match the rest of the
 * `make({powers, config})` pattern in the corpus). The factory
 * kicks off a hydration promise that the exo's methods await on
 * each call; an awaitable `whenReady()` method exposes the same
 * promise for embedders and tests that want to surface a startup
 * failure deterministically.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';

import { normalizeVirtualHostName } from './vhost.js';

/** @import {
 *   AppsNameHub,
 *   VirtualHostEntry,
 *   WebletFormula,
 *   WebletBindingRecord,
 *   AppsFormulaStore,
 *   FormulaBackedAppsNameHub,
 * } from './types.d.ts' */

/**
 * Validate the shape of a `WebletFormula` returned by the formula
 * store (or supplied to the hub through some other channel). The
 * validator is conservative: missing optional fields are fine, but
 * unknown fields and malformed required fields are rejected.
 *
 * The validator does **not** confirm that `contentRoot` is a real
 * formula identifier; that check belongs to the daemon's formula
 * resolver. The gateway treats the identifier as an opaque string
 * during routing, matching the in-memory hub's approach.
 *
 * @param {unknown} candidate
 * @returns {WebletFormula}
 */
export const validateWebletFormula = candidate => {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate)
  ) {
    throw makeError(X`WebletFormula must be an object, got ${q(candidate)}`);
  }
  const obj = /** @type {Record<string, unknown>} */ (candidate);
  if (obj.type !== 'weblet') {
    throw makeError(X`WebletFormula.type must be 'weblet', got ${q(obj.type)}`);
  }
  if (typeof obj.contentRoot !== 'string' || obj.contentRoot === '') {
    throw makeError(
      X`WebletFormula.contentRoot must be a non-empty string, got ${q(obj.contentRoot)}`,
    );
  }
  if (obj.mimeTypes !== undefined) {
    if (
      obj.mimeTypes === null ||
      typeof obj.mimeTypes !== 'object' ||
      Array.isArray(obj.mimeTypes)
    ) {
      throw makeError(
        X`WebletFormula.mimeTypes must be an object, got ${q(obj.mimeTypes)}`,
      );
    }
    for (const [ext, mimeType] of Object.entries(obj.mimeTypes)) {
      if (typeof mimeType !== 'string' || mimeType === '') {
        throw makeError(
          X`WebletFormula.mimeTypes[${q(ext)}] must be a non-empty string, got ${q(mimeType)}`,
        );
      }
    }
  }
  if (obj.ssrHandler !== undefined) {
    if (typeof obj.ssrHandler !== 'string' || obj.ssrHandler === '') {
      throw makeError(
        X`WebletFormula.ssrHandler must be a non-empty string when present, got ${q(obj.ssrHandler)}`,
      );
    }
  }
  if (obj.virtualHosts !== undefined) {
    if (!Array.isArray(obj.virtualHosts)) {
      throw makeError(
        X`WebletFormula.virtualHosts must be an array, got ${q(obj.virtualHosts)}`,
      );
    }
    for (const host of obj.virtualHosts) {
      if (typeof host !== 'string' || host === '') {
        throw makeError(
          X`WebletFormula.virtualHosts entries must be non-empty strings, got ${q(host)}`,
        );
      }
    }
  }
  const result = /** @type {WebletFormula} */ (
    /** @type {unknown} */ ({
      type: 'weblet',
      contentRoot: obj.contentRoot,
      ...(obj.mimeTypes === undefined
        ? {}
        : { mimeTypes: { ...obj.mimeTypes } }),
      ...(obj.ssrHandler === undefined ? {} : { ssrHandler: obj.ssrHandler }),
      ...(obj.virtualHosts === undefined
        ? {}
        : { virtualHosts: [...obj.virtualHosts] }),
    })
  );
  return harden(result);
};
harden(validateWebletFormula);

/**
 * The formula-backed hub adds one method beyond the in-memory hub's
 * surface: `whenReady()` returns a promise that resolves when the
 * initial hydration from `formulaStore.listBindings()` has
 * completed. The exo's other methods await the same promise
 * internally; `whenReady` is exposed so an embedder can surface a
 * startup failure without making a no-op bind / lookup call.
 */
const FormulaBackedAppsNameHubInterface = M.interface('AppsNameHub', {
  bind: M.call(M.string(), M.string()).returns(M.promise()),
  unbind: M.call(M.string()).returns(M.promise()),
  list: M.call().returns(M.promise()),
  lookup: M.call(M.string()).returns(M.promise()),
  has: M.call(M.string()).returns(M.promise()),
  whenReady: M.call().returns(M.promise()),
});
harden(FormulaBackedAppsNameHubInterface);

/**
 * Validate that the `formulaStore` argument has the three required
 * methods. Done at construction time so a misshapen power fails
 * loudly rather than failing on the first `bind` call.
 *
 * @param {unknown} formulaStore
 * @returns {AppsFormulaStore}
 */
const requireFormulaStore = formulaStore => {
  if (formulaStore === null || typeof formulaStore !== 'object') {
    throw makeError(
      X`AppsFormulaStore must be an object, got ${q(formulaStore)}`,
    );
  }
  const store = /** @type {Record<string, unknown>} */ (formulaStore);
  for (const method of ['listBindings', 'writeBinding', 'deleteBinding']) {
    if (typeof store[method] !== 'function') {
      throw makeError(
        X`AppsFormulaStore.${q(method)} must be a function, got ${q(store[method])}`,
      );
    }
  }
  return /** @type {AppsFormulaStore} */ (
    /** @type {unknown} */ (formulaStore)
  );
};

/**
 * Hydrate the in-memory map from the formula store's persisted
 * bindings. The store's records are re-normalized through the same
 * `normalizeVirtualHostName` the in-memory hub uses, so a record
 * that was written with mixed case (an older version of the store)
 * lands in the canonical form.
 *
 * Duplicate entries (same name, different ids) are a corruption
 * signal; the hydration throws rather than silently picking one.
 * The daemon-side store implementation is expected to enforce
 * uniqueness at write time, but the hub guards against a buggy
 * store by checking on read.
 *
 * @param {Map<string, string>} entries
 * @param {ReadonlyArray<WebletBindingRecord>} records
 */
const hydrateEntries = (entries, records) => {
  for (const record of records) {
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.name !== 'string' ||
      typeof record.webletFormulaId !== 'string'
    ) {
      throw makeError(
        X`AppsFormulaStore.listBindings returned a malformed record: ${q(record)}`,
      );
    }
    const key = normalizeVirtualHostName(record.name);
    if (record.webletFormulaId === '') {
      throw makeError(
        X`AppsFormulaStore returned an empty weblet formula id for ${q(key)}`,
      );
    }
    const existing = entries.get(key);
    if (existing !== undefined && existing !== record.webletFormulaId) {
      throw makeError(
        X`AppsFormulaStore returned duplicate bindings for ${q(key)}: ${q(existing)} and ${q(record.webletFormulaId)}`,
      );
    }
    entries.set(key, record.webletFormulaId);
  }
};

/**
 * Create a formula-backed `@apps` NameHub exo. The hub hydrates its
 * in-memory view from `formulaStore.listBindings()` asynchronously;
 * each exo method awaits the hydration before consulting the map.
 *
 * The hub's bind / lookup / unbind / list / has contract is the
 * same as `makeAppsNameHub`. A binding that survives a process
 * restart shows up in the new process's in-memory view because the
 * store rehydrates it.
 *
 * Failure-mode contract:
 *   - `listBindings` throwing at hydration causes every subsequent
 *     exo method to reject with the same error (the hub never
 *     becomes ready). Embedders should call `whenReady()` after
 *     construction to surface the failure deterministically.
 *   - `writeBinding` throwing on `bind` rolls back the in-memory
 *     map (so the hub stays in sync with the store) and re-throws.
 *   - `deleteBinding` throwing on `unbind` rolls back the in-memory
 *     removal (so the binding is still reachable through `lookup`)
 *     and re-throws.
 *
 * @param {object} args
 * @param {AppsFormulaStore} args.formulaStore
 * @returns {FormulaBackedAppsNameHub}
 */
export const makeFormulaBackedAppsNameHub = ({ formulaStore }) => {
  const store = requireFormulaStore(formulaStore);

  /** @type {Map<string, string>} */
  const entries = new Map();

  // Kick off hydration; do not block construction. Every async
  // method awaits the hydration promise before touching `entries`.
  // An embedder that does not call `whenReady` and then calls e.g.
  // `bind` will see the hydration error surface through `bind`
  // instead.
  const ready = (async () => {
    const initialRecords = await store.listBindings();
    if (!Array.isArray(initialRecords)) {
      throw makeError(
        X`AppsFormulaStore.listBindings must return an array, got ${q(initialRecords)}`,
      );
    }
    hydrateEntries(entries, initialRecords);
  })();
  // Silence the Node unhandled-rejection warning that would fire
  // if hydration rejects before any exo method awaits `ready`. The
  // rejection still surfaces through subsequent awaits; this catch
  // only suppresses the noisy warning.
  ready.catch(() => {});

  const exo = makeExo(
    'AppsNameHub',
    FormulaBackedAppsNameHubInterface,
    /** @type {any} */ ({
      /**
       * @param {string} name
       * @param {string} webletFormulaId
       */
      async bind(name, webletFormulaId) {
        await ready;
        const key = normalizeVirtualHostName(name);
        if (typeof webletFormulaId !== 'string' || webletFormulaId === '') {
          throw makeError(
            X`Weblet formula id must be a non-empty string, got ${q(webletFormulaId)}`,
          );
        }
        const existing = entries.get(key);
        if (existing !== undefined && existing !== webletFormulaId) {
          throw makeError(
            X`Virtual host ${q(key)} is already bound to ${q(existing)} (first-bind-wins)`,
          );
        }
        // Idempotent rebind to the same id is a no-op for the
        // in-memory map AND the store; the store's writeBinding is
        // expected to handle the case the same way (writing an
        // identical record is harmless). We still call through so
        // the store sees the request and can no-op or log.
        const hadExisting = existing !== undefined;
        entries.set(key, webletFormulaId);
        try {
          await store.writeBinding(key, webletFormulaId);
        } catch (err) {
          // Roll back; surface the original error.
          if (hadExisting) {
            entries.set(key, /** @type {string} */ (existing));
          } else {
            entries.delete(key);
          }
          throw err;
        }
      },
      /** @param {string} name */
      async unbind(name) {
        await ready;
        const key = normalizeVirtualHostName(name);
        const existing = entries.get(key);
        if (existing === undefined) {
          // Unbinding an unbound name is a no-op. The store should
          // also no-op; we still call through so the store sees the
          // request (an out-of-band delete may have left the store
          // with a stale entry).
          await store.deleteBinding(key);
          return;
        }
        entries.delete(key);
        try {
          await store.deleteBinding(key);
        } catch (err) {
          // Roll back.
          entries.set(key, existing);
          throw err;
        }
      },
      async list() {
        await ready;
        const list = [];
        for (const [name, webletFormulaId] of entries) {
          list.push(harden({ name, webletFormulaId }));
        }
        return harden(list);
      },
      /** @param {string} name */
      async lookup(name) {
        await ready;
        const key = normalizeVirtualHostName(name);
        const webletFormulaId = entries.get(key);
        if (webletFormulaId === undefined) {
          throw makeError(X`No virtual host bound for ${q(key)}`);
        }
        return webletFormulaId;
      },
      /** @param {string} name */
      async has(name) {
        await ready;
        const key = normalizeVirtualHostName(name);
        return entries.has(key);
      },
      async whenReady() {
        await ready;
      },
    }),
  );

  return /** @type {FormulaBackedAppsNameHub} */ (/** @type {unknown} */ (exo));
};
harden(makeFormulaBackedAppsNameHub);
