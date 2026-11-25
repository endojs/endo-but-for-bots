// @ts-check
/**
 * A subagent's model and reasoning effort (designs/m9-interfaces.md
 * D-M9-25, D-M9-27), shared by the two places that choose them:
 *
 * - the factory's `Delegation.spawn`, when its `SpawnRequest` takes
 *   `modelId` and `reasoningEffort` (`guest/factory/subagents.js`);
 * - the parent's session program, when the installed factory's guard is
 *   the older closed record that does not (D-M9-27). The parent then checks
 *   the choice against its own `SessionServices.backend` (the child's
 *   backend too: a child stays on its parent's) and sends it to the child
 *   as one more attachment, `subagentModelLabel`, which the older factory
 *   passes through as the child's endowment. The child's session program
 *   reads it in `subagentConfig` and runs on it.
 *
 * `chooseSubagentModel` is the D-M9-25 rule: neither given, the parent's
 * model and effort, unchanged, with no catalogue read. A `modelId` must be
 * a row of the backend catalogue (`listModels`, at most `MODEL_PAGES`
 * pages; a scripted backend has none and takes any id); a
 * `reasoningEffort` must be one the model's row offers, with the Codex
 * `ultra`/`max` spelling (a backend other than a pool takes none). A new
 * model alone keeps the parent's effort when the model offers it, else gets
 * none (the model's default).
 *
 * Guest rules: prelude globals only, data in, data out.
 */
import { limits } from './limits.js';
import { textOf } from './guards/factory.js';
import { parseClosedArgs } from './tool-args.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ArgSpec } from './tool-args.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** Catalogue pages a spawn's model check reads at most (D-M9-25). */
const MODEL_PAGES = 8;
/** Model ids a refusal names at most. */
const OFFERED_MODELS = 24;
export const POOL_KINDS = harden(['claude-pool', 'codex-pool']);

/**
 * The endowment label that carries a child's model choice (D-M9-27). A
 * label the model cannot mistake for one of its own: a `spawnSubagent`
 * attachment of this name is refused while modelId or reasoningEffort is
 * given.
 */
export const subagentModelLabel = 'subagent-model';

/**
 * The catalogue row of `modelId` on `backend`, with the ids read on the
 * way for a refusal.
 * @param {any} backend
 * @param {string} label the backend's label
 * @param {string} modelId
 */
export const modelRow = async (backend, label, modelId) => {
  /** @type {string[]} */
  const seen = [];
  /** @type {string | undefined} */
  let after;
  for (let page = 0; page < MODEL_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await E(backend).listModels(
      harden(
        after === undefined
          ? { limit: limits.modelPageRows }
          : { after, limit: limits.modelPageRows },
      ),
    );
    if (answer.state !== 'ok')
      throw Error(textOf.subagentCatalogUnavailable(label));
    for (const row of answer.rows) {
      if (row.modelId === modelId) return { row, seen };
      if (seen.length < OFFERED_MODELS && !seen.includes(row.modelId))
        seen.push(row.modelId);
    }
    if (answer.next === undefined) break;
    after = answer.next;
  }
  return { row: undefined, seen };
};
harden(modelRow);

/**
 * Whether a pool model's catalogue row offers `reasoningEffort` (R4-23: a
 * Codex row lists Fae's `ultra` as `max`). Data, not a refusal's text.
 * @param {string} kind the backend's kind
 * @param {any} row the model's catalogue row, or undefined
 * @param {string} reasoningEffort
 */
export const offersEffort = (kind, row, reasoningEffort) => {
  const listed =
    kind === 'codex-pool' && reasoningEffort === 'ultra'
      ? 'max'
      : reasoningEffort;
  return row?.reasoningEfforts?.includes(listed) === true;
};
harden(offersEffort);

/**
 * The model and effort of a child (D-M9-25), and the catalogue row read
 * for them, if any. Throws a fixed text naming what is offered.
 * @param {{ backend: any, modelId: string, reasoningEffort?: string }} from the parent's
 * @param {string | undefined} modelId requested
 * @param {string | undefined} reasoningEffort requested
 * @returns {Promise<{ modelId: string, reasoningEffort?: string, row?: any }>}
 */
