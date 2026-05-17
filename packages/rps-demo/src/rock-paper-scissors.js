// @ts-check

/**
 * @file Endo daemon plugin: a two-player Rock Paper Scissors game.
 *
 * Loaded into a daemon worker by, for example:
 *
 * ```sh
 * endo make src/rock-paper-scissors.js -n rps
 * ```
 *
 * The daemon invokes the module's `make` export and stores the
 * returned remotable under the given pet name. From there, a second
 * agent (a guest or host) interacts with the game over CapTP via
 * eventual sends (`E(rps).attack('rock')`, then `E(defender).defend('paper')`).
 *
 * The capability pattern: an `Attacker` exposes a one-shot
 * `attack(choice) -> Defender`. Handing out the `Defender` is the
 * commitment: it carries the attacker's choice, but only the
 * `defend(choice)` method is reachable from it, so a holder cannot
 * read or replay the attacker's pick. Both choices are resolved
 * inside the daemon, where the scoring function (kept in `./score.js`
 * for testability) is the only authority that compares them.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { score } from './score.js';

/** @import { Choice, GameResult } from './score.js' */

const { Fail } = assert;

const ChoiceShape = M.or('rock', 'paper', 'scissors');

const GameResultShape = M.or('draw', {
  winner: M.or(1, 2),
  why: M.string(),
});

const DefenderI = M.interface('Defender', {
  defend: M.call(ChoiceShape).returns(GameResultShape),
});

const AttackerI = M.interface('Attacker', {
  attack: M.call(ChoiceShape).returns(M.remotable('Defender')),
  getResult: M.call().returns(M.promise()),
});

/**
 * Build a fresh Rock Paper Scissors game.
 *
 * The returned `Attacker` is a one-shot remotable. The first call to
 * `attack(choice)` records the attacker's pick and returns a
 * `Defender` remotable; a second call to `attack` fails. Calling
 * `defend(choice)` on the `Defender` resolves the game.
 *
 * `getResult()` returns a promise that resolves once `defend` has
 * been called, with the same `GameResult` value. Useful for
 * spectators or for the attacker to await the verdict without
 * holding the `Defender`.
 *
 * @returns {ReturnType<typeof makeAttacker>}
 */
export const make = () => makeAttacker();
harden(make);

const makeAttacker = () => {
  /** @type {import('@endo/promise-kit').PromiseKit<GameResult>} */
  const resultPK = makePromiseKit();

  /** @type {Choice | undefined} */
  let attackerChoice;

  return makeExo('Attacker', AttackerI, {
    /** @param {Choice} c1 */
    attack(c1) {
      attackerChoice === undefined || Fail`already chose ${attackerChoice}`;
      attackerChoice = c1;
      return makeExo('Defender', DefenderI, {
        /** @param {Choice} c2 */
        defend(c2) {
          const outcome = score(c1, c2);
          resultPK.resolve(outcome);
          return outcome;
        },
      });
    },
    getResult() {
      return resultPK.promise;
    },
  });
};
