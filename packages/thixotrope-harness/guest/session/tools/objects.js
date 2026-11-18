// @ts-check
/**
 * The local object tools (W5.3; `designs/m5-interfaces.md` 2.4.3, P-17,
 * R3-31): `list`, `lookup`, `store`, `remove` over the session's label map
 * (`labels.js`), reached through `ToolContext.runtime.labels`.
 *
 * Descriptions and parameter schemas are Fae's (`src/tool-makers.js` at
 * `1315bef86`), word for word except where Fae names "your Endo
 * directory" or "the Endo daemon": here the labels are the session's own
 * (JOURNAL J-0750).
 *
 * `list`, `store`, `remove` and `lookup` of stored JSON make no call that
 * leaves the vat: `site: 'session'`, settled in the crank that issues them
 * (the round-final crank D). `lookup` of an object renders
 * `[remote capability] callable methods: [...]` from the binding's cached
 * method names; without a cache it forwards to the runtime's `inspector`
 * part (W5.5: one inspector `methods` call, D-M5-2), so its site is
 * `'guest'`. No method of a held object is ever called here.
 *
 * Arguments are read with `parseClosedArgs` (2.4.2): model JSON never
 * becomes a record here; staged (over `inlineBytes`) arguments are refused.
 *
 * Guest rules.
 */
import { textOf } from '../../lib/guards/session.js';
import { textOf as textOfM5 } from '../../lib/interfaces-m5.js';
import { limits } from '../../lib/limits.js';
import { argSpecs, parseClosedArgs } from '../../lib/tool-args.js';
import { fieldBytes, isStaged } from '../staging.js';

/** @import { ToolTableEntry } from '../tool-table.js' */
/** @import { ArgSpec } from '../../lib/tool-args.js' */
/** @import { Labels } from '../labels.js' */

/** @param {string} text */
const ok = text => harden({ status: 'ok', text });
/** @param {string} text */
const failed = text => harden({ status: 'failed', text });

/** @param {unknown} error */
const messageOf = error => {
  try {
    const { message } = /** @type {any} */ (error);
    if (typeof message === 'string') return message;
  } catch {
    // fall through
  }
  return `${error}`;
};

/**
 * The tool descriptions (Fae `src/tool-makers.js`, adapted wording noted
 * in the module comment).
 */
export const objectToolDescriptions = harden({
  list: harden({
    name: 'list',
    description:
      'List the petnames you hold. Takes no arguments. These are capability names, not filesystem paths. Use readSources for files or describeCapability for callable methods.',
    parameters: JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    }),
  }),
  lookup: harden({
    name: 'lookup',
    description:
      'Look up a stored value by petname. This does not invoke methods; method and args are not accepted. Use describeCapability for signatures and examples, then exec with E(ref).method(...).',
    parameters: JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: {
        petName: {
          type: 'string',
          description: 'The petname to look up.',
        },
      },
      required: ['petName'],
    }),
  }),
  store: harden({
    name: 'store',
    description:
      'Store a JSON-serializable value under a petname. The value is kept by this session and can be retrieved with lookup.',
    parameters: JSON.stringify({
      type: 'object',
      properties: {
        value: {
          description: 'The value to store (must be JSON-serializable).',
        },
        petName: {
          type: 'string',
          description: 'The petname to store the value under.',
        },
      },
      required: ['value', 'petName'],
    }),
  }),
  remove: harden({
    name: 'remove',
    description: 'Remove a petname you hold.',
    parameters: JSON.stringify({
      type: 'object',
      properties: {
        petName: {
          type: 'string',
          description: 'The petname to remove.',
        },
      },
      required: ['petName'],
    }),
  }),
});

/**
 * Read a local tool's arguments: refused when staged (2.4.2) or not
 * closed JSON; otherwise the values.
 * @param {string} tool
 * @param {any} args
 * @param {ArgSpec} spec
 * @returns {{ values: Map<string, any> } | { outcome: any }}
 */
const readArgs = (tool, args, spec) => {
  if (isStaged(args)) {
    const bytes = /** @type {number} */ (fieldBytes(args));
    return {
      outcome: failed(
        textOfM5.argumentsTooLarge(tool, bytes, limits.inlineBytes),
      ),
    };
  }
  const parsed = parseClosedArgs(args, spec);
  if (!parsed.ok) return { outcome: failed(parsed.text) };
  return { values: parsed.values };
};

