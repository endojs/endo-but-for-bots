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
 *   is lost and is an ordinary failed result). Every entry names it
 *   (HR-SYN-23: the absent-means-adapter fallback went);
 * - `available(ports)` is true when the entry can run with this turn's
 *   `TurnPorts`;
 * - `execute` receives the model's argument JSON as text: a vat never
 *   parses it (contract section 15); the callee validates (R4-43, R4-45).
 *
 * M1a's only entry is `echo`, an adapter tool reached through
 * `TurnPorts.tools`.
 *
 * M5 (W5.3; m5-interfaces.md 2.4.3, 2.5, 2.8 S1, S5):
 * - `site: 'session'`: `execute` makes no call that leaves the vat and
 *   settles in the crank that issues it; turn.js treats it as `'guest'`
 *   for retired breaks (it cannot meet one);
 * - dynamic sources `(ports, services, runtime, builtIns) -> entries[]`,
 *   asked at every round after the static table: the runtime parts'
 *   `tools` (`runtime.toolSources`, in part table order; the `grants`
 *   part's granted tools since W5.6, M9 more);
 * - `toolSetFor` runs per round (turn.js `invoke`) and applies the name
 *   rules of 2.5 to the dynamic entries: a name in the round's built-in set
 *   (every static entry's name, available or not, and every adapter tool
 *   the round's ports offer) is `refused-builtin`; a name claimed by two or
 *   more dynamic entries refuses all of them (`refused-duplicate`). A
 *   dynamic entry may carry `refused(state, reason)`, called synchronously
 *   when it is refused that round; the refusals are also in the answer.
 *
 * Adapter tools (D-M4-9 as amended at the cross-lane merge, XC;
 * m5-interfaces.md 2.8 S1, m4-interfaces.md 6): an adapter tool the ports
 * offer (`TurnPorts.tools`) with no static entry of its name is offered
 * through one generic entry (`adapterToolEntries`): the description is the
 * one its `AdapterToolEntry` carries, `execute` sends to that entry's tool
 * object, `site: 'adapter'`. A port tool without a description, or whose
 * description names another tool, is not offered. These entries follow the
 * static table, so a static entry is never shadowed; their names are in the
 * round's built-in set, so no granted tool shadows them either.
 *
 * The static order after the package entries is fixed for the entries to
 * come (WX.1; m8-interfaces.md D-M8-18, m9-interfaces.md D-M9-24): shell
 * (`runCommand`, `inspectShell`), `viewImage`, mail (`listMessages`,
 * `send`, `reply`, `dismiss`), requests (`resolveRequest`,
 * `rejectRequest`, `submitForm`), subagents (`spawnSubagent`,
 * `askSubagent`, `stopSubagent`). A lane adds its import and its spread
 * each directly below its own `// slot: <name>` comment here, so two
 * lanes' lines never touch; it deletes nothing.
 */
import { echoDescription, textOf } from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { execEntry } from './tools/exec.js';
import { objectToolEntries } from './tools/objects.js';
import { inspectionToolEntries } from './tools/inspection.js';
import { packageToolEntries } from './tools/mentions.js';
// slot: shell
import { shellToolEntries } from './environment.js';
// slot: viewImage
// slot: mail
// slot: requests
// slot: subagents

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {object} ToolTableEntry
 * @property {string} name
 * @property {'adapter' | 'guest' | 'session'} site
 * @property {() => { name: string, description: string, parameters: string }} describe
 * @property {(ports: any, services?: any) => boolean} available
 * @property {(request: { opId: string, args: any, turnId: string }, ports: any, context?: any) => Promise<{ status: 'ok' | 'failed' | 'frame-limit', text: any }>} execute
 *   M1b (contract 2.3): `context` is the ToolContext; `args` may be staged
 * @property {(request: { opId: string }, context: any) => void} [deadline]
 * @property {(state: string, reason: string) => void} [refused] M5: a
 *   dynamic entry refused this round (name rules)
 */

/**
 * @typedef {(ports: any, services: any, runtime: any, builtIns: Set<string>) => readonly ToolTableEntry[]} ToolSource
 *   a runtime part's `tools`; `builtIns` is the round's built-in name set
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

/**
 * Generic entries, one per port tool record (the ports are held across
 * turns, so a round reuses the entries of the last one).
 * @type {WeakMap<object, ToolTableEntry>}
 */
const adapterEntryOf = new WeakMap();

/**
 * The generic entries of the adapter tools these ports offer that have no
 * entry in `table` (module comment).
 * @param {any} ports
 * @param {readonly ToolTableEntry[]} table
 * @returns {ToolTableEntry[]}
 */
export const adapterToolEntries = (ports, table) => {
  /** @type {ToolTableEntry[]} */
  const entries = [];
  for (const port of ports?.tools ?? []) {
    const { name, tool, description } = port;
    if (
      description?.name === name &&
      !table.some(entry => entry.name === name)
    ) {
      let entry = adapterEntryOf.get(port);
      if (entry === undefined) {
        entry = harden({
          name,
          site: /** @type {const} */ ('adapter'),
          describe: () => description,
          available: () => true,
          execute: (/** @type {{ opId: string, args: any }} */ request) =>
            E(tool).execute(harden({ opId: request.opId, args: request.args })),
        });
        adapterEntryOf.set(port, entry);
      }
      entries.push(entry);
    }
  }
  return entries;
};
harden(adapterToolEntries);

/** @type {readonly ToolTableEntry[]} */
export const toolTable = harden([
  echo,
  execEntry,
  ...objectToolEntries,
  ...inspectionToolEntries,
  ...packageToolEntries,
  // slot: shell
  ...shellToolEntries,
  // slot: viewImage
  // slot: mail
  // slot: requests
  // slot: subagents
]);

/**
 * The round's built-in name set (2.5): every static entry's name, available
 * or not, and every adapter tool these ports offer.
 * @param {any} ports
 * @param {readonly ToolTableEntry[]} [table]
 */
export const builtInToolNames = (ports, table = toolTable) => {
  const names = new Set(table.map(entry => entry.name));
  for (const entry of ports?.tools ?? []) names.add(entry.name);
  return names;
};
harden(builtInToolNames);

/**
 * The tool-table entries available with these ports, in table order: their
 * descriptions for the round request and a name lookup.
 *
 * M5: then the dynamic entries of the runtime's `toolSources`, with the
 * name rules (module comment); at most `maxToolsPerRound` descriptions in
 * all.
 *
 * @param {any} ports
 * @param {readonly ToolTableEntry[]} [table]
 * @param {any} [services] SessionServices (M1b: `available(ports, services)`)
 * @param {{ toolSources: readonly ToolSource[] }} [runtime] the session's
 *   runtime (`runtime-parts.js`)
 */
export const toolSetFor = (
  ports,
  table = toolTable,
  services = undefined,
  runtime = undefined,
) => {
  const sources = runtime?.toolSources ?? [];
  /** @type {any[]} */
  const descriptions = [];
  /** @type {Map<string, ToolTableEntry>} */
  const byName = new Map();
  /** @type {{ entry: ToolTableEntry, state: string, reason: string }[]} */
  const refused = [];
  for (const entry of [...table, ...adapterToolEntries(ports, table)]) {
    if (
      descriptions.length < limits.maxToolsPerRound &&
      !byName.has(entry.name) &&
      entry.available(ports, services)
    ) {
      byName.set(entry.name, entry);
      descriptions.push(entry.describe());
    }
  }
  if (sources.length > 0) {
    const builtIn = builtInToolNames(ports, table);
    /** @type {ToolTableEntry[]} */
    const dynamic = [];
    for (const source of sources) {
      for (const entry of source(ports, services, runtime, builtIn)) {
        dynamic.push(entry);
      }
    }
    /** @type {Map<string, number>} */
    const claims = new Map();
    for (const entry of dynamic) {
      claims.set(entry.name, (claims.get(entry.name) ?? 0) + 1);
    }
    /**
     * @param {ToolTableEntry} entry
     * @param {string} state
     * @param {string} reason
     */
    const refuse = (entry, state, reason) => {
      refused.push(harden({ entry, state, reason }));
      entry.refused?.(state, reason);
    };
    for (const entry of dynamic) {
      if (builtIn.has(entry.name)) {
        refuse(entry, 'refused-builtin', textOf.toolNameBuiltIn(entry.name));
      } else if (/** @type {number} */ (claims.get(entry.name)) > 1) {
        refuse(
          entry,
          'refused-duplicate',
          textOf.toolNameDuplicate(entry.name),
        );
      } else if (
        descriptions.length < limits.maxToolsPerRound &&
        entry.available(ports, services)
      ) {
        byName.set(entry.name, entry);
        descriptions.push(entry.describe());
      }
    }
  }
  return harden({
    descriptions: harden(descriptions),
    byName,
    refused: harden(refused),
  });
};
harden(toolSetFor);
