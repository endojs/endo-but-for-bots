// @ts-check
/**
 * The session's runtime parts: the one way a per-session job joins the
 * session (step 3, HR-SYN-15; `designs/arch-review/step3-plan.md` 2;
 * `designs/m5-interfaces.md` 2.8 S4, sections 10 and 11).
 *
 * Every part is made once per session, in `makeSession`, in table order;
 * its state lives in its `make` closure; its turn hooks and its tool
 * source are members of what `make` answers, so they close over that
 * state. No module-level state keyed by a session's objects remains in
 * `guest/session`. Tool entries reach the parts through
 * `ToolContext.runtime` (no imports between parts).
 *
 * The runtime is a hardened record:
 *
 *   { labels, services, config, powers, inspector, grants, exec, packages,
 *     hooks, toolSources }
 *
 * - `labels`: the session's label map (`labels.js`); `services`, `config`:
 *   the session's `SessionServices` and `SessionConfig`;
 * - one getter per part name (a part made earlier in the table reaches one
 *   made later at run time, as `adoptTool` reaches `grants`); every name of
 *   `requiredParts` is required: a table without one is refused when the
 *   runtime is made (HR-SYN-23);
 * - `hooks`: the parts' hooks combined once, in table order (the runner and
 *   recovery call these); `toolSources`: the parts' `tools`, in table order
 *   (`tool-table.js` `toolSetFor` asks them every round).
 *
 * Order is behaviour: `powers, inspector, grants, exec, packages` keeps the
 * hook order the static tables had (recovery: exec, then packages).
 *
 * How a part is added (M6 `workspace`, M8 `compaction`, M9 `inbox` and
 * `subagents`): one entry in `runtimeParts`, one name in `PartName` and
 * `requiredParts`, one getter below. A part may hold per-session state in
 * its closure (each collection bounded or with a delete path, ARCH 12.6),
 * exos it mints, services from `runtime.services`, other parts through
 * `runtime` at run time (never during `make` of an earlier part), and
 * records and events through `HookTurn` in a hook's crank. It may not hold
 * module-level state keyed by session objects, the runner, queue or record
 * log, an `await` or a promise a turn waits on inside a hook, ports beyond
 * the turn they came with, per-connection objects (ARCH 12.7), data-keyed
 * record keys (12.10), or state that must survive export or a restart.
 *
 * Guest rules.
 */

import { powersPart } from './powers-source.js';
import { inspectorPart } from './tools/inspection.js';
import { grantsPart } from './tools/granted.js';
import { execPart } from './tools/exec.js';
import { packagesPart } from './packages.js';

/** @import { Labels } from './labels.js' */
/** @import { ActiveTurn } from './turn-types.js' */
/** @import { ToolSource } from './tool-table.js' */

/**
 * @typedef {'powers' | 'inspector' | 'grants' | 'exec' | 'packages'} PartName
 *
 * @typedef {object} RuntimePart
 * @property {PartName} name closed list; one getter per name on Runtime
 * @property {(runtime: Runtime) => PartValue} make called once, in
 *   makeSession, synchronously; sends nothing and awaits nothing
 *
 * @typedef {{ hooks?: PartHooks, tools?: ToolSource, [member: string]: any }} PartValue
 *   what `runtime.<name>` answers: the part's own members, plus its `hooks`
 *   and its `tools` (asked every round after the static table, under the
 *   name rules of `toolSetFor`)
 *
 * @typedef {object} PartHooks all synchronous, called in table order in the
 *   crank named; never await, at most the crank's send budget (ARCH 12.3)
 * @property {(turn: HookTurn, item: any) => void} [onClaim] claim crank,
 *   after `TurnStarted` (`item` the queue entry, or undefined)
 * @property {(turn: HookTurn) => void} [beforeRound] the crank that sends
 *   `startRound`
 * @property {(turn: HookTurn) => void} [onCancel] the crank of
 *   `Turn.cancel` or the turn deadline
 * @property {(turn: HookTurn) => void} [onSettle] the settle crank, after
 *   `TurnSettled`
 * @property {(turn: HookTurn) => unknown} [onRecover] recovery step 6; a
 *   throw or a rejection is skipped
 * @property {() => ({ text: string, at: number } | undefined)} [nextTurn] a
 *   turn source, asked when idle, the queue empty and not held
 *
 * @typedef {object} HookTurn frozen (not hardened: `active` is the runner's
 *   mutable record)
 * @property {ActiveTurn} active
 * @property {number} round
 * @property {(record: any) => void} append into the record log, in this crank
 * @property {(event: any) => void} emit into this crank's outbox
 *
 * @typedef {object} RuntimeHooks the parts' hooks, combined
 * @property {(turn: HookTurn, item: any) => void} onClaim
 * @property {(turn: HookTurn) => void} beforeRound
 * @property {(turn: HookTurn) => void} onCancel
 * @property {(turn: HookTurn) => void} onSettle
 * @property {(turn: HookTurn) => void} onRecover each part's in a guard
 * @property {() => ({ text: string, at: number } | undefined)} nextTurn the
 *   first source that has a turn
 *
 * @typedef {object} Runtime
 * @property {Labels} labels
 * @property {any} services
 * @property {any} config
 * @property {any} powers
 * @property {any} inspector
 * @property {any} grants
 * @property {any} exec
 * @property {any} packages
 * @property {RuntimeHooks} hooks
 * @property {readonly ToolSource[]} toolSources
 */

