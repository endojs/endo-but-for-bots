// @ts-check
/**
 * Preset records: the built-in ones and the validation every saved record
 * passes (M5 W5.1; `designs/m5-interfaces.md` sections 1.3 and 2.1).
 *
 * Ported from Fae `session/preset-catalog.js` `normalizePreset` at
 * `1315bef86`, with the texts of `interfaces-m5-factory.js`. Differences
 * (D-M5-1): a preset has no id (it is an object); its `label` is Fae's
 * `title`; an endowment is `{ label, value }` without Fae's `sourcePath`
 * (the value is the object); a model default names the `Backend` object,
 * not a backend id; empty model and effort texts are left out. The whole
 * record is bounded by `limits.presetRecordBytes` (section 1.3), checked
 * last.
 *
 * Pure: no state, no sends. Runs in the factory vat and in Node.
 */
import { limits } from './limits.js';
import { fitsFrame } from './bounded.js';
import { reservedLabels } from './interfaces-m5.js';
import { texts, textOf } from './interfaces-m5-factory.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { Templates, PresetTemplate } from '../factory/preset-templates.js' */
const { passStyleOf } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {object} PresetData
 * @property {string} label
 * @property {string} template
 * @property {string} description
 * @property {string} instructions
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {readonly { kind: string, label: string }[]} objects
 * @property {readonly { label: string, value: any }[]} endowments
 * @property {any} [backend]
 * @property {string} [modelId]
 * @property {string} [reasoningEffort]
 */

const workspace = harden({ kind: 'git-workspace', label: 'workspace' });
const shell = harden({ kind: 'development-environment', label: 'shell' });

/**
 * The built-in presets (R3-11..R3-15; Fae `BUILTIN_PRESETS`), in
 * `builtInPresetLabels` order. Their labels are Fae's ids, so that
 * `catalog.builtIn(label)` and M1a's `chat-only` keep their names.
 * `general` selects no object (Fae); `voice` is a `general` preset with
 * Fae's development objects (its model is fixed in M11).
 * @type {readonly PresetData[]}
 */
export const BUILTIN_PRESETS = harden([
  {
    label: 'development',
    template: 'development',
    description:
      'A git workspace and isolated POSIX Shell with a persistent home for installed tools. Native storage cleanup is manual on its private admin.',
    instructions: '',
    networkPolicy: 'public-internet',
    objects: [workspace, shell],
    endowments: [],
  },
  {
    label: 'chat-only',
    template: 'chat-only',
    description: 'Chat without shell internet access or additional objects.',
    instructions: '',
    networkPolicy: 'off',
    objects: [],
    endowments: [],
  },
  {
    label: 'general',
    template: 'general',
    description:
      'A general assistant with optional workspace and isolated shell.',
    instructions: '',
    networkPolicy: 'public-internet',
    objects: [],
    endowments: [],
  },
  {
    label: 'new-project',
    template: 'new-project',
    description:
      'Start a project with a writable, git-backed workspace ready to populate.',
    instructions: '',
    networkPolicy: 'public-internet',
    objects: [workspace],
    endowments: [],
  },
  {
    label: 'voice',
    template: 'general',
    description:
      'Your Android assistant, with an isolated shell and internet access.',
    instructions: '',
    networkPolicy: 'public-internet',
    objects: [workspace, shell],
    endowments: [],
  },
]);

/**
 * Fae `text()`.
 * @param {unknown} value
 * @param {string} what
 * @param {number} max
 * @param {boolean} [empty]
 * @returns {string}
 */
const textField = (value, what, max, empty = true) => {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim())
  )
    throw Error(textOf.invalidField(what));
  return value;
};

/**
 * Whether a label passes the endowment rule (R3-22; Fae `name()`): 1-80
 * units, not blank, no `@`, `/` or control character, not `.` or `..`, not
 * reserved. Inventory labels follow the same rule.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isEdgeLabel = value => {
  if (
    typeof value !== 'string' ||
    value.length > limits.endowmentLabelUnits ||
    !value.trim()
  )
    return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('@') || value.includes('/')) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 32) return false;
  }
  return !reservedLabels.includes(value);
};
harden(isEdgeLabel);

/**
 * @param {unknown} value
 * @returns {string}
 */
const edgeLabel = value => {
  if (typeof value !== 'string' || !isEdgeLabel(value)) {
    // Fae checks the text first ("Invalid endowment name"), then the rule.
    textField(value, 'endowment name', limits.endowmentLabelUnits, false);
    throw Error(textOf.reservedEndowment(/** @type {string} */ (value)));
  }
  return value;
};

/** @param {unknown} value */
const isObjectCap = value => {
  try {
    return passStyleOf(/** @type {any} */ (value)) === 'remotable';
  } catch {
    return false;
  }
};

