// @ts-check
/**
 * Mentions: `adopt`, `adoptTool` and the package turn hooks (W5.7;
 * `designs/m5-interfaces.md` 2.6; R3-8, R4-29, P-40).
 *
 * - `mentionHooks.onClaim` (seam S3, claim crank, after `TurnStarted`): an
 *   entry with attachments opens a package for the new turn and sets the
 *   turn's `systemNote` to `textOf.mentionLine(number, labels)`; every
 *   round request of that turn carries it (S2), later turns do not.
 * - `mentionHooks.onSettle` (settle crank, recovery's settle included) and
 *   `mentionHooks.recoverySteps` (recovery step 6, before that settle):
 *   the turn's packages are closed, their objects released.
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
import { textOf as textOfM5 } from '../../lib/interfaces-m5.js';
import { limits } from '../../lib/limits.js';
import { argSpecs, parseClosedArgs } from '../../lib/tool-args.js';
import { isValidLabel } from '../labels.js';
import { partOf } from '../packages.js';
import { fieldBytes, isStaged } from '../staging.js';

/** @import { ToolTableEntry } from '../tool-table.js' */

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
        textOfM5.argumentsTooLarge(tool, bytes, limits.inlineBytes),
      ),
    };
  }
  const parsed = parseClosedArgs(args, argSpecs[tool]);
  if (!parsed.ok) return { outcome: failed(parsed.text) };
  const number = parsed.values.get('messageNumber');
  const edge = parsed.values.get('edgeName');
  const name = parsed.values.get(nameKey);
  const runtime = context?.runtime;
  const table = runtime?.packages?.table;
  if (table === undefined) {
    return { outcome: failed(textOf.notBuilt('packages')) };
  }
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
      runtime.labels.bindObject(name, value, 'adopted');
    } catch (error) {
      return Promise.resolve(failed(messageOf(error)));
    }
    return Promise.resolve(ok(textOfM5.adopted(edge, number, name)));
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
    if (!isValidLabel(name)) return failed(textOfM5.reservedLabel(name));
    const grants = runtime.grants;
    if (grants?.grant === undefined) {
      return failed(textOf.notBuilt('adoptTool'));
    }
    try {
      const info = await grants.schemaRead(
        grants.grant(value, 'adopted', name),
      );
      if (info?.state === 'offered') {
        return ok(textOfM5.adoptedTool(name, number));
      }
      return failed(info?.reason ?? `${info?.state}`);
    } catch (error) {
      return failed(messageOf(error));
    }
  },
});

/** The entries appended to `toolTable` (H-5), in `packageToolNames` order. */
export const packageToolEntries = harden([adoptEntry, adoptToolEntry]);

/** @param {{ core: any, active: any, round?: number }} context */
const closePackages = ({ core, active }) => {
  partOf(core)?.table.closeTurn(active.turnId);
};

export const mentionHooks = harden({
  /** @param {{ core: any, active: any, item: any }} context */
  onClaim: ({ core, active, item }) => {
    /** @type {readonly { label: string, value: any }[] | undefined} */
    const attachments = item?.attachments;
    if (attachments === undefined || attachments.length === 0) return;
    const part = partOf(core);
    if (part === undefined) return;
    const labels = harden(attachments.map(a => a.label));
    const number = part.table.open({
      labels,
      values: new Map(attachments.map(a => [a.label, a.value])),
      turnId: active.turnId,
    });
    active.systemNote = textOfM5.mentionLine(number, labels);
  },
  onSettle: closePackages,
  recoverySteps: closePackages,
});
