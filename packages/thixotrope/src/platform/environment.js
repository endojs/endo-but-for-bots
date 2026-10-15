// @ts-check
import harden from '@endo/harden';

/**
 * Read-only access to host configuration.
 *
 * @typedef {object} EnvironmentPowers
 * @property {(name: string) => string | undefined} get
 *
 * @param {object} host
 * @param {EnvironmentPowers['get']} host.get
 * @returns {EnvironmentPowers}
 */
export const makeEnvironmentPowers = ({ get }) => harden({ get });
harden(makeEnvironmentPowers);
