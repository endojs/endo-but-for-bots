// @ts-check
/**
 * The preset editor's state and actions (W5.8; `designs/m5-interfaces.md`
 * 2.1, 4.1 item 7; R6-55, P-49), apart from its view so it can be tested
 * without a page.
 *
 * Everything is read from and written to the factory's one catalogue,
 * `E(powers.operator).getPresets()`, so every device shows the same presets
 * (a page re-reads them when the panel opens or on Reload). Presets are
 * objects (D-M5-1): the editor lists `configuration().presets`, describes
 * each, and edits one through its own methods. Each edit sends the
 * catalogue revision this page last read; a stale one is refused by the
 * catalogue (`texts.presetStale`), the form keeps the user's edits and the
 * refusal is shown. A record over `presetRecordBytes` is refused here,
 * before sending, with `presetTooLarge`.
 *
 * Endowments ("default objects", R6-55) are chosen from the operator
 * inventory: each is `{ label, value }` with the inventory row's presence
 * as the value. Template objects are kept as the preset has them (M6 edits
 * them).
 */
import { E } from '@endo/far';

import { fitsPresetRecord } from './size.js';
import { presetTexts, presetTooLarge } from './texts.js';

/** Inventory pages read for the object picker (1,024 entries / 50). */
const MAX_INVENTORY_PAGES = 21;

/** @param {unknown} error */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * @typedef {object} PresetForm
 * @property {string} label
 * @property {string} description
 * @property {string} template
 * @property {string} instructions
 * @property {string} networkPolicy
 * @property {any} [backend] a `Backend` presence, or undefined (factory default)
 * @property {string} modelId '' for none
 * @property {string} reasoningEffort '' for none
 * @property {Array<{ kind: string, label: string }>} objects
 * @property {Array<{ label: string, value: any }>} endowments
 */

/**
 * @typedef {object} PresetEntry
 * @property {any} preset the `Preset` presence
 * @property {any} [view] its `PresetView`
 * @property {string} [error] why `describe()` failed
 */

/**
 * @typedef {object} EditorState
 * @property {'loading'|'ready'|'failed'} phase
 * @property {boolean} busy
 * @property {string} [error] the last refusal or failure
 * @property {string} [notice] the last success
 * @property {number} revision the catalogue revision last read
 * @property {PresetEntry[]} entries
 * @property {number} selected index into `entries`, -1 when none
 * @property {PresetForm | undefined} form
 * @property {boolean} dirty
 * @property {boolean} confirmDelete
 * @property {Array<{ backend: any, label: string }>} backends
 * @property {Array<{ label: string, value: any }>} inventory
 * @property {Array<{ modelId: string, reasoningEfforts: string[] }>} models
 */

/**
 * The editable fields of a `PresetView`.
 *
 * @param {any} view
 * @returns {PresetForm}
 */
export const formOf = view => ({
  label: view.label,
  description: view.description ?? '',
  template: view.template,
  instructions: view.instructions ?? '',
  networkPolicy: view.networkPolicy ?? 'off',
  backend: view.backend,
  modelId: view.modelId ?? '',
  reasoningEffort: view.reasoningEffort ?? '',
  objects: (view.objects ?? []).map(
    /** @param {any} object */ ({ kind, label }) => ({ kind, label }),
  ),
  endowments: (view.endowments ?? []).map(
    /** @param {any} endowment */ ({ label, value }) => ({ label, value }),
  ),
});
harden(formOf);

/**
 * The `PresetRecord` a form sends (factory `shapes.PresetRecord`): the
 * optional `backend`, `modelId` and `reasoningEffort` only when set.
 *
 * @param {PresetForm} form
 */
export const recordOf = form =>
  harden({
    label: form.label,
    template: form.template,
    description: form.description,
    instructions: form.instructions,
    networkPolicy: form.networkPolicy,
    objects: form.objects.map(({ kind, label }) => ({ kind, label })),
    endowments: form.endowments.map(({ label, value }) => ({ label, value })),
    ...(form.backend === undefined ? {} : { backend: form.backend }),
    ...(form.modelId === '' ? {} : { modelId: form.modelId }),
    ...(form.reasoningEffort === ''
      ? {}
      : { reasoningEffort: form.reasoningEffort }),
  });
harden(recordOf);

/**
 * @param {object} options
 * @param {any} options.powers the connection's `GatewayPowers`
 */