export const chooseSubagentModel = async (from, modelId, reasoningEffort) => {
  if (modelId === undefined && reasoningEffort === undefined)
    return from.reasoningEffort === undefined
      ? { modelId: from.modelId }
      : { modelId: from.modelId, reasoningEffort: from.reasoningEffort };
  const { kind, label } = await E(from.backend).describe();
  const target = modelId ?? from.modelId;
  const pooled = POOL_KINDS.includes(kind);
  if (reasoningEffort !== undefined && !pooled)
    throw Error(textOf.subagentEffortNone(label));
  /** @type {any} */
  let row;
  if (modelId !== undefined && kind !== 'scripted') {
    const found = await modelRow(from.backend, label, modelId);
    if (found.row === undefined)
      throw Error(textOf.subagentModelUnknown(modelId, label, found.seen));
    row = found.row;
  }
  if (!pooled)
    return row === undefined ? { modelId: target } : { modelId: target, row };
  row ??= (await modelRow(from.backend, label, target)).row;
  const withRow = row === undefined ? {} : { row };
  if (reasoningEffort !== undefined) {
    if (offersEffort(kind, row, reasoningEffort))
      return { modelId: target, reasoningEffort, ...withRow };
    throw Error(
      textOf.subagentEffortUnknown(
        target,
        reasoningEffort,
        row?.reasoningEfforts ?? [],
      ),
    );
  }
  // A new model alone: the parent's effort where the model offers it, else
  // the model's default (the creation's `subscriptionEffort`).
  if (
    from.reasoningEffort !== undefined &&
    offersEffort(kind, row, from.reasoningEffort)
  )
    return {
      modelId: target,
      reasoningEffort: from.reasoningEffort,
      ...withRow,
    };
  return { modelId: target, ...withRow };
};
harden(chooseSubagentModel);

/**
 * The `subagentModelLabel` endowment of a choice: copy data (`JsonValue`,
 * which an older factory's `Attachments` guard admits) naming the model, the
 * effort and, from the row, the window and output cap the child's creation
 * would have stored for that model.
 * @param {{ modelId: string, reasoningEffort?: string, row?: any }} choice
 */
export const subagentModelAttachment = ({ modelId, reasoningEffort, row }) => {
  /** @type {Record<string, any>} */
  const data = { modelId };
  if (reasoningEffort !== undefined) data.reasoningEffort = reasoningEffort;
  if (typeof row?.contextLength === 'number')
    data.contextLength = row.contextLength;
  if (typeof row?.maxOutputTokens === 'number')
    data.maxOutputTokens = row.maxOutputTokens;
  return harden({
    label: subagentModelLabel,
    value: harden({ json: JSON.stringify(data) }),
  });
};
harden(subagentModelAttachment);

/**
 * The marker's fields, for the closed reader.
 * @type {ArgSpec}
 */
const markerSpec = harden({
  tool: subagentModelLabel,
  fields: harden([
    { name: 'modelId', kind: 'string', required: true },
    { name: 'reasoningEffort', kind: 'string' },
    { name: 'contextLength', kind: 'integer' },
    { name: 'maxOutputTokens', kind: 'integer' },
  ]),
});

/** @param {unknown} n */
const isCount = n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/**
 * A subagent's `SessionConfig` with the model choice its parent sent as an
 * endowment applied (D-M9-27): `config` itself when the session is not a
 * subagent or carries no valid choice. Read once per `make`, from data the
 * session keeps (its config and endowments), so a restart decides the same.
 * @param {any} config SessionConfig
 * @param {readonly any[] | undefined} endowments SessionServices.endowments
 */
export const subagentConfig = (config, endowments) => {
  if (config.userInitiated !== false || endowments === undefined) return config;
  const marker = endowments.find(e => e?.label === subagentModelLabel);
  const json = marker?.value?.json;
  if (typeof json !== 'string') return config;
  // Read by the closed reader (no `JSON.parse` in a vat, J-9366).
  const read = parseClosedArgs(json, markerSpec);
  if (!read.ok) return config;
  const modelId = read.values.get('modelId');
  const reasoningEffort = read.values.get('reasoningEffort');
  const contextLength = read.values.get('contextLength');
  const maxOutputTokens = read.values.get('maxOutputTokens');
  if (
    typeof modelId !== 'string' ||
    modelId === '' ||
    modelId.length > limits.modelIdUnits ||
    (reasoningEffort !== undefined &&
      (typeof reasoningEffort !== 'string' ||
        reasoningEffort === '' ||
        reasoningEffort.length > limits.effortUnits)) ||
    (contextLength !== undefined && !isCount(contextLength)) ||
    (maxOutputTokens !== undefined && !isCount(maxOutputTokens))
  )
    return config;
  /** @type {Record<string, any>} */
  const next = { ...config, modelId };
  // The parent's window, cap and effort belong to the parent's model.
  delete next.reasoningEffort;
  delete next.contextLength;
  delete next.maxOutputTokens;
  if (reasoningEffort !== undefined) next.reasoningEffort = reasoningEffort;
  if (contextLength !== undefined) next.contextLength = contextLength;
  if (maxOutputTokens !== undefined) next.maxOutputTokens = maxOutputTokens;
  return harden(next);
};
harden(subagentConfig);

/**
 * `services` without its `subagentModelLabel` endowment (`services` itself
 * when it has none).
 * @template {{ endowments?: readonly any[] }} T
 * @param {T} services
 * @returns {T}
 */
export const withoutSubagentModel = services => {
  const { endowments } = services;
  if (!endowments?.some(e => e?.label === subagentModelLabel)) return services;
  return harden({
    ...services,
    endowments: harden(endowments.filter(e => e?.label !== subagentModelLabel)),
  });
};
harden(withoutSubagentModel);
