// @ts-check
/**
 * The provider shell (harness review HR-SYN-3 (a)): the one `Provider` every
 * backend kind answers the Endpoint with (`endpoint.js`), around the kind's
 * own `runRound`.
 *
 * - `startRound(req, channel, prepare, owner)` stops a round still running
 *   for the same turn (silently, as a release), makes the new round's
 *   control (`round.js` `makeRoundControl`) and runs the kind's
 *   `runRound(req, channel, control, prepare, owner)`; the control is
 *   forgotten when that round ends.
 * - `cancelRound(turn)` stops the turn's running round, logged `cancelled`
 *   by the round; `releaseTurn(turn)` stops it silently (lease released).
 *   An API round's request is aborted with it (R4-7).
 *
 * The API providers (`api.js`), the pool provider
 * (`subscriptions/provider.js`) and the scripted double (`scripted.js`)
 * use it.
 *
 * Node only (adapter).
 */
import { makeRoundControl } from './round.js';

/**
 * What a backend kind's provider answers the Endpoint with.
 * @typedef {object} Provider
 * @property {(req: any, channel: any, prepare: (() => Promise<any>) | undefined, owner?: any) => Promise<void>} startRound
 *   runs one round: `prepare` is the session's context cache for it (the
 *   adapter's Endpoints always pass one), `owner` the Session presence its
 *   staged text counts against
 * @property {(turn: any) => void} cancelRound
 * @property {(turn: any) => void} [releaseTurn] (every shell has it; the
 *   Endpoint also takes a test provider without one)
 */

/**
 * @param {object} options
 * @param {import('../timers.js').Timers} options.timers
 * @param {(req: any, channel: any, control: import('./round.js').RoundControl, prepare: (() => Promise<any>) | undefined, owner: any) => Promise<void>} options.runRound
 *   one round of the kind, under `control`
 * @returns {Provider}
 */
export const makeProviderShell = ({ timers, runRound }) => {
  /** turn -> the control of its running round. */
  /** @type {Map<any, import('./round.js').RoundControl>} */
  const running = new Map();

  return harden({
    startRound: async (req, channel, prepare, owner) => {
      running.get(req.turn)?.stop('release');
      const control = makeRoundControl(timers);
      running.set(req.turn, control);
      try {
        await runRound(req, channel, control, prepare, owner);
      } finally {
        if (running.get(req.turn) === control) running.delete(req.turn);
      }
    },
    cancelRound: turn => running.get(turn)?.stop('cancel'),
    releaseTurn: turn => running.get(turn)?.stop('release'),
  });
};
harden(makeProviderShell);
