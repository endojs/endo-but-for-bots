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
 *   { labels, services, config, contextWindow, powers, inspector, grants,
 *     exec, packages, hooks, toolSources }
 *
 * - `labels`: the session's label map (`labels.js`); `services`, `config`:
 *   the session's `SessionServices` and `SessionConfig`; `contextWindow`:
 *   the session's context window object when `makeSession` passes one
 *   (`makeRuntime`'s option; undefined until the context window is built,
 *   m8-interfaces.md 4.7), read by a part at run time, never in `make`;
 * - one getter per part name (a part made earlier in the table reaches one
 *   made later at run time, as `adoptTool` reaches `grants`); every name of
 *   `requiredParts` is required: a table without one is refused when the
 *   runtime is made (HR-SYN-23);
 * - `hooks`: the parts' hooks combined once, in table order (the runner and
 *   recovery call these); `toolSources`: the parts' `tools`, in table order
 *   (`tool-table.js` `toolSetFor` asks them every round).
 *
 * Order is behaviour, and it is fixed for every part to come (WX.1;
 * m8-interfaces.md D-M8-18, m9-interfaces.md D-M9-24):
 *
 *   powers, inspector, grants, exec, packages, environment, compaction,
 *   inbox, subagents
 *
 * `powers, inspector, grants, exec, packages` keeps the hook order the
 * static tables had (recovery: exec, then packages); in a settle crank the
 * `environment` part's hooks run before the inbox posts its reply, and
 * `compaction`'s before both; `admit` answers the first refusal in this
 * order. The static tool order after the package entries is fixed the same
 * way in `tool-table.js` (shell, `viewImage`, mail, requests, subagents).
 *
 * How a part is added (`environment`, `compaction`, `inbox`, `subagents`;
 * their names are already in `PartName` and, optional, on `Runtime`):
 * four additions, each directly below that part's slot comment
 * (`// slot: <name>`) in this file: its import, its name in
 * `requiredParts`, its entry in `runtimeParts`, and its getter in
 * `makeRuntime` (`get <name>() { return made.get('<name>'); }`). The slots
 * stand in table order, one comment line each, so two lanes' lines never
 * touch and merge without conflict; a lane deletes nothing. A part
 * goes into `requiredParts` in the commit that adds it to `runtimeParts`
 * (`makeRuntime` refuses a table without a required part, and a test that
 * passes its own `parts` then lists it). A part may hold per-session state in
 * its closure (each collection bounded or with a delete path, ARCH 12.6),
 * exos it mints, services from `runtime.services`, other parts through
 * `runtime` at run time (never during `make` of an earlier part), and
 * records and events through `HookTurn` in a hook's crank. It may not hold
 * module-level state keyed by session objects, the runner, queue or record
 * log, an `await` or a promise a turn waits on inside a hook, ports beyond
 * the turn they came with, per-connection objects (ARCH 12.7), data-keyed
 * record keys (12.10), or state that must survive export or a restart.
 * Through `HookTurn.active` a part reads the runner's turn record and
 * writes only the fields named for parts in `ActiveTurn`
 * (`turn-types.js`: `systemNote` in `onClaim`, `compactionAsk` in
 * `beforeRound`); it never writes another field of it. (Hardening what the
 * hooks receive would freeze the runner's own mutable record; the rule is
 * written here and in the typedef instead.)
 *
 * Guest rules.
 */

import { powersPart } from './powers-source.js';
import { inspectorPart } from './tools/inspection.js';
import { grantsPart } from './tools/granted.js';
import { execPart } from './tools/exec.js';
import { packagesPart } from './packages.js';
// slot: environment
import { environmentPart } from './environment.js';
// slot: compaction
import { compactionPart } from './compaction.js';
// slot: inbox
// slot: subagents

/** @import { Labels } from './labels.js' */
/** @import { ActiveTurn, TurnInfo } from './turn-types.js' */
/** @import { ToolSource } from './tool-table.js' */

