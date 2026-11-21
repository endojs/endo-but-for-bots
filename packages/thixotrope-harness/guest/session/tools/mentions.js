// @ts-check
/**
 * Mentions: `adopt` and `adoptTool` (W5.7; `designs/m5-interfaces.md` 2.6;
 * R3-8, R4-29, P-40). The package turn hooks are the `packages` runtime
 * part's (`packages.js`).
 *
 * - `adopt({ messageNumber, edgeName, petName })`, `site: 'session'`: binds
 *   the package's object in the label map with source `adopted`; settles
 *   in the issuing crank (kill point K3).
 * - `adoptTool({ messageNumber, edgeName, toolName })`, `site: 'guest'`:
 *   grants the package's object through the runtime's `grants` part (W5.6,
 *   found at run time: `grant(tool, 'adopted', toolName)`, then
 *   `schemaRead(grant)`; `toolName` is the grant's display label,
 *   `ToolGrantInfo.label`, XC), awaits its schema read, and
 *   answers `textOf.adoptedTool` when it is offered, else fails with the
 *   refusal. Offered only with an exec vat (the schema read is an inspector
 *   call, D-M5-2).
 *
 * Descriptions and schemas are Fae's (`src/tool-makers.js` at `1315bef86`)
 * with "your directory" and "the tools/ directory" adapted (JOURNAL
 * J-0791). Arguments are read with `parseClosedArgs`.
 *
 * Guest rules.
 */

import { textOf } from '../../lib/guards/session.js';
import { limits } from '../../lib/limits.js';
import { argSpecs, parseClosedArgs } from '../../lib/tool-args.js';
import { isValidLabel } from '../labels.js';
import { fieldBytes, isStaged } from '../staging.js';
import { messageOf } from '../../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { isRemotable } = /** @type {GuestGlobals} */ (globalThis);

/** @import { ToolTableEntry } from '../tool-table.js' */

/** @param {string} text */
const ok = text => harden({ status: 'ok', text });
/** @param {string} text */
const failed = text => harden({ status: 'failed', text });

const integerParam = harden({ type: 'integer' });
const stringParam = harden({ type: 'string' });

/** Fae `makeAdoptTool`, `makeAdoptToolTool` (wording noted above). */
export const packageToolDescriptions = harden({
  adopt: harden({
    name: 'adopt',
    description:
      'Adopt a value from an incoming package message, giving it a pet name. Edge names are the labels the sender attached to values in the package (the @name references in the message text).',
    parameters: JSON.stringify({
      type: 'object',
      properties: {
        messageNumber: {
          ...integerParam,
          description: 'The message number containing the value (integer).',
        },
        edgeName: {
          ...stringParam,
          description: 'The edge name (label) of the value in the message.',
        },
        petName: {
          ...stringParam,
          description: 'The pet name to give the adopted value.',
        },
      },
      required: ['messageNumber', 'edgeName', 'petName'],
    }),
  }),
  adoptTool: harden({
    name: 'adoptTool',
    description:
      'Adopt a capability from a mail message and install it as a tool. The adopted capability must implement the FaeTool interface (schema, execute, help). Once adopted, the tool is immediately available \u2014 use it right away.',
    parameters: JSON.stringify({
      type: 'object',
      properties: {
        messageNumber: {
          ...integerParam,
          description:
            'The message number containing the tool capability (integer).',
        },
        edgeName: {
          ...stringParam,
          description: 'The edge name (label) of the tool in the message.',
        },
        toolName: {
          ...stringParam,
          description: 'Name for the tool (e.g., "my-tool").',
        },
      },
      required: ['messageNumber', 'edgeName', 'toolName'],
    }),
  }),
});

/**
 * The arguments and the package's object, or a failed outcome.
 * @param {string} tool
 * @param {{ args: any, turnId: string }} request
 * @param {any} context
 * @param {string} nameKey
 * @returns {{ outcome: any } | { number: number, edge: string, name: string, value: any, runtime: any }}
 */
const readPackage = (tool, { args, turnId }, context, nameKey) => {
  if (isStaged(args)) {
    const bytes = /** @type {number} */ (fieldBytes(args));
    return {
      outcome: failed(
        textOf.argumentsTooLarge(tool, bytes, limits.inlineBytes),
      ),
    };
  }
  const parsed = parseClosedArgs(args, argSpecs[tool]);
  if (!parsed.ok) return { outcome: failed(parsed.text) };
  const number = parsed.values.get('messageNumber');
  const edge = parsed.values.get('edgeName');
  const name = parsed.values.get(nameKey);
  const { runtime } = context;
  const { table } = runtime.packages;
  try {
    const value = table.take(number, edge, turnId);
    return { number, edge, name, value, runtime };
  } catch (error) {
    return { outcome: failed(messageOf(error)) };
  }
};

/** @type {ToolTableEntry} */
const adoptEntry = harden({
  name: 'adopt',
  site: 'session',
  describe: () => packageToolDescriptions.adopt,
  available: () => true,
  execute: (request, _ports, context) => {
    const read = readPackage('adopt', request, context, 'petName');
    if ('outcome' in read) return Promise.resolve(read.outcome);
    const { number, edge, name, value, runtime } = read;
    try {
      runtime.labels.bindAttachment(name, value, 'adopted');
    } catch (error) {
      return Promise.resolve(failed(messageOf(error)));
    }
    return Promise.resolve(ok(textOf.adopted(edge, number, name)));
  },
});

/** @type {ToolTableEntry} */
const adoptToolEntry = harden({
  name: 'adoptTool',
  site: 'guest',
  describe: () => packageToolDescriptions.adoptTool,
  available: (_ports, services) => services?.execVat !== undefined,
  execute: async (request, _ports, context) => {
    const read = readPackage('adoptTool', request, context, 'toolName');
    if ('outcome' in read) return read.outcome;
    const { number, name, value, runtime } = read;
    if (!isValidLabel(name)) return failed(textOf.reservedLabel(name));
    if (!isRemotable(value))
      return failed('A stored JSON value cannot be adopted as a tool');
    const { grants } = runtime;
    try {
      const info = await grants.schemaRead(
        grants.grant(value, 'adopted', name),
      );
      if (info?.state === 'offered') {
        return ok(textOf.adoptedTool(name, number));
      }
      return failed(info?.reason ?? `${info?.state}`);
    } catch (error) {
      return failed(messageOf(error));
    }
  },
});

/** The entries appended to `toolTable` (H-5), in `packageToolNames` order. */
export const packageToolEntries = harden([adoptEntry, adoptToolEntry]);
