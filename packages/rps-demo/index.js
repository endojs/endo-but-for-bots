// @ts-check

/**
 * @file Public entry point for `@endo/rps-demo`.
 *
 * The shipping artifact for daemon use is `src/rock-paper-scissors.js`;
 * this index re-exports its public surface so callers can write
 * `import { make } from '@endo/rps-demo'` without reaching into `src/`.
 * See `src/rock-paper-scissors.js` for the daemon plugin protocol and
 * `src/score.js` for the pure scoring rules.
 */

export { make } from './src/rock-paper-scissors.js';
export { score, choices } from './src/score.js';

/** @typedef {import('./src/score.js').Choice} Choice */
/** @typedef {import('./src/score.js').GameResult} GameResult */