/**
 * @param {Templates} templates
 * @param {string} name
 * @returns {PresetTemplate | undefined}
 */
export const templateOf = (templates, name) =>
  templates.table.find(item => item.template === name);
harden(templateOf);

/**
 * Validate a preset record at the catalogue's boundary and answer its
 * normal form (the record `describe()` shows). Throws the section 12 texts.
 *
 * @param {any} record a `PresetRecord` (the guard has checked its shape in a
 *   vat; Node callers may pass anything)
 * @param {object} context
 * @param {Templates} context.templates
 * @param {string} [context.backendKind] the record's backend's kind
 *   (`describe().kind`), read by the catalogue before it validates: every
 *   kind but `scripted` needs a model ("Choose a model for this backend",
 *   Fae's rule for every backend but its default provider)
 * @returns {PresetData}
 */
export const normalizePresetRecord = (record, { templates, backendKind }) => {
  if (!record || typeof record !== 'object') throw Error(texts.invalidPreset);
  const label = textField(
    record.label,
    'preset title',
    limits.presetLabelUnits,
    false,
  );
  const template = templateOf(templates, record.template);
  if (template === undefined) throw Error(texts.unknownTemplate);
  const givenObjects = record.objects ?? [];
  const givenEndowments = record.endowments ?? [];
  if (
    !Array.isArray(givenObjects) ||
    givenObjects.length > limits.maxTemplateObjects ||
    !Array.isArray(givenEndowments) ||
    givenEndowments.length > limits.maxEndowments
  )
    throw Error(texts.invalidEndowments);
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<any>} */
  const selected = new Set();
  for (const object of givenObjects) {
    const allowed = template.objects.find(
      item => item.kind === object?.kind && item.label === object?.label,
    );
    if (allowed === undefined || names.has(allowed.label))
      throw Error(texts.invalidTemplateObject);
    names.add(allowed.label);
    selected.add(allowed);
  }
  // Template order (Fae canonicalizes provisioning order).
  const objects = template.objects
    .filter(item => selected.has(item))
    .map(({ kind, label: objectLabel }) =>
      harden({ kind, label: objectLabel }),
    );
  if (template.allObjects && objects.length !== template.objects.length)
    throw Error(texts.templateObjectsRequired);
  if (
    objects.some(item => item.kind === 'development-environment') &&
    !objects.some(item => item.kind === 'git-workspace')
  )
    throw Error(texts.shellNeedsWorkspace);
  const networkPolicy =
    record.networkPolicy ??
    (template.template === 'chat-only' ? 'off' : 'public-internet');
  if (networkPolicy !== 'off' && networkPolicy !== 'public-internet')
    throw Error(texts.invalidNetworkPolicy);
  const endowments = givenEndowments.map(item => {
    const name = edgeLabel(item?.label);
    if (names.has(name)) throw Error(textOf.duplicateEndowment(name));
    names.add(name);
    if (!isObjectCap(item.value)) throw Error(textOf.endowmentNotObject(name));
    return harden({ label: name, value: item.value });
  });
  if (
    template.template === 'chat-only' &&
    (networkPolicy !== 'off' || endowments.length > 0)
  )
    throw Error(texts.chatOnlyRule);
  const { backend } = record;
  if (backend !== undefined && !isObjectCap(backend))
    throw Error(textOf.invalidField('backend'));
  const modelId = textField(record.modelId ?? '', 'model', limits.modelIdUnits);
  const reasoningEffort = textField(
    record.reasoningEffort ?? '',
    'reasoning effort',
    limits.effortUnits,
  );
  if (backend === undefined && (modelId || reasoningEffort))
    throw Error(texts.backendForDefaults);
  if (
    backend !== undefined &&
    backendKind !== undefined &&
    backendKind !== 'scripted' &&
    !modelId
  )
    throw Error(texts.modelForBackend);
  /** @type {Record<string, any>} */
  const result = {
    label,
    template: template.template,
    description: textField(
      record.description ?? '',
      'description',
      limits.presetDescriptionUnits,
    ),
    instructions: textField(
      record.instructions ?? '',
      'instructions',
      limits.presetInstructionsUnits,
    ),
    networkPolicy,
    objects: harden(objects),
    endowments: harden(endowments),
  };
  if (backend !== undefined) result.backend = backend;
  if (modelId) result.modelId = modelId;
  if (reasoningEffort) result.reasoningEffort = reasoningEffort;
  const normal = /** @type {PresetData} */ (harden(result));
  if (!fitsFrame(normal, limits.presetRecordBytes))
    throw Error(texts.presetTooLarge);
  return normal;
};
harden(normalizePresetRecord);
