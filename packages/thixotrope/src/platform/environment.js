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

/**
 * The host user that owns this process, when the platform has one.
 *
 * @typedef {object} UserPowers
 * @property {() => number | undefined} getUserId
 *
 * @param {object} host
 * @param {UserPowers['getUserId']} host.getUserId
 * @returns {UserPowers}
 */
export const makeUserPowers = ({ getUserId }) => harden({ getUserId });
harden(makeUserPowers);
