// @ts-check
/**
 * The session's tool table (M1a W1a.4; `designs/m1a-interfaces.md`
 * section 12). A hook table, append-only for later milestones: each entry
 * is a plain hardened record
 *
 *   { name, site, describe() -> ToolDescription, available(ports) -> boolean,
 *     execute({ opId, args, turnId }, ports) -> Promise<ToolOutcome> }
 *
 * - `name` is the model-facing tool name (F.2 b);
 * - `site` says where `execute` calls: `'adapter'` (a transient adapter
 *   object: a retired break from it is a restart and runs recovery, never a
 *   tool failure) or `'guest'` (a guest vat: a retired break means that vat
 *   is lost and is an ordinary failed result). Absent means `'adapter'`;
 * - `available(ports)` is true when the entry can run with this turn's
 *   `TurnPorts`;
 * - `execute` receives the model's argument JSON as text: a vat never
 *   parses it (contract section 15); the callee validates (R4-43, R4-45).
 *
 * M1a's only entry is `echo`, an adapter tool reached through
 * `TurnPorts.tools`.
 */
import { echoDescription } from '../lib/interfaces.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {object} ToolTableEntry
 * @property {string} name
 * @property {'adapter' | 'guest'} [site]
 * @property {() => { name: string, description: string, parameters: string }} describe
 * @property {(ports: any) => boolean} available
 * @property {(request: { opId: string, args: string, turnId: string }, ports: any) => Promise<{ status: 'ok' | 'failed' | 'frame-limit', text: string }>} execute
 */

/**
 * The adapter tool named `name` in these ports, or undefined.
 * @param {any} ports
 * @param {string} name
 */
const adapterTool = (ports, name) => {
  for (const entry of ports?.tools ?? []) {
    if (entry.name === name) return entry.tool;
  }
  return undefined;
};

/** @type {ToolTableEntry} */
const echo = harden({
  name: 'echo',
  site: 'adapter',
  describe: () => echoDescription,
  available: ports => adapterTool(ports, 'echo') !== undefined,
  execute: ({ opId, args }, ports) =>
    E(adapterTool(ports, 'echo')).execute(harden({ opId, args })),
});

/** @type {readonly ToolTableEntry[]} */
export const toolTable = harden([echo]);

/**
 * The tool-table entries available with these ports, in table order: their
 * descriptions for the round request and a name lookup.
 *
 * @param {any} ports
 * @param {readonly ToolTableEntry[]} [table]
 */
export const toolSetFor = (ports, table = toolTable) => {
  /** @type {any[]} */
  const descriptions = [];
  /** @type {Map<string, ToolTableEntry>} */
  const byName = new Map();
  for (const entry of table) {
    if (!byName.has(entry.name) && entry.available(ports)) {
      byName.set(entry.name, entry);
      descriptions.push(entry.describe());
    }
  }
  return harden({ descriptions: harden(descriptions), byName });
};
harden(toolSetFor);
