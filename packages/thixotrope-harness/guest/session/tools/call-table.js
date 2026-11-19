// @ts-check
/**
 * One per-part table of in-flight tool calls (WX.1; m6-interfaces.md
 * D-M6-17, m9-interfaces.md D-M9-22, cross-check X-08): what the exec
 * part's `abandon` does for its own calls, as one shared helper, so the
 * `environment` part's shell calls and the `subagents` part's asks do not
 * write a third copy.
 *
 * A part makes one table in its `make` closure. Each call it sends is
 * opened in the table with the turn and generation of its `ToolContext`;
 * the call's tool outcome is the entry's promise. The first ending wins:
 * the answer (`answer`, by op id and generation, or `end`), the part's
 * cancel hook (`endTurn(turn, text, false)`) or its recovery hook
 * (`endTurn(turn, text, true)`: quiet, the ports are dead). An ending
 * deletes the entry, so a late answer finds nothing and is ignored, and the
 * table never holds more than `max` calls (`limits.callWindow`, as the
 * turn runner issues at most that many at once); `open` answers undefined
 * when it is full.
 *
 * The exec part keeps its own queue: its calls run one at a time in one
 * scope (`tools/exec.js`), which this table does not model.
 *
 * Guest rules: no module-level state; data-keyed state in a `Map`.
 */
import { limits } from '../../lib/limits.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {object} CallEntry
 * @property {string} opId
 * @property {any} turn the Turn of the call's `ToolContext`
 * @property {number} generation the `ToolContext.generation`
 * @property {Promise<any>} promise the call's tool outcome
 *
 * @typedef {object} CallTable
 * @property {(call: { opId: string, turn: any, generation: number, onEnd?: (outcome: any, quiet: boolean) => void }) => (CallEntry | undefined)} open
 *   a new open call (its `onEnd` runs once, at its ending, before the
 *   promise settles: a part disarms a deadline there unless `quiet`), or
 *   undefined when `max` calls are open or the op id is open already
 * @property {(entry: CallEntry, outcome: any, quiet?: boolean) => boolean} end
 *   end an open call with this outcome; false when it had ended
 * @property {(opId: string, generation: number, outcome: any) => boolean} answer
 *   end the open call of this op id and generation; false (ignored) for a
 *   late answer, of an ended call or an abandoned generation
 * @property {(turn: any, outcome: any, quiet: boolean) => number} endTurn
 *   end every open call of this turn with this outcome, in open order;
 *   answers how many
 * @property {() => number} size open calls
 * @property {(opId: string) => (CallEntry | undefined)} get
 */

/**
 * @param {object} [options]
 * @param {number} [options.max] open calls at most (default
 *   `limits.callWindow`)
 * @returns {CallTable}
 */
export const makeCallTable = ({ max = limits.callWindow } = {}) => {
  /** @type {Map<string, { entry: CallEntry, kit: any, onEnd?: (outcome: any, quiet: boolean) => void }>} */
  const open = new Map();

  /** @type {CallTable['end']} */
  const end = (entry, outcome, quiet = false) => {
    const held = open.get(entry.opId);
    if (held === undefined || held.entry !== entry) return false;
    open.delete(entry.opId);
    held.onEnd?.(outcome, quiet);
    held.kit.resolve(outcome);
    return true;
  };

  return harden({
    open: ({ opId, turn, generation, onEnd }) => {
      if (open.size >= max || open.has(opId)) return undefined;
      const kit = makePromiseKit();
      const entry = harden({ opId, turn, generation, promise: kit.promise });
      open.set(opId, { entry, kit, onEnd });
      return entry;
    },
    end,
    answer: (opId, generation, outcome) => {
      const held = open.get(opId);
      if (held === undefined || held.entry.generation !== generation) {
        return false;
      }
      return end(held.entry, outcome);
    },
    endTurn: (turn, outcome, quiet) => {
      const ofTurn = [...open.values()]
        .map(held => held.entry)
        .filter(entry => entry.turn === turn);
      for (const entry of ofTurn) end(entry, outcome, quiet);
      return ofTurn.length;
    },
    size: () => open.size,
    get: opId => open.get(opId)?.entry,
  });
};
harden(makeCallTable);
