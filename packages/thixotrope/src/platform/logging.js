// @ts-check
import harden from '@endo/harden';

/**
 * A minimal output channel. `log` is for a user-facing view's own output,
 * `error` for diagnostics; libraries should prefer `error` alone.
 *
 * @typedef {object} LogPowers
 * @property {(...args: unknown[]) => void} log
 * @property {(...args: unknown[]) => void} error
 *
 * @param {object} host
 * @param {(...args: unknown[]) => void} host.log
 * @param {(...args: unknown[]) => void} host.error
 * @returns {LogPowers}
 */
export const makeLogPowers = ({ log, error }) => harden({ log, error });
harden(makeLogPowers);
