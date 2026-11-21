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
 * Live children contribute managed object bindings under subagents/<name>.
 * Their delegation bounds and lifecycle are independent of the ordinary
 * petname limit. Lookup returns the same handle used for mail.
 *
 * The cached `__getMethodNames__` answer of an object binding (`lookup`) is
 * kept beside the binding (`methodsOf` / `setMethods`), so a binding stays
 * a hardened record.
 *
 * Not a record, not in the transcript, not exported (open decision O-8).
 * Guest rules.
 */
import {
  reservedLabels,
  subagentLabelPrefix,
  textOf,
} from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { utf8Bytes } from '../lib/bounded.js';
import { parseClosedArgs } from '../lib/tool-args.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { isRemotable } = /** @type {GuestGlobals} */ (globalThis);
const copyField = harden({
  tool: 'attachment',
  fields: [{ name: 'v', kind: /** @type {const} */ ('raw'), required: true }],
});

/**
 * @typedef {'preset' | 'endowment' | 'adopted' | 'stored' | 'subagent'} BindingSource
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
 * @property {(label: string, value: any, source: BindingSource) => Binding} bindAttachment
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
 * @param {{ seeds?: readonly LabelSeed[], onChange?: () => void,
 *   children?: () => { names: () => readonly string[], handleOf: (name: string) => any } | undefined }} [options]
 * @returns {Labels}
 */
export const makeLabels = ({
  seeds = [],
  onChange = () => {},
  children = () => undefined,
} = {}) => {
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
    if (!isValidLabel(label)) throw Error(textOf.reservedLabel(label));
    if (map.has(label)) throw Error(textOf.labelTaken(label));
    if (map.size >= limits.maxLabels) {
      throw Error(textOf.labelsFull(limits.maxLabels));
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
    onChange();
    return binding;
  };

  /** @type {Labels['bindJson']} */
  const bindJson = (label, text) => {
    admit(label);
    if (typeof text !== 'string') throw Error('a stored value is JSON text');
    const bytes = utf8Bytes(text);
    if (bytes > limits.labelValueBytes) {
      throw Error(textOf.valueTooLarge(bytes, limits.labelValueBytes));
    }
    if (jsonBytes + bytes > limits.labelJsonBytes) {
      throw Error(textOf.storedValuesFull(limits.labelJsonBytes));
    }
    /** @type {Binding} */
    const binding = harden({ kind: 'json', text, bytes });
    map.set(label, binding);
    jsonBytes += bytes;
    onChange();
    return binding;
  };

  /** @type {Labels['remove']} */
  const remove = label => {
    if (
      label.startsWith(subagentLabelPrefix) &&
      children()?.handleOf(label.slice(subagentLabelPrefix.length)) !==
        undefined
    ) {
      throw Error(
        'Use stopSubagent to stop the child and remove its managed inventory name',
      );
    }
    const binding = map.get(label);
    if (binding === undefined) return false;
    map.delete(label);
    if (binding.kind === 'json') jsonBytes -= binding.bytes;
    onChange();
    return true;
  };

  /** @type {Labels['bindAttachment']} */
  const bindAttachment = (label, value, source) => {
    if (isRemotable(value)) return bindObject(label, value, source);
    const json = value.json;
    if (typeof json !== 'string') throw Error('Invalid JSON attachment');
    const read = parseClosedArgs(`{"v":${json}}`, copyField);
    if (!read.ok || read.values.get('v') !== json.trim())
      throw Error('Invalid JSON attachment');
    return bindJson(label, json);
  };

  for (const { label, value, source } of seeds)
    bindAttachment(label, value, source);

  return harden({
    get: label => {
      if (!label.startsWith(subagentLabelPrefix)) return map.get(label);
      const child = children()?.handleOf(
        label.slice(subagentLabelPrefix.length),
      );
      return child === undefined
        ? undefined
        : harden({ kind: 'object', value: child, source: 'subagent' });
    },
    list: () =>
      harden(
        [
          ...map.keys(),
          ...(children()?.names() ?? []).map(
            name => subagentLabelPrefix + name,
          ),
        ].sort(),
      ),
    size: () => map.size + (children()?.names().length ?? 0),
    jsonBytes: () => jsonBytes,
    bindObject,
    bindAttachment,
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
