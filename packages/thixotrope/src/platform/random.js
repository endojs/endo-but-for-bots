// @ts-check
import harden from '@endo/harden';

/**
 * Unpredictable bytes. Sizes stay small (identifiers and session tokens),
 * so hosts may implement this over `crypto.getRandomValues`.
 *
 * @typedef {object} RandomPowers
 * @property {(length: number) => Uint8Array} randomBytes
 *
 * @param {object} host
 * @param {(length: number) => Uint8Array} host.randomBytes
 * @returns {RandomPowers}
 */
export const makeRandomPowers = ({ randomBytes }) => harden({ randomBytes });
harden(makeRandomPowers);
