// @ts-check
/**
 * The preset catalogue and its presets (M5 W5.1; `designs/m5-interfaces.md`
 * sections 2.1 and 2.3; R3-7, R3-11..R3-17, R3-20, R4-4, R6-55).
 *
 * One catalogue per factory, in the factory vat's heap (D-3): the built-in
 * presets (`chat-only` first, then the others in `builtInPresetLabels`
 * order: the PM's ruling at the cross-lane merge, contract 2.1), then user
 * presets in creation order, at most `maxPresets` in all. Each preset is one exo for its life (open decision O-5); the
 * catalogue keeps `records: WeakMap<Preset, PresetState>` and the factory's
 * creation reads a preset's record through it without a call (rights
 * amplification). An object the catalogue did not make is refused with
 * `texts.unknownPreset`.
 *
 * Every edit takes the catalogue revision the caller saw (a count, F.2 e)
 * and answers the new one; a stale revision is refused before anything
 * changes. A preset's own revision rises with each save or reset: a
 * session's snapshot names it, and the creation's endowments are read at
 * that revision (`endowmentsAt`; `texts.presetChanged` otherwise).
 *
 * The contract's guards make `create` and `save` synchronous (`M.call`),
 * so an edit cannot ask the record's backend for its kind: Fae's "Choose a
 * model for this backend" rule (an API backend needs a model) is not
 * applied when a preset is saved. A creation from such a preset without a
 * model is still refused by M2's `catalogueModel` resolver
 * (`texts.modelRequired`) unless the backend is the factory's default one,
 * whose configured model it then uses. `normalizePresetRecord` applies the
 * rule when its caller knows the kind (the editor, tests).
 *
 * Guest rules: prelude globals only; no clock; no sends.
 */
import { limitsM5 } from '../lib/limits-m5.js';
import {
  builtInPresetLabels,
  m5FactoryInterfaces,
  texts,
  textOf,
} from '../lib/interfaces-m5-factory.js';
import {
  BUILTIN_PRESETS,
  normalizePresetRecord,
} from '../lib/preset-catalog.js';
import { defaultTemplates } from './preset-templates.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { Templates } from './preset-templates.js' */
/** @import { PresetData } from '../lib/preset-catalog.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {object} PresetState
 * @property {PresetData} record the saved record (normal form)
 * @property {number} revision the preset's own revision
 * @property {string | undefined} builtIn the built-in's label, for a built-in
 * @property {boolean} deleted
 */

/**
 * Every catalogue's presets (one factory per vat; tests make several), so
 * that the services builder `presetEndowments` reads a preset's endowments
 * without a reference to its catalogue.
 * @type {WeakMap<any, (revision: number) => readonly { label: string, value: any }[]>}
 */
const endowmentReaders = new WeakMap();

/**
 * The endowments of a catalogue preset at its own revision `revision`, or
 * `undefined` for an object no catalogue made. Throws
 * `texts.presetChanged` when the preset was saved or reset since, and
 * `texts.presetDeleted` after a delete.
 * @param {any} preset
 * @param {number} revision
 */
export const presetEndowmentsAt = (preset, revision) =>
  endowmentReaders.get(preset)?.(revision);
harden(presetEndowmentsAt);

/**
 * @param {object} [options]
 * @param {Templates} [options.templates] the template table and providers
 *   (`preset-templates.js`; tests pass their own)
 * @param {any} [options.defaultsContext] what object and public-internet
 *   providers' `available(context)` read (M6/M7)
 */
