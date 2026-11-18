// @ts-check
/**
 * The inspecting object tools (W5.5; `designs/m5-interfaces.md` 2.4.3,
 * D-M5-2, P-17, R3-32): `describeCapability` and `readSources`, and the
 * `inspector` runtime part `lookup` uses for an object binding whose method
 * names are not cached yet.
 *
 * The session vat never makes an answered call to an object it did not
 * mint (D-M5-2): every call here goes through the inspector client
 * (`inspect-client.js`, W5.4), which asks the session's exec vat
 * (`ExecScope.inspect`) to call the target and answer a bounded, rendered
 * outcome. A hostile answer halts at most the exec vat; the client then
 * retires the scope and answers `texts.inspectTerminated`.
 *
 * - `describeCapability({ petName, method? })`: inspector `describe` (Fae's
 *   JSON `{ methods, documentation, documentationScope, example,
 *   truncated }`, rendered and bounded in the exec vat);
 * - `readSources({ petName, items })`: inspector `readSources` with the
 *   model's raw `items` text (the exec program checks Fae's item rules and
 *   calls `SourceReader.read(item)` per item); it arms the exec deadline;
 * - `inspectorPart.lookup`: inspector `methods`; the names are cached on
 *   the binding (`labels.setMethods`) and rendered as `exec/render.js`
 *   renders a remote capability.
 *
 * Both tools are offered only when the session has an exec vat and the
 * round's ports carry blob writers (the inspector stages through them).
 * Descriptions and parameter schemas are Fae's (`src/source-tools.js` at
 * `1315bef86`); the sentences naming an "Endo mount", `readText` and
 * `endo_exec` are adapted to M5's objects (JOURNAL J-0770). Arguments are
 * read with `parseClosedArgs` (2.4.2); staged arguments are refused.
 *
 * Guest rules.
 */
import { textOf } from '../../lib/guards/session.js';
import { limits } from '../../lib/limits.js';
import { argSpecs, parseClosedArgs } from '../../lib/tool-args.js';
import { fieldBytes, isStaged } from '../staging.js';
import { inspectDeadline, inspectFor } from './inspect-client.js';
import { capabilityLine } from './objects.js';

/** @import { ToolTableEntry } from '../tool-table.js' */
/** @import { ArgSpec } from '../../lib/tool-args.js' */
/** @import { Labels } from '../labels.js' */

/** @param {string} text */
const ok = text => harden({ status: 'ok', text });
/** @param {string} text */
const failed = text => harden({ status: 'failed', text });

/**
 * `describeCapability` / `readSources` of a label that holds stored JSON
 * (Fae would call a method of the plain value and fail without a reason).
 * @param {string} petName
 */
export const notCapabilityText = petName =>
  `"${petName}" holds a stored value, not a capability; use lookup to read it`;
harden(notCapabilityText);

/** No blob writers on this round's ports: the inspector cannot answer. */
export const NO_WRITERS_TEXT = 'no blob writers on this turn';

const READ_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 64,
    },
    startLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    lineCount: { type: 'integer', minimum: 1, maximum: 200 },
    search: {
      type: 'string',
      description:
        'Optional literal, case-sensitive substring (not a regular expression).',
    },
  },
  required: ['path'],
};

/** The tool descriptions (Fae `src/source-tools.js`, adapted as noted). */
export const inspectionToolDescriptions = harden({
  describeCapability: harden({
    name: 'describeCapability',
    description:
      'Discover callable methods and existing capability documentation. Supply method to obtain its signature/examples. Does not invoke that method. Example: {"petName":"review-source","method":"read"}. Invoke with exec: const ref = await E(powers).lookup("review-source"); return await E(ref).read({ path: ["README.md"] }); Capabilities have different signatures: follow their help documentation. Prefer readSources for bounded source reads/search.',
    parameters: JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: { petName: { type: 'string' }, method: { type: 'string' } },
      required: ['petName'],
    }),
  }),
  readSources: harden({
    name: 'readSources',
    description:
      'Read or literal-search explicit file paths under an already-held source capability petName (one that implements SourceReader.read). Up to 8 items; each independently returns lines with 1-based numbers or an error, so one missing file does not discard other results. Defaults startLine=1, lineCount=80; maximum 200 returned lines and 8000 text characters per item. A 48000-character serialized response budget, including escaping, is divided evenly across items. Truncation flags distinguish incomplete scans from no matches. Paths are arrays of relative segments, never host paths or petnames. Example: {"petName":"review-source","items":[{"path":["README.md"],"startLine":1,"lineCount":40},{"path":["src","agent.js"],"search":"checkpoint"}]}. Discover paths first with exec, following the capability\'s help documentation.',
    parameters: JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: {
        petName: { type: 'string' },
        items: {
          type: 'array',
          items: READ_ITEM_SCHEMA,
          minItems: 1,
          maxItems: 8,
        },
      },
      required: ['petName', 'items'],
    }),
  }),
});

