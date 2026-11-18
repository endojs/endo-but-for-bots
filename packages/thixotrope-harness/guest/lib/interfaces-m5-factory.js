// @ts-check
/**
 * The M5 interface contract, factory side (W5.0;
 * `designs/m5-interfaces.md` sections 2.1-2.3): the preset catalogue,
 * presets, the operator inventory and the M5 Operator. Only the factory
 * program (and Node: the gateway's key guard through `vocabularyShapes()`,
 * tests) imports this module, so the session and exec bundles do not carry
 * these guards.
 *
 * Presets and inventory entries are objects (F.1 #3): a preset is passed
 * to `createSession({ preset })` and edited through its own methods; the
 * catalogue's revision is a compare-and-set count (F.2 e). Labels are
 * human-chosen text (F.2 a). Endowments are `{ label, value }` records
 * whose value is the object itself (F.1 #4).
 *
 * Runs in vats and in Node (after `installGuestPrelude()`).
 */
import { limits } from './limits.js';
import { limitsM5 } from './limits-m5.js';
import { interfaces, methodNames, shapes } from './guards/factory.js';
import {
  extendInterface,
  lazyTable,
  m5Shapes,
  m5Widenings,
} from './interfaces-m5.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

/** @param {number} units */
const text = units => M.string({ stringLengthLimit: units });
/**
 * @param {any} shape
 * @param {number} length
 */
const list = (shape, length) => M.arrayOf(shape, { arrayLengthLimit: length });
/**
 * @param {Record<string, any>} required
 * @param {Record<string, any>} [optional]
 */
const record = (required, optional = {}) =>
  M.splitRecord(required, optional, {});
const count = M.and(M.number(), M.gte(0));
const done = M.undefined();
/** @param {string} label */
const R = label => M.remotable(label);

// ---------------------------------------------------------------- names

/**
 * Preset templates (R3-11..R3-17; Fae `preset-catalog.js` templates).
 * M5 provisions `chat-only` and `general` (no shell); the others are
 * listed and refused at creation until a later milestone registers their
 * object kinds in `guest/factory/preset-templates.js` (M6). `full-control`
 * waits for open decision 5; `rsi` and `machine-admin` are context only.
 */
export const presetTemplateNames = harden([
  'chat-only',
  'general',
  'development',
  'new-project',
]);
/** Built-in presets (R3-11..R3-15; Fae `BUILTIN_PRESETS`), in list order. */
export const builtInPresetLabels = harden([
  'development',
  'chat-only',
  'general',
  'new-project',
  'voice',
]);
/** Object kinds templates name (Fae); M5 provisions none of them. */
export const templateObjectKinds = harden([
  'git-workspace',
  'development-environment',
]);

// ---------------------------------------------------------------- texts

/**
 * Preset and inventory texts. Fae's (`session/preset-catalog.js` at
 * `1315bef86`) word for word; the rest are the harness's.
 */
export const texts = harden({
  invalidPreset: 'Invalid preset',
  unknownTemplate: 'Unknown preset template',
  invalidEndowments: 'Invalid preset endowments',
  invalidTemplateObject: 'Invalid template object',
  templateObjectsRequired: 'This preset requires all of its template objects',
  shellNeedsWorkspace: 'An isolated shell requires a workspace',
  invalidNetworkPolicy: 'Invalid network policy',
  chatOnlyRule: 'Chat only requires internet off and no additional objects',
  backendForDefaults: 'Choose a backend for model defaults',
  modelForBackend: 'Choose a model for this backend',
  presetStale: 'Preset settings changed elsewhere. Reload before saving.',
  tooManyPresets: 'Too many assistant presets',
  builtInTemplateFixed: 'This built-in preset cannot change its template',
  builtInNotDeletable: 'Built-in presets can be reset, not deleted',
  onlyBuiltInReset: 'Only built-in presets can be reset',
  /** Fae `Unknown preset`: an object the catalogue did not make. */
  unknownPreset: 'Unknown preset',
  // ---- harness ----
  /** A preset object after `delete()`. */
  presetDeleted: 'This preset was deleted',
  /** The preset was saved between the creation's snapshot and its grant. */
  presetChanged:
    'The preset changed while the session was being created; try again',
  /**
   * A preset record over `limitsM5.presetRecordBytes` (the editor before
   * sending, `PresetCatalog.create` and `Preset.save`), or a new session's
   * `make` argument (config with the snapshot, services with the
   * endowments) that would not fit one frame (rule 12.5).
   */
  presetTooLarge:
    'This preset is too large; shorten its instructions, description or labels, or remove objects',
  /** `Inventory.add` with `maxInventoryEntries` entries. */
  inventoryFull: 'The inventory is full',
  /** An inventory entry after `remove()`. */
  entryRemoved: 'This inventory entry was removed',
});

