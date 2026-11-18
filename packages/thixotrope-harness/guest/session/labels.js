// @ts-check
/**
 * The session's label map (W5.3; `designs/m5-interfaces.md` 2.4.1, D-M5-4,
 * architecture D-11): the single store of what a session holds by label.
 * Object tools, `powers` (W5.5), `adopt` (W5.7) and the creation-time seeds
 * read and write it.
 *
 * A `Map` from label to binding, in the session vat heap, bounded by
 * `limits.maxLabels` labels and, for stored JSON, `labelValueBytes` per
 * value and `labelJsonBytes` in all (bounds on retained state: `remove`
 * frees a slot and its bytes). Labels are human text (F.2 a) and are Map
 * keys only, never record keys (rule 12.10). Stored JSON stays the model's
 * text: nothing here parses it.
 *
 *   Binding = { kind: 'object', value, source }
 *           | { kind: 'json', text, bytes }
 *
 * The cached `__getMethodNames__` answer of an object binding (`lookup`) is
 * kept beside the binding (`methodsOf` / `setMethods`), so a binding stays
 * a hardened record.
 *
 * Not a record, not in the transcript, not exported (open decision O-8).
 * Guest rules.
 */
import { textOf as textOfM5, reservedLabels } from '../lib/interfaces-m5.js';
import { limits } from '../lib/limits.js';
import { utf8Bytes } from '../lib/bounded.js';

/**
 * @typedef {'preset' | 'endowment' | 'adopted' | 'stored'} BindingSource
 *
 * @typedef {{ kind: 'object', value: any, source: BindingSource }
 *   | { kind: 'json', text: string, bytes: number }} Binding
 *
 * @typedef {object} LabelSeed
 * @property {string} label
 * @property {any} value
 * @property {BindingSource} source
 *
 * @typedef {object} Labels
 * @property {(label: string) => Binding | undefined} get
 * @property {() => string[]} list sorted
 * @property {() => number} size
 * @property {() => number} jsonBytes stored JSON bytes in all
 * @property {(label: string, value: any, source: BindingSource) => Binding} bindObject
 * @property {(label: string, text: string) => Binding} bindJson
 * @property {(label: string) => boolean} remove
 * @property {(binding: Binding) => readonly string[] | undefined} methodsOf
 * @property {(binding: Binding, names: readonly string[]) => void} setMethods
 */

const sources = harden(['preset', 'endowment', 'adopted', 'stored']);

/**
 * The endowment rule (R3-22; Fae `session/preset-catalog.js` `name()` at
 * `1315bef86`): 1-80 units, not blank, no `@`, `/` or control character,
 * not `.` or `..`, not a reserved label.
 * @param {unknown} label
 */
export const isValidLabel = label =>
  typeof label === 'string' &&
  label.length > 0 &&
  label.length <= limits.endowmentLabelUnits &&
  label.trim() !== '' &&
  label !== '.' &&
  label !== '..' &&
  !label.includes('@') &&
  !label.includes('/') &&
  ![...label].some(char => char.charCodeAt(0) < 32) &&
  !reservedLabels.includes(label);
harden(isValidLabel);

/**
 * @param {{ seeds?: readonly LabelSeed[] }} [options]
 * @returns {Labels}
 */
export const makeLabels = ({ seeds = [] } = {}) => {
  /** @type {Map<string, Binding>} */
  const map = new Map();
  /** @type {WeakMap<Binding, readonly string[]>} */
  const methods = new WeakMap();
  let jsonBytes = 0;

  /**
   * Refuse a label that cannot be bound now (every refusal precedes the
   * first write).
   * @param {string} label
   */
  const admit = label => {
    if (!isValidLabel(label)) throw Error(textOfM5.reservedLabel(label));
    if (map.has(label)) throw Error(textOfM5.labelTaken(label));
    if (map.size >= limits.maxLabels) {
      throw Error(textOfM5.labelsFull(limits.maxLabels));
    }
  };

  /** @type {Labels['bindObject']} */
  const bindObject = (label, value, source) => {
    if (!sources.includes(source)) {
      throw Error(`unknown binding source ${source}`);
    }
    admit(label);
    /** @type {Binding} */
    const binding = harden({ kind: 'object', value, source });
    map.set(label, binding);
    return binding;
  };

  /** @type {Labels['bindJson']} */
  const bindJson = (label, text) => {
    admit(label);
    if (typeof text !== 'string') throw Error('a stored value is JSON text');
    const bytes = utf8Bytes(text);
    if (bytes > limits.labelValueBytes) {
      throw Error(textOfM5.valueTooLarge(bytes, limits.labelValueBytes));
    }
    if (jsonBytes + bytes > limits.labelJsonBytes) {
      throw Error(textOfM5.storedValuesFull(limits.labelJsonBytes));
    }
    /** @type {Binding} */
    const binding = harden({ kind: 'json', text, bytes });
    map.set(label, binding);
    jsonBytes += bytes;
    return binding;
  };

  /** @type {Labels['remove']} */
  const remove = label => {
    const binding = map.get(label);
    if (binding === undefined) return false;
    map.delete(label);
    if (binding.kind === 'json') jsonBytes -= binding.bytes;
    return true;
  };

  for (const { label, value, source } of seeds)
    bindObject(label, value, source);

  return harden({
    get: label => map.get(label),
    list: () => harden([...map.keys()].sort()),
    size: () => map.size,
    jsonBytes: () => jsonBytes,
    bindObject,
    bindJson,
    remove,
    methodsOf: binding => methods.get(binding),
    setMethods: (binding, names) => {
      if (binding.kind !== 'object') return;
      methods.set(binding, harden([...names]));
    },
  });
};
harden(makeLabels);