/**
 * Read a tool's arguments: refused when staged (2.4.2) or not closed JSON.
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
        textOf.argumentsTooLarge(tool, bytes, limits.inlineBytes),
      ),
    };
  }
  const parsed = parseClosedArgs(args, spec);
  if (!parsed.ok) return { outcome: failed(parsed.text) };
  return { values: parsed.values };
};

/**
 * The object held under `petName`, or the failed outcome.
 * @param {any} context
 * @param {string} petName
 * @returns {{ binding: any } | { outcome: any }}
 */
const objectBinding = (context, petName) => {
  const { labels } = context.runtime;
  const binding = labels.get(petName);
  if (binding === undefined)
    return { outcome: failed(textOf.unknownLabel(petName)) };
  if (binding.kind !== 'object')
    return { outcome: failed(notCapabilityText(petName)) };
  return { binding };
};

/**
 * @param {any} ports
 * @param {any} services
 */
const inspectable = (ports, services) =>
  services?.execVat !== undefined && ports?.writers !== undefined;

/** @type {ToolTableEntry} */
const describeCapabilityEntry = harden({
  name: 'describeCapability',
  site: 'guest',
  describe: () => inspectionToolDescriptions.describeCapability,
  available: inspectable,
  execute: ({ opId, args }, ports, context) => {
    const read = readArgs(
      'describeCapability',
      args,
      argSpecs.describeCapability,
    );
    if ('outcome' in read) return Promise.resolve(read.outcome);
    const petName = /** @type {string} */ (read.values.get('petName'));
    const held = objectBinding(context, petName);
    if ('outcome' in held) return Promise.resolve(held.outcome);
    const method = read.values.get('method');
    return inspectFor(context)(
      harden({
        op: 'describe',
        target: held.binding.value,
        writers: ports.writers,
        ...(method === undefined ? {} : { method }),
        opId,
      }),
    );
  },
  deadline: (request, context) => {
    inspectDeadline(request, context);
  },
});

/** @type {ToolTableEntry} */
const readSourcesEntry = harden({
  name: 'readSources',
  site: 'guest',
  describe: () => inspectionToolDescriptions.readSources,
  available: inspectable,
  execute: ({ opId, args }, ports, context) => {
    const read = readArgs('readSources', args, argSpecs.readSources);
    if ('outcome' in read) return Promise.resolve(read.outcome);
    const petName = /** @type {string} */ (read.values.get('petName'));
    const held = objectBinding(context, petName);
    if ('outcome' in held) return Promise.resolve(held.outcome);
    return inspectFor(context)(
      harden({
        op: 'readSources',
        target: held.binding.value,
        writers: ports.writers,
        args: /** @type {string} */ (read.values.get('items')),
        opId,
      }),
    );
  },
  deadline: (request, context) => {
    inspectDeadline(request, context);
  },
});

/** The entries appended to `toolTable` (H-5), after `objectToolEntries`. */
export const inspectionToolEntries = harden([
  describeCapabilityEntry,
  readSourcesEntry,
]);

/**
 * The `inspector` runtime part (`runtime-parts.js`): `lookup` of an object
 * binding without cached method names (`objects.js`).
 */
export const inspectorPart = harden({
  name: /** @type {'inspector'} */ ('inspector'),
  /** @param {{ labels: Labels }} runtime */
  make: runtime =>
    harden({
      /**
       * @param {{ opId: string, label: string, binding: any }} request
       * @param {any} ports
       * @param {any} context
       */
      lookup: async ({ opId, binding }, ports, context) => {
        if (ports?.writers === undefined)
          return failed(textOf.execUnavailable(NO_WRITERS_TEXT));
        const outcome = await inspectFor(context)(
          harden({
            op: 'methods',
            target: binding.value,
            writers: ports.writers,
            opId,
          }),
        );
        if (outcome?.status !== 'ok' || outcome.methods === undefined)
          return outcome;
        runtime.labels.setMethods(binding, outcome.methods);
        return ok(capabilityLine(outcome.methods));
      },
    }),
});