/**
 * The parts every runtime has (`makeRuntime` refuses a table without one).
 * @type {readonly PartName[]}
 */
export const requiredParts = harden([
  'powers',
  'inspector',
  'grants',
  'exec',
  'packages',
]);

/** @type {readonly RuntimePart[]} */
export const runtimeParts = harden([
  powersPart,
  inspectorPart,
  grantsPart,
  execPart,
  packagesPart,
]);

/**
 * The parts' hooks, each list in table order, combined into one record.
 * @param {readonly PartHooks[]} all
 * @returns {RuntimeHooks}
 */
const combineHooks = all => {
  /** @param {keyof PartHooks} name */
  const listOf = name => {
    /** @type {any[]} */
    const list = [];
    for (const hooks of all) {
      if (hooks[name] !== undefined) list.push(hooks[name]);
    }
    return harden(list);
  };
  const onClaim = listOf('onClaim');
  const beforeRound = listOf('beforeRound');
  const onCancel = listOf('onCancel');
  const onSettle = listOf('onSettle');
  const onRecover = listOf('onRecover');
  const nextTurn = listOf('nextTurn');
  return harden({
    onClaim: (turn, item) => {
      for (const hook of onClaim) hook(turn, item);
    },
    beforeRound: turn => {
      for (const hook of beforeRound) hook(turn);
    },
    onCancel: turn => {
      for (const hook of onCancel) hook(turn);
    },
    onSettle: turn => {
      for (const hook of onSettle) hook(turn);
    },
    onRecover: turn => {
      // A failing step must not stop recovery (recovery.js step 6).
      for (const hook of onRecover) {
        try {
          const result = /** @type {any} */ (hook(turn));
          if (result !== null && typeof result?.then === 'function') {
            result.then(undefined, () => {});
          }
        } catch {
          // Skipped.
        }
      }
    },
    nextTurn: () => {
      for (const source of nextTurn) {
        const next = source();
        if (next !== undefined) return next;
      }
      return undefined;
    },
  });
};

/**
 * @param {object} options
 * @param {Labels} options.labels
 * @param {any} options.services
 * @param {any} options.config
 * @param {readonly RuntimePart[]} [options.parts]
 * @returns {Runtime}
 */
export const makeRuntime = ({
  labels,
  services,
  config,
  parts = runtimeParts,
}) => {
  /** @type {Map<string, any>} */
  const made = new Map();
  /** @type {RuntimeHooks | undefined} */
  let hooks;
  /** @type {readonly ToolSource[]} */
  let toolSources = harden([]);
  /** @type {Runtime} */
  const runtime = harden({
    labels,
    services,
    config,
    get powers() {
      return made.get('powers');
    },
    get inspector() {
      return made.get('inspector');
    },
    get grants() {
      return made.get('grants');
    },
    get exec() {
      return made.get('exec');
    },
    get packages() {
      return made.get('packages');
    },
    get hooks() {
      return /** @type {RuntimeHooks} */ (hooks);
    },
    get toolSources() {
      return toolSources;
    },
  });
  for (const part of parts) {
    if (made.has(part.name)) throw Error(`two runtime parts ${part.name}`);
    made.set(part.name, part.make(runtime));
  }
  for (const name of requiredParts) {
    if (!made.has(name)) throw Error(`no runtime part ${name}`);
  }
  /** @type {PartHooks[]} */
  const all = [];
  /** @type {ToolSource[]} */
  const sources = [];
  for (const part of parts) {
    const value = made.get(part.name);
    if (value?.hooks !== undefined) all.push(value.hooks);
    if (value?.tools !== undefined) sources.push(value.tools);
  }
  hooks = combineHooks(all);
  toolSources = harden(sources);
  return runtime;
};
harden(makeRuntime);