export const makePresetEditor = ({ powers }) => {
  /** @type {EditorState} */
  let state = {
    phase: 'loading',
    busy: false,
    revision: 0,
    entries: [],
    selected: -1,
    form: undefined,
    dirty: false,
    confirmDelete: false,
    backends: [],
    inventory: [],
    models: [],
  };
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {any} */
  let catalog;
  /** @type {any} */
  let factory;
  let started = false;
  let modelToken = 0;

  /** @param {Partial<EditorState>} patch */
  const update = patch => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  /** @param {any} inventory */
  const readInventory = async inventory => {
    /** @type {Array<{ label: string, value: any }>} */
    const rows = [];
    /** @type {string | undefined} */
    let cursor;
    for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await (cursor === undefined
        ? E(inventory).list()
        : E(inventory).list(cursor));
      for (const row of answer.rows) {
        rows.push({ label: row.label, value: row.value });
      }
      if (answer.next === undefined) break;
      cursor = answer.next;
    }
    return rows;
  };

  /** The model rows of the form's backend (first catalogue page). */
  const loadModels = async () => {
    modelToken += 1;
    const token = modelToken;
    const backend = state.form ? state.form.backend : undefined;
    if (backend === undefined || !factory) {
      update({ models: [] });
      return;
    }
    try {
      const page = await E(factory).listModels({ backend });
      if (token !== modelToken) return;
      update({
        models: page.rows.map(
          /** @param {any} row */ row => ({
            modelId: row.modelId,
            reasoningEfforts: [...(row.reasoningEfforts ?? [])],
          }),
        ),
      });
    } catch {
      if (token === modelToken) update({ models: [] });
    }
  };

  /**
   * Read the catalogue, the backends and the inventory, select `target`
   * (else the preset selected before, else the first) and show its record.
   *
   * @param {any} [target] a `Preset` presence
   */
  const load = async target => {
    const operator = powers.operator;
    catalog = await E(operator).getPresets();
    factory = await E(operator).getFactory();
    const [configuration, backendObjects, inventory] = await Promise.all([
      E(catalog).configuration(),
      E(factory)
        .listBackends()
        .catch(() => []),
      readInventory(E(operator).getInventory()).catch(() => []),
    ]);
    /** @type {PresetEntry[]} */
    const entries = await Promise.all(
      configuration.presets.map(
        /** @param {any} preset */ preset =>
          E(preset)
            .describe()
            .then(
              /** @param {any} view */ view => ({ preset, view }),
              /** @param {unknown} error */ error => ({
                preset,
                error: messageOf(error),
              }),
            ),
      ),
    );
    const backends = await Promise.all(
      [...backendObjects].map(
        /** @param {any} backend */ backend =>
          E(backend)
            .describe()
            .then(
              /** @param {any} info */ info => ({ backend, label: info.label }),
              /** @param {unknown} error */ error => ({
                backend,
                label: messageOf(error),
              }),
            ),
      ),
    );
    const previous =
      state.selected >= 0 && state.entries[state.selected]
        ? state.entries[state.selected].preset
        : undefined;
    const wanted = target ?? previous;
    let selected = entries.findIndex(entry => entry.preset === wanted);
    if (selected < 0) selected = entries.length > 0 ? 0 : -1;
    const view = selected >= 0 ? entries[selected].view : undefined;
    update({
      phase: 'ready',
      revision: configuration.revision,
      entries,
      selected,
      form: view ? formOf(view) : undefined,
      dirty: false,
      confirmDelete: false,
      backends,
      inventory,
    });
    await loadModels();
  };

  /**
   * Run one catalogue edit, then re-read and select what it answers.
   *
   * @param {() => Promise<any>} edit answers the preset to select
   * @param {string} notice
   */
  const run = async (edit, notice) => {
    if (state.busy) return;
    update({ busy: true, error: undefined, notice: undefined });
    try {
      const target = await edit();
      await load(target);
      update({ busy: false, notice });
    } catch (error) {
      update({ busy: false, confirmDelete: false, error: messageOf(error) });
    }
  };

  /** The selected entry, or undefined. */
  const selectedEntry = () =>
    state.selected >= 0 ? state.entries[state.selected] : undefined;

  /**
   * The record to send, or undefined after refusing it (too large).
   */
  const checkedRecord = () => {
    if (!state.form) return undefined;
    const record = recordOf(state.form);
    if (!fitsPresetRecord(record)) {
      update({ error: presetTooLarge, notice: undefined });
      return undefined;
    }
    return record;
  };

  /** @param {(form: PresetForm) => PresetForm} change */
  const edit = change => {
    if (!state.form) return;
    update({
      form: change(state.form),
      dirty: true,
      confirmDelete: false,
      error: undefined,
      notice: undefined,
    });
  };

  const editor = {
    getState: () => state,
    /** @param {() => void} listener */
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Load once (the panel opening). */
    start: () => {
      if (started) return;
      started = true;
      load().catch(error =>
        update({ phase: 'failed', error: messageOf(error) }),
      );
    },
    /** Re-read everything and drop unsaved edits. */
    reload: async () => {
      update({ error: undefined, notice: undefined });
      try {
        await load();
      } catch (error) {
        update({ error: messageOf(error) });
      }
    },
    /**
     * Show another preset (unsaved edits are dropped).
     *
     * @param {number} index
     */
    select: index => {
      const entry = state.entries[index];
      if (!entry) return;
      update({
        selected: index,
        form: entry.view ? formOf(entry.view) : undefined,
        dirty: false,
        confirmDelete: false,
        error: entry.error,
        notice: undefined,
      });
      loadModels();
    },
    /**
     * Set a text field of the form.
     *
     * @param {'label'|'description'|'template'|'instructions'|'networkPolicy'|'modelId'|'reasoningEffort'} name
     * @param {string} value
     */
    setField: (name, value) => edit(form => ({ ...form, [name]: value })),
    /**
     * Choose a backend by its index in `backends`, or -1 for the factory
     * default (which also clears the model and effort defaults).
     *
     * @param {number} index
     */
    setBackend: index => {
      const row = index >= 0 ? state.backends[index] : undefined;
      edit(form =>
        row
          ? { ...form, backend: row.backend }
          : { ...form, backend: undefined, modelId: '', reasoningEffort: '' },
      );
      loadModels();
    },
    /**
     * Add the inventory row at `index` as a default object.
     *
     * @param {number} index
     */
    addEndowment: index => {
      const row = state.inventory[index];
      if (!row) return;
      edit(form =>
        form.endowments.some(endowment => endowment.value === row.value)
          ? form
          : {
              ...form,
              endowments: [
                ...form.endowments,
                { label: row.label, value: row.value },
              ],
            },
      );
    },
    /** @param {number} index */
    removeEndowment: index =>
      edit(form => ({
        ...form,
        endowments: form.endowments.filter((_, at) => at !== index),
      })),
    /**
     * @param {number} index
     * @param {string} label
     */
    relabelEndowment: (index, label) =>
      edit(form => ({
        ...form,
        endowments: form.endowments.map((endowment, at) =>
          at === index ? { label, value: endowment.value } : endowment,
        ),
      })),
    /** Save: `Preset.save(record, revision)`. */
    save: async () => {
      const entry = selectedEntry();
      if (!entry || state.busy) return;
      const record = checkedRecord();
      if (!record) return;
      const { revision } = state;
      await run(async () => {
        await E(entry.preset).save(record, revision);
        return entry.preset;
      }, presetTexts.saved);
    },
    /** Save as new: `PresetCatalog.create(record, revision)`. */
    saveAsNew: async () => {
      if (!catalog || state.busy) return;
      const record = checkedRecord();
      if (!record) return;
      const { revision } = state;
      await run(async () => {
        const created = await E(catalog).create(record, revision);
        return created.preset;
      }, presetTexts.created);
    },
    /** Delete (user presets): the first call asks, the second deletes. */
    remove: async () => {
      const entry = selectedEntry();
      if (!entry || state.busy) return;
      if (!state.confirmDelete) {
        update({ confirmDelete: true, error: undefined, notice: undefined });
        return;
      }
      const { revision } = state;
      await run(async () => {
        await E(entry.preset).delete(revision);
        return undefined;
      }, presetTexts.deleted);
    },
    /** Reset a built-in preset to its defaults. */
    reset: async () => {
      const entry = selectedEntry();
      if (!entry || state.busy) return;
      const { revision } = state;
      await run(async () => {
        await E(entry.preset).reset(revision);
        return entry.preset;
      }, presetTexts.resetDone);
    },
    /** Discard edits: the form shows the preset as last read. */
    discard: () => {
      const entry = selectedEntry();
      update({
        form: entry && entry.view ? formOf(entry.view) : undefined,
        dirty: false,
        confirmDelete: false,
        error: undefined,
        notice: undefined,
      });
      loadModels();
    },
  };
  return editor;
};
harden(makePresetEditor);
