// @ts-check
import harden from '@endo/harden';

/**
 * Render a passable host value for a human-readable status string.
 * Kept separate from logging because callers may want the text without
 * emitting it.
 *
 * @typedef {object} DisplayPowers
 * @property {(value: unknown) => string} describe
 *
 * @param {object} host
 * @param {(value: unknown) => string} host.describe
 * @returns {DisplayPowers}
 */
export const makeDisplayPowers = ({ describe }) => harden({ describe });
harden(makeDisplayPowers);
