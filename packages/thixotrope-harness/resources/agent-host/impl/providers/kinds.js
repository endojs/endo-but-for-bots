// @ts-check
/**
 * Backend kinds (harness review HR-SYN-3 (a); hook table, milestones.md
 * "Hook tables": later milestones add entries, never edit another's): one
 * entry per `BackendSpec.kind`, each from its own module, carrying
 * everything the adapter decides by kind, so `kindOf(spec)` is the one
 * place a spec's kind is matched by the adapter's provider code. One other
 * table is keyed by the kind string: `providerOfKind` and `poolKinds`
 * (`guest/lib/subscription-texts.js`), the pools' own table, shared with
 * the guest, which the pool code (`subscriptions/`) reads to tell a Claude
 * pool from a Codex one. A later kind adds its entry here and, only if it
 * is a pool kind, one line to that table; it never adds a third table.
 *
 * Node only (adapter).
 */
import { scriptedKind } from './scripted.js';
import { openRouterKind } from './openrouter.js';
import { anthropicKind } from './anthropic.js';
import { claudePoolKind, codexPoolKind } from '../subscriptions/provider.js';

/**
 * A model catalogue as `index.js` routes `listModels` and `resolveModel` to
 * it (`catalog.js` `makeCatalog`, `subscriptions/index.js`'s pool
 * catalogue).
 * @typedef {{ listModels: (request: any) => Promise<any>, resolveModel: (request: any) => Promise<any> }} ModelCatalog
 */

/**
 * @typedef {object} BackendKind
 * @property {string} kind the `BackendSpec.kind` it serves
 * @property {(options: { label: string, spec: any, readKey?: () => Promise<string>, script: any, logPath?: string, timers: import('../timers.js').Timers, log: import('./event-log.js').EventLog, blobs: import('../blobs.js').BlobStore, backend: any, subscriptions: any }) => import('./shell.js').Provider} makeProvider
 * @property {readonly string[]} tools names in `adapterTools` this kind
 *   offers in its `TurnPorts.tools`
 * @property {string} unexpectedFailure the fixed reason of a round whose
 *   provider threw (R4-79): never the error's message, which may quote a
 *   provider body. Required: a kind without it is refused when the
 *   incarnation is made (HR-SYN-12)
 * @property {(catalogues: { models: ModelCatalog, pools: ModelCatalog }) => ModelCatalog} catalog
 *   which of the incarnation's catalogues lists and resolves this kind's
 *   models: the model catalogue (`models`) or the pool catalogue (`pools`)
 * @property {(options: { spec: any, fetch: typeof globalThis.fetch | undefined }) => (key: string) => Promise<import('./catalog-core.js').CatalogModel[]>} [readModels]
 *   the model catalogue's read of this kind's list with the backend's key;
 *   a kind without one lists the scripted double's one model
 * @property {(modelId: string) => boolean} [acceptsModelId] the model
 *   catalogue's shape check of a creation's model id (R4-21)
 */

/**
 * Backend kinds, by `BackendSpec.kind` (hook table).
 * @type {readonly BackendKind[]}
 */
export const backendKinds = harden([
  // M1a W1a.2: the scripted fake provider; offers echo.
  scriptedKind,
  // M2 W2.1a: OpenRouter chat completions, streamed (m2-interfaces.md 8.1).
  openRouterKind,
  // M2 W2.1b: the Anthropic Messages API, streamed (m2-interfaces.md 8.1).
  anthropicKind,
  // M4 W4.6: subscription pools (m4-interfaces.md 5.2).
  claudePoolKind,
  codexPoolKind,
]);

/**
 * The entry of `spec`'s kind in `table`, or undefined.
 * @param {any} spec a `BackendSpec` (or `PoolSpec`)
 * @param {readonly BackendKind[]} [table]
 * @returns {BackendKind | undefined}
 */
export const kindOf = (spec, table = backendKinds) =>
  table.find(entry => entry.kind === spec?.kind);
harden(kindOf);

/**
 * Refuse a kind table with a kind that names no fixed failure text
 * (HR-SYN-12): its rounds would otherwise have no reason that keeps provider
 * bodies out of the turn record.
 * @param {readonly BackendKind[]} table
 */
export const assertBackendKinds = table => {
  for (const entry of table) {
    if (
      typeof entry.unexpectedFailure !== 'string' ||
      entry.unexpectedFailure === ''
    )
      throw Error(
        `backend kind ${JSON.stringify(entry.kind)} has no unexpectedFailure text`,
      );
  }
};
harden(assertBackendKinds);