/**
 * @typedef {'powers'
 *   | 'inspector'
 *   | 'grants'
 *   | 'exec'
 *   | 'packages'
 *   | 'environment'
 *   | 'compaction'
 *   | 'inbox'
 *   | 'subagents'
 * } PartName the closed list, in table order; WX.1 named the four parts
 *   still to come, so a lane adds no line here
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
 * @property {() => (NextTurn | undefined)} [nextTurn] a turn source, asked
 *   when idle and the queue empty, and not held or held only `restart`
 *   (m9-interfaces.md D-M9-5)
 * @property {() => (string | undefined)} [admit] asked before a user-facing
 *   start and by `claimNext` (m6-interfaces.md 15.3): a refusal text, or
 *   undefined to admit; synchronous, sends nothing
 *
 * @typedef {object} NextTurn a turn source's turn
 * @property {any} text the input: a string or a StagedText
 * @property {number} at
 * @property {(info: TurnInfo) => void} [take] run by `claim` before any
 *   record is appended or message sent, as the queue's claim is (the source
 *   marks its item taken; a throw leaves no turn behind)
 *
 * @typedef {object} HookTurn frozen (not hardened: `active` is the runner's
 *   mutable record; a part writes only the fields `ActiveTurn` names for
 *   parts)
 * @property {ActiveTurn} active
 * @property {number} round
 * @property {(record: any) => void} append into the record log, in this crank
 * @property {(event: any) => void} emit into this crank's outbox
 * @property {{ usedTokens: number, windowTokens: number }} [reading] the
 *   context reading the round's decision uses (m8-interfaces.md 4.1 rule 4,
 *   seam S-5e): set by the runner once the context window is built
 *
 * @typedef {object} RuntimeHooks the parts' hooks, combined
 * @property {(turn: HookTurn, item: any) => void} onClaim
 * @property {(turn: HookTurn) => void} beforeRound
 * @property {(turn: HookTurn) => void} onCancel
 * @property {(turn: HookTurn) => void} onSettle
 * @property {(turn: HookTurn) => void} onRecover each part's in a guard
 * @property {() => (NextTurn | undefined)} nextTurn the first source that
 *   has a turn, its answer unchanged
 * @property {() => (string | undefined)} admit the first part's refusal, in
 *   table order, or undefined
 *
 * @typedef {object} Runtime
 * @property {Labels} labels
 * @property {any} services
 * @property {any} config
 * @property {any} contextWindow the session's context window object, or
 *   undefined (m8-interfaces.md 4.7)
 * @property {any} powers
 * @property {any} inspector
 * @property {any} grants
 * @property {any} exec
 * @property {any} packages
 * @property {any} [environment] the parts still to come (WX.1): undefined
 *   until the part's lane adds it and its getter
 * @property {any} [compaction]
 * @property {any} [inbox]
 * @property {any} [subagents]
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
  // slot: environment
  'environment',
  // slot: compaction
  'compaction',
  // slot: inbox
  // slot: subagents
]);

/** @type {readonly RuntimePart[]} */
export const runtimeParts = harden([
  powersPart,
  inspectorPart,
  grantsPart,
  execPart,
  packagesPart,
  // slot: environment
  environmentPart,
  // slot: compaction
  compactionPart,
  // slot: inbox
  // slot: subagents
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
  const admit = listOf('admit');
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
    admit: () => {
      for (const hook of admit) {
        const refusal = hook();
        if (refusal !== undefined) return refusal;
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
 * @param {any} [options.contextWindow] the session's context window
 *   object (m8-interfaces.md 4.7, seam S-6); `Runtime.contextWindow`
 * @param {readonly RuntimePart[]} [options.parts]
 * @returns {Runtime}
 */
export const makeRuntime = ({
  labels,
  services,
  config,
  contextWindow = undefined,
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
    contextWindow,
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
    // slot: environment
    get environment() {
      return made.get('environment');
    },
    // slot: compaction
    get compaction() {
      return made.get('compaction');
    },
    // slot: inbox
    // slot: subagents
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
