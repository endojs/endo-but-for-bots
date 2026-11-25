// @ts-check
/**
 * A subagent's model and reasoning effort (designs/m9-interfaces.md
 * D-M9-25, D-M9-27), shared by the two places that choose them:
 *
 * - the factory's `Delegation.spawn`, when its `SpawnRequest` takes
 *   `modelId` and `reasoningEffort` (`guest/factory/subagents.js`);
 * - the parent's session program, when the installed factory's guard is
 *   the older closed record that does not (or cannot be read), or when the
 *   session itself runs on a model the factory did not record (D-M9-27).
 *   The parent checks the choice against its own `SessionServices.backend`
 *   (the child's backend too: a child stays on its parent's) and sends it
 *   to the child as one more attachment, `subagentModelLabel`, which every
 *   factory passes through as the child's endowment;
 * - the child's session program, which checks the marker again
 *   (`checkedSubagentConfig`) before it runs on it.
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
import { workspaceSeedLabel } from './workspace-seed.js';

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
 * Labels only the session program attaches to a spawn (D-M9-27, D-M9-28):
 * a model's own attachment under one of them is always refused, so what a
 * child finds there was minted by its parent's session program.
 */
export const reservedSpawnLabels = harden([
  subagentModelLabel,
  workspaceSeedLabel,
]);

/**
 * The `subagentModelLabel` endowment of a choice: copy data (`JsonValue`,
 * which an older factory's `Attachments` guard admits) naming the model and
 * the effort only. The child checks both against its backend and takes the
 * window and output cap from the backend's `resolveModel`, as a creation
 * does.
 * @param {{ modelId: string, reasoningEffort?: string }} choice
 */
export const subagentModelAttachment = ({ modelId, reasoningEffort }) => {
  /** @type {Record<string, any>} */
  const data = { modelId };
  if (reasoningEffort !== undefined) data.reasoningEffort = reasoningEffort;
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
  ]),
});

/** Units a marker's text may have (two short fields). */
const MARKER_UNITS = 1024;

/**
 * The request a marker names, or undefined when it is not one.
 * @param {any} value the endowment's value
 * @returns {{ modelId: string, reasoningEffort?: string } | undefined}
 */
export const markerRequest = value => {
  const json = value?.json;
  if (typeof json !== 'string' || json.length > MARKER_UNITS) return undefined;
  // Read by the closed reader (no `JSON.parse` in a vat, J-9366).
  const read = parseClosedArgs(json, markerSpec);
  if (!read.ok) return undefined;
  const modelId = read.values.get('modelId');
  const reasoningEffort = read.values.get('reasoningEffort');
  if (
    typeof modelId !== 'string' ||
    modelId === '' ||
    modelId.length > limits.modelIdUnits ||
    (reasoningEffort !== undefined &&
      (typeof reasoningEffort !== 'string' ||
        reasoningEffort === '' ||
        reasoningEffort.length > limits.effortUnits))
  )
    return undefined;
  return harden(
    reasoningEffort === undefined ? { modelId } : { modelId, reasoningEffort },
  );
};
harden(markerRequest);

/** @param {unknown} n */
const isCount = n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/**
 * A subagent's `SessionConfig` with the model choice its parent sent as an
 * endowment applied (D-M9-27), checked here as a creation checks it: the
 * model must be in the backend's catalogue and the effort one the model's
 * row offers (`chooseSubagentModel`), and the window and output cap are
 * what the backend's `resolveModel` answers for the model (a Claude pool:
 * the pool's settings; nothing in the marker sets them). A marker that is
 * not one, a refused choice or a backend that cannot answer leaves the
 * config the factory made: the child runs on its parent's recorded model.
 * `overridden` says whether the model or effort now differs from what the
 * factory recorded (the session then sends its own to its children).
 * Run once, by the session program's `make`.
 * @param {any} config the SessionConfig the factory made
 * @param {any} backend the session's Backend
 * @param {any} value the marker's value
 * @returns {Promise<{ config: any, overridden: boolean }>}
 */
export const checkedSubagentConfig = async (config, backend, value) => {
  const unchanged = harden({ config, overridden: false });
  if (config.userInitiated !== false) return unchanged;
  const request = markerRequest(value);
  if (request === undefined) return unchanged;
  try {
    const choice = await chooseSubagentModel(
      harden({ backend, modelId: request.modelId }),
      request.modelId,
      request.reasoningEffort,
    );
    const { kind } = await E(backend).describe();
    /** @type {Record<string, any>} */
    const next = { ...config, modelId: choice.modelId };
    delete next.reasoningEffort;
    if (choice.reasoningEffort !== undefined)
      next.reasoningEffort = choice.reasoningEffort;
    // A scripted backend has no catalogue: the window stays the creation's.
    if (kind !== 'scripted' && choice.modelId !== config.modelId) {
      const answer = await E(backend).resolveModel(choice.modelId);
      const { contextLength, maxOutputTokens } = answer ?? {};
      if (
        answer?.modelId !== choice.modelId ||
        (contextLength !== undefined && !isCount(contextLength)) ||
        (maxOutputTokens !== undefined && !isCount(maxOutputTokens))
      )
        return unchanged;
      delete next.contextLength;
      delete next.maxOutputTokens;
      if (contextLength !== undefined) next.contextLength = contextLength;
      if (maxOutputTokens !== undefined) next.maxOutputTokens = maxOutputTokens;
    }
    return harden({
      config: harden(next),
      overridden:
        next.modelId !== config.modelId ||
        next.reasoningEffort !== config.reasoningEffort,
    });
  } catch {
    return unchanged;
  }
};
harden(checkedSubagentConfig);