/**
 * The method names line of a remote capability (as `exec/render.js`).
 * @param {readonly string[]} names
 */
export const capabilityLine = names =>
  `[remote capability] callable methods: ${JSON.stringify(names)}`;
harden(capabilityLine);

/** @param {any} context */
const labelsOf = context => context?.runtime?.labels;

/**
 * Run `work` over the label map; a refusal thrown by it is a failed result.
 * @param {any} context
 * @param {(labels: Labels) => any} work
 */
const withLabels = (context, work) => {
  const labels = labelsOf(context);
  if (labels === undefined) {
    return Promise.resolve(failed(textOf.notBuilt('the label map')));
  }
  try {
    return Promise.resolve(work(labels));
  } catch (error) {
    return Promise.resolve(failed(messageOf(error)));
  }
};

/** @type {ToolTableEntry} */
const listEntry = harden({
  name: 'list',
  site: 'session',
  describe: () => objectToolDescriptions.list,
  available: () => true,
  execute: ({ args }, _ports, context) => {
    const read = readArgs('list', args, argSpecs.list);
    if ('outcome' in read) return Promise.resolve(read.outcome);
    return withLabels(context, labels =>
      ok(JSON.stringify(labels.list(), null, 2)),
    );
  },
});

/** @type {ToolTableEntry} */
const lookupEntry = harden({
  name: 'lookup',
  site: 'guest',
  describe: () => objectToolDescriptions.lookup,
  available: () => true,
  execute: (request, ports, context) => {
    const read = readArgs('lookup', request.args, argSpecs.lookup);
    if ('outcome' in read) return Promise.resolve(read.outcome);
    const petName = /** @type {string} */ (read.values.get('petName'));
    const labels = labelsOf(context);
    if (labels === undefined) {
      return Promise.resolve(failed(textOf.notBuilt('the label map')));
    }
    const binding = labels.get(petName);
    if (binding === undefined) {
      return Promise.resolve(failed(textOfM5.unknownLabel(petName)));
    }
    if (binding.kind === 'json') return Promise.resolve(ok(binding.text));
    const names = labels.methodsOf(binding);
    if (names !== undefined) return Promise.resolve(ok(capabilityLine(names)));
    const inspector = context?.runtime?.inspector;
    if (inspector?.lookup === undefined) {
      return Promise.resolve(failed(textOf.notBuilt('lookup of an object')));
    }
    // W5.5: one inspector `methods` call; it caches the names with
    // `labels.setMethods` and answers the rendered line.
    return inspector.lookup(
      harden({ opId: request.opId, label: petName, binding }),
      ports,
      context,
    );
  },
});

/** @type {ToolTableEntry} */
const storeEntry = harden({
  name: 'store',
  site: 'session',
  describe: () => objectToolDescriptions.store,
  available: () => true,
  execute: ({ args }, _ports, context) => {
    const read = readArgs('store', args, argSpecs.store);
    if ('outcome' in read) return Promise.resolve(read.outcome);
    const petName = /** @type {string} */ (read.values.get('petName'));
    const value = /** @type {string} */ (read.values.get('value'));
    return withLabels(context, labels => {
      labels.bindJson(petName, value);
      return ok(textOfM5.stored(petName));
    });
  },
});

/** @type {ToolTableEntry} */
const removeEntry = harden({
  name: 'remove',
  site: 'session',
  describe: () => objectToolDescriptions.remove,
  available: () => true,
  execute: ({ args }, _ports, context) => {
    const read = readArgs('remove', args, argSpecs.remove);
    if ('outcome' in read) return Promise.resolve(read.outcome);
    const petName = /** @type {string} */ (read.values.get('petName'));
    return withLabels(context, labels =>
      labels.remove(petName)
        ? ok(textOfM5.removed(petName))
        : failed(textOfM5.unknownLabel(petName)),
    );
  },
});

/** The entries appended to `toolTable` (H-5), in `objectToolNames` order. */
export const objectToolEntries = harden([
  listEntry,
  lookupEntry,
  storeEntry,
  removeEntry,
]);
