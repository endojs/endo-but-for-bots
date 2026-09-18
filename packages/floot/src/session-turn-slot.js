// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { makeSessionTurn } from './session-turn.js';

/**
 * Retain the session's UI turn independently of its callers. There is one
 * outstanding UI submission per session; mail still queues on the agent's
 * execution chain. A second browser must observe or cancel the existing turn
 * before submitting another. Finished handles remain usable by their holders,
 * but the session releases its reference after authoritative completion.
 *
 * @param {(input: any, writer: object, signal: AbortSignal, setHistory: (history: any[]) => void) => Promise<void>} run
 * @param {() => void} [onChange] told when the slot fills and when it empties
 */
export const makeSessionTurnSlot = (run, onChange = () => {}) => {
  /** @type {{ input: string | null, turn: object, history: Promise<any[]> } | null} */
  let current = null;
  // An observer of the slot filling and emptying. Never the turn's problem.
  const changed = () => {
    try {
      onChange();
    } catch (error) {
      console.error('[floot-session] turn slot observer failed:', error);
    }
  };
  return harden({
    /** @param {any} input */
    start(input) {
      !current ||
        Fail`Session already has an active turn; observe or cancel it first`;
      /** @type {(history: any[]) => void} */
      let setHistory = () => {};
      const history = new Promise(resolve => {
        setHistory = resolve;
      });
      const turn = makeSessionTurn({
        run: async (writer, signal) => {
          try {
            await run(input, writer, signal, setHistory);
          } finally {
            // A turn rejected before dispatch has no execution baseline.
            setHistory(harden([]));
          }
        },
      });
      // A streamed prompt may itself carry authority. Reconnecting observers
      // get display text only, never the original caller's input capability.
      const entry = harden({
        input: typeof input === 'string' ? input : null,
        turn,
        history,
      });
      current = entry;
      changed();
      void E(turn)
        .whenFinished()
        .then(() => {
          if (current === entry) {
            current = null;
            changed();
          }
        });
      return turn;
    },
    getCurrent: () => current,
  });
};
harden(makeSessionTurnSlot);