export const makePresetCatalog = ({
  templates = defaultTemplates,
  defaultsContext = harden({}),
} = {}) => {
  /** The catalogue revision (F.2 e). */
  let revision = 0;
  /** @type {WeakMap<any, PresetState>} */
  const records = new WeakMap();
  /** Live presets in list order: built-ins, then user presets. */
  /** @type {any[]} */
  const order = [];
  /** @type {Map<string, any>} */
  const builtIns = new Map();

  /**
   * Why a record cannot make a session now, or `undefined`.
   * @param {PresetData} record
   * @returns {string | undefined}
   */
  const unavailableReason = record => {
    for (const object of record.objects) {
      const provider = templates.providers.find(p => p.kind === object.kind);
      if (provider === undefined) return textOf.presetNeeds(object.kind);
      const reason = provider.available(defaultsContext);
      if (reason !== undefined) return reason;
    }
    return undefined;
  };

  /** @param {any} preset */
  const stateOf = preset => {
    const state = records.get(preset);
    if (state === undefined) throw Error(texts.unknownPreset);
    return state;
  };

  /** @param {any} preset */
  const liveStateOf = preset => {
    const state = stateOf(preset);
    if (state.deleted) throw Error(texts.presetDeleted);
    return state;
  };

  /** @param {number} expected */
  const assertCurrent = expected => {
    if (expected !== revision) throw Error(texts.presetStale);
  };

  /** @param {any} record */
  const normalize = record => normalizePresetRecord(record, { templates });

  /** @param {PresetState} state */
  const viewOf = state => {
    const { record } = state;
    /** @type {Record<string, any>} */
    const view = {
      label: record.label,
      builtIn: state.builtIn !== undefined,
      template: record.template,
      description: record.description,
      instructions: record.instructions,
      networkPolicy: record.networkPolicy,
      objects: record.objects,
      endowments: record.endowments,
      revision: state.revision,
      available: true,
    };
    if (record.backend !== undefined) view.backend = record.backend;
    if (record.modelId !== undefined) view.modelId = record.modelId;
    if (record.reasoningEffort !== undefined)
      view.reasoningEffort = record.reasoningEffort;
    const reason = unavailableReason(record);
    if (reason !== undefined) {
      view.available = false;
      view.unavailableReason = reason;
    }
    return harden(view);
  };

  /** @param {PresetState} state */
  const snapshotOf = state => {
    const { record } = state;
    /** @type {Record<string, any>} */
    const snapshot = {
      label: record.label,
      template: record.template,
      networkPolicy: record.networkPolicy,
      objects: record.objects,
      endowmentLabels: record.endowments.map(item => item.label),
      revision: state.revision,
    };
    if (record.instructions !== '') snapshot.instructions = record.instructions;
    if (record.modelId !== undefined) snapshot.modelId = record.modelId;
    if (record.reasoningEffort !== undefined)
      snapshot.reasoningEffort = record.reasoningEffort;
    return harden(snapshot);
  };

  /**
   * @param {PresetData} record
   * @param {string} [builtIn]
   */
  const makePreset = (record, builtIn) => {
    /** @type {PresetState} */
    const state = { record, revision: 0, builtIn, deleted: false };
    const preset = makeExo('Preset', m5FactoryInterfaces.Preset, {
      describe: () => viewOf(liveStateOf(preset)),
      snapshot: () => snapshotOf(liveStateOf(preset)),
      /**
       * @param {any} given
       * @param {number} expected
       */
      save: (given, expected) => {
        liveStateOf(preset);
        assertCurrent(expected);
        if (builtIn !== undefined && given.template !== state.record.template)
          throw Error(texts.builtInTemplateFixed);
        const normal = normalize(given);
        state.record = normal;
        state.revision += 1;
        revision += 1;
        return revision;
      },
      /** @param {number} expected */
      delete: expected => {
        liveStateOf(preset);
        assertCurrent(expected);
        if (builtIn !== undefined) throw Error(texts.builtInNotDeletable);
        state.deleted = true;
        order.splice(order.indexOf(preset), 1);
        revision += 1;
        return revision;
      },
      /** @param {number} expected */
      reset: expected => {
        liveStateOf(preset);
        assertCurrent(expected);
        const original = BUILTIN_PRESETS.find(item => item.label === builtIn);
        if (original === undefined) throw Error(texts.onlyBuiltInReset);
        state.record = original;
        state.revision += 1;
        revision += 1;
        return revision;
      },
    });
    records.set(preset, state);
    endowmentReaders.set(preset, at => {
      if (state.deleted) throw Error(texts.presetDeleted);
      if (at !== state.revision) throw Error(texts.presetChanged);
      return state.record.endowments;
    });
    order.push(preset);
    return preset;
  };

  for (const label of builtInPresetLabels) {
    const record = BUILTIN_PRESETS.find(item => item.label === label);
    if (record !== undefined) builtIns.set(label, makePreset(record, label));
  }

  /** @param {string} label one of `builtInPresetLabels` */
  const builtIn = label => {
    const preset = builtIns.get(label);
    if (preset === undefined) throw Error(texts.unknownPreset);
    return preset;
  };

  /**
   * R3-20: `general` once a runner allows public internet (M6/M7 register
   * that in `preset-templates.js`) and `general` can be made, else
   * `chat-only` (open decision O-10).
   */
  const defaultPreset = () => {
    const general = builtIns.get('general');
    if (
      general !== undefined &&
      templates.internet.some(p => p.available(defaultsContext)) &&
      unavailableReason(stateOf(general).record) === undefined
    )
      return general;
    return builtIn('chat-only');
  };

  /**
   * The display order (section 2.1), with one difference: `chat-only`, the
   * built-in M1a listed alone, comes first, so that callers that take the
   * first listed preset as M1a's keep working; the other built-ins follow
   * in `builtInPresetLabels` order, then user presets in creation order.
   */
  const list = () => {
    const chatOnly = builtIns.get('chat-only');
    return harden([chatOnly, ...order.filter(p => p !== chatOnly)]);
  };

  /**
   * @param {any} record
   * @param {number} expected
   */
  const create = (record, expected) => {
    assertCurrent(expected);
    if (order.length >= limitsM5.maxPresets) throw Error(texts.tooManyPresets);
    const normal = normalize(record);
    const preset = makePreset(normal);
    revision += 1;
    return harden({ preset, revision });
  };

  const facet = makeExo('PresetCatalog', m5FactoryInterfaces.PresetCatalog, {
    list,
    configuration: () =>
      harden({ revision, presets: list(), defaultPreset: defaultPreset() }),
    create,
    defaultPreset,
  });

  /**
   * Section 2.3 step 1, synchronous: the preset of a creation (the given
   * one, else the default) must be this catalogue's, not deleted and
   * available; missing `backend`, `modelId` and `reasoningEffort` come from
   * its record (R6-55). A model default fills in only when the creation
   * uses the preset's backend; an option the caller gave wins.
   * @param {Record<string, any>} options `shapes.CreateOptions`
   */
  const withDefaults = options => {
    const preset = options.preset ?? defaultPreset();
    const { record } = liveStateOf(preset);
    const reason = unavailableReason(record);
    if (reason !== undefined) throw Error(reason);
    /** @type {Record<string, any>} */
    const filled = { ...options, preset };
    if (record.backend !== undefined) {
      if (filled.backend === undefined) filled.backend = record.backend;
      if (filled.backend === record.backend) {
        if (filled.modelId === undefined && record.modelId !== undefined)
          filled.modelId = record.modelId;
        if (
          filled.reasoningEffort === undefined &&
          record.reasoningEffort !== undefined
        )
          filled.reasoningEffort = record.reasoningEffort;
      }
    }
    return harden(filled);
  };

  /**
   * `SessionConfig.preset`: the snapshot without `instructions` (they are
   * in the composed prompt already).
   * @param {Record<string, any>} snapshot
   */
  const configSnapshot = snapshot => {
    const { instructions: _instructions, ...rest } = snapshot;
    return harden(rest);
  };

  /** @param {any} preset */
  const recordOf = preset => liveStateOf(preset).record;

  /**
   * @param {any} preset
   * @param {number} at the preset's own revision a snapshot named
   */
  const endowmentsAt = (preset, at) => {
    stateOf(preset);
    return /** @type {readonly { label: string, value: any }[]} */ (
      presetEndowmentsAt(preset, at)
    );
  };

  /**
   * User presets as data for export (acceptance 14): every field but the
   * endowments (objects are not exported); the backend stays an object for
   * the exporter to name by label.
   */
  const exportRecords = () =>
    harden(
      order
        .filter(preset => stateOf(preset).builtIn === undefined)
        .map(preset => {
          const { endowments: _endowments, ...rest } = stateOf(preset).record;
          return harden(rest);
        }),
    );

  /**
   * Import one exported record as a new user preset (at the current
   * revision).
   * @param {any} record
   */
  const importRecord = record => create(record, revision);

  return harden({
    facet,
    list,
    builtIn,
    defaultPreset,
    withDefaults,
    configSnapshot,
    recordOf,
    endowmentsAt,
    exportRecords,
    importRecord,
    /** The catalogue revision (tests). */
    revision: () => revision,
  });
};
harden(makePresetCatalog);

/** @typedef {ReturnType<typeof makePresetCatalog>} PresetCatalogKit */
