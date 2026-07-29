// @ts-check

/**
 * @file Pure scoring logic for a Rock Paper Scissors round.
 *
 * Kept free of `@endo/exo` and `@endo/patterns` so the rules are
 * exercised by ordinary unit tests without an SES lockdown.
 * The exo-wrapped game in `./rock-paper-scissors.js` consumes this
 * function and validates inputs with a pattern guard at the boundary.
 */

/** The three legal choices. Frozen so callers can use it as a switch table. */
export const choices = harden(
  /** @type {const} */ (['rock', 'paper', 'scissors']),
);

/** @typedef {(typeof choices)[number]} Choice */

/**
 * @typedef {'draw' | { winner: 1 | 2, why: string }} GameResult
 */

/**
 * Defeats[a][b] tells how `a` beats `b`:
 *   - a verb string ("crushes", "covers", "cuts") if `a` beats `b`,
 *   - `null` if `a === b` (draw),
 *   - `false` if `a` loses to `b`.
 */
const defeats = harden(
  /** @type {const} */ ({
    rock: { rock: null, paper: false, scissors: 'crushes' },
    paper: { rock: 'covers', paper: null, scissors: false },
    scissors: { rock: false, paper: 'cuts', scissors: null },
  }),
);

/**
 * Score a single round of Rock Paper Scissors.
 *
 * @param {Choice} c1 The attacker's choice.
 * @param {Choice} c2 The defender's choice.
 * @returns {GameResult} `'draw'` or `{ winner, why }` where `winner` is
 *   `1` if `c1` wins and `2` if `c2` wins, and `why` is a human-readable
 *   sentence ("paper covers rock").
 */
export const score = (c1, c2) => {
  if (c1 === c2) return 'draw';
  const x = defeats[c1][c2];
  if (typeof x === 'string') {
    return harden({ winner: 1, why: `${c1} ${x} ${c2}` });
  }
  const y = defeats[c2][c1];
  // y is a verb string when c2 beats c1; the null/false cases are
  // unreachable because c1 !== c2 and the table is total.
  assert(typeof y === 'string', 'defeats table is total');
  return harden({ winner: 2, why: `${c2} ${y} ${c1}` });
};
harden(score);