export const textOf = harden({
  /**
   * Fae `text()`.
   * @param {string} label
   */
  invalidField: label => `Invalid ${label}`,
  /**
   * R3-22 (Fae `name()`).
   * @param {string} name
   */
  reservedEndowment: name => `Reserved or invalid endowment name: ${name}`,
  /** @param {string} name */
  duplicateEndowment: name => `Duplicate endowment name: ${name}`,
  /** @param {string} name */
  endowmentNotObject: name => `Endowment ${name} must be an object capability`,
  /**
   * R3-21 and templates whose object kinds no milestone has registered.
   * @param {string} kind
   */
  presetNeeds: kind =>
    `This preset needs a ${kind}, which this harness cannot provide yet`,
  /** @param {string} label */
  inventoryLabelTaken: label =>
    `The inventory already has an entry labelled "${label}"`,
});

// ---------------------------------------------------------------- shapes

/** M5's factory-side shapes. */
export const m5FactoryShapes = lazyTable({
  TemplateName: () => M.or(...presetTemplateNames),
  NetworkPolicyName: () => M.or('off', 'public-internet'),
  TemplateObject: () =>
    record({
      kind: text(limitsM5.templateKindUnits),
      label: m5Shapes.EdgeLabel,
    }),
  /** An endowment: a label and the object (F.1 #4). */
  Endowment: () => m5Shapes.Attachment,
  /**
   * What `PresetCatalog.create` and `Preset.save` take (R6-55): every
   * editable field. A `backend` is the Backend object; model and effort
   * are text (F.2 c).
   */
  PresetRecord: () =>
    record(
      {
        label: text(limitsM5.presetLabelUnits),
        template: m5FactoryShapes.TemplateName,
      },
      {
        description: text(limitsM5.presetDescriptionUnits),
        instructions: text(limitsM5.presetInstructionsUnits),
        networkPolicy: m5FactoryShapes.NetworkPolicyName,
        backend: R('Backend'),
        modelId: shapes.ModelId,
        reasoningEffort: text(limits.effortUnits),
        objects: list(
          m5FactoryShapes.TemplateObject,
          limitsM5.maxTemplateObjects,
        ),
        endowments: list(m5FactoryShapes.Endowment, limitsM5.maxEndowments),
      },
    ),
  /** `Preset.describe()`: the record as saved, and what the editor shows. */
  PresetView: () =>
    record(
      {
        label: text(limitsM5.presetLabelUnits),
        builtIn: M.boolean(),
        template: m5FactoryShapes.TemplateName,
        description: text(limitsM5.presetDescriptionUnits),
        instructions: text(limitsM5.presetInstructionsUnits),
        networkPolicy: m5FactoryShapes.NetworkPolicyName,
        objects: list(
          m5FactoryShapes.TemplateObject,
          limitsM5.maxTemplateObjects,
        ),
        endowments: list(m5FactoryShapes.Endowment, limitsM5.maxEndowments),
        revision: count,
        available: M.boolean(),
      },
      {
        backend: R('Backend'),
        modelId: shapes.ModelId,
        reasoningEffort: text(limits.effortUnits),
        unavailableReason: shapes.Reason,
      },
    ),
  /** `PresetCatalog.configuration()` (A.4 `getPresetConfiguration`). */
  PresetConfiguration: () =>
    record({
      revision: count,
      presets: list(R('Preset'), limitsM5.maxPresets),
      defaultPreset: R('Preset'),
    }),
  /** `PresetCatalog.create` answer. */
  PresetCreated: () => record({ preset: R('Preset'), revision: count }),
  /** `Preset.snapshot()`: data only (the widened `shapes.PresetSnapshot`). */
  PresetSnapshot: () => m5Widenings.PresetSnapshot,
  /** One inventory entry as a page shows it. */
  InventoryRow: () =>
    record({
      entry: R('InventoryEntry'),
      label: m5Shapes.EdgeLabel,
      value: M.remotable(),
    }),
  /** `Inventory.list` page (cursor is text, F.2 d). */
  InventoryPage: () =>
    record(
      {
        rows: list(m5FactoryShapes.InventoryRow, limitsM5.inventoryPageEntries),
        rev: count,
      },
      { next: shapes.Cursor },
    ),
});

// ---------------------------------------------------------------- interfaces

/** M5's Operator method guards alone (the merge seam with M4's). */
export const m5FactoryExtensions = harden({
  Operator: () => ({
    getPresets: M.call().returns(R('PresetCatalog')),
    getInventory: M.call().returns(R('Inventory')),
  }),
});

const F = m5FactoryShapes;

export const m5FactoryInterfaces = lazyTable({
  /** M2 Operator + `getPresets`, `getInventory` (W5.1). */
  Operator: () =>
    extendInterface(
      interfaces.Operator,
      'Operator',
      m5FactoryExtensions.Operator(),
    ),
  /** The preset catalogue (A.4 `listPresets`, `getPresetConfiguration`). */
  PresetCatalog: () =>
    M.interface('PresetCatalog', {
      list: M.call().returns(list(R('Preset'), limitsM5.maxPresets)),
      configuration: M.call().returns(F.PresetConfiguration),
      create: M.call(F.PresetRecord, count).returns(F.PresetCreated),
      defaultPreset: M.call().returns(R('Preset')),
    }),
  /**
   * One preset, for its life (M1a's `describe`, `snapshot`, widened; the
   * A.4 `savePreset`, `deletePreset`, `resetPreset` as its own methods).
   * Each edit takes the catalogue revision the caller saw and answers the
   * new one (F.2 e).
   */
  Preset: () =>
    M.interface('Preset', {
      describe: M.call().returns(F.PresetView),
      snapshot: M.call().returns(F.PresetSnapshot),
      save: M.call(F.PresetRecord, count).returns(count),
      delete: M.call(count).returns(count),
      reset: M.call(count).returns(count),
    }),
  /** The operator's inventory (minimal; M12's Home adds the live view). */
  Inventory: () =>
    M.interface('Inventory', {
      list: M.call().optional(shapes.Cursor).returns(F.InventoryPage),
      add: M.call(m5Shapes.EdgeLabel, M.remotable()).returns(
        R('InventoryEntry'),
      ),
      addAll: M.call(
        list(m5Shapes.Attachment, limitsM5.inventoryPageEntries),
      ).returns(list(R('InventoryEntry'), limitsM5.inventoryPageEntries)),
      rev: M.call().returns(count),
    }),
  /** One inventory entry (per-item operations, F.1 #3). */
  InventoryEntry: () =>
    M.interface('InventoryEntry', {
      describe: M.call().returns(record({ label: m5Shapes.EdgeLabel })),
      value: M.call().returns(M.remotable()),
      relabel: M.call(m5Shapes.EdgeLabel).returns(done),
      remove: M.call().returns(done),
    }),
});

export const m5FactoryMethodNames = harden({
  Operator: harden([...methodNames.Operator, 'getPresets', 'getInventory']),
  PresetCatalog: harden(['list', 'configuration', 'create', 'defaultPreset']),
  Preset: harden(['describe', 'snapshot', 'save', 'delete', 'reset']),
  Inventory: harden(['list', 'add', 'addAll', 'rev']),
  InventoryEntry: harden(['describe', 'value', 'relabel', 'remove']),
});

/**
 * Every pattern of this module whose record keys a browser may send (the
 * gateway's key guard, M3 W3.2: see `interfaces-m5.js` `vocabularyShapes`).
 * Node only.
 */
export const vocabularyShapes = () =>
  harden([
    ...Object.values(m5FactoryShapes),
    ...Object.values(m5FactoryInterfaces),
  ]);
