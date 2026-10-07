// @ts-check
/// <reference types="ses" />

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { makeError } from '@endo/errors';
import { assertValidId, parseId } from '../formula-identifier.js';

/**
 * @import { FormulaIdentifier, FormulaNonceLocator, NodeNumber } from '../types.js'
 */

/**
 * This locator serves only capabilities. That is a policy of the locator,
 * not an OCapN limit: a formula that incarnates to data would be
 * exportable, but it is treated as a miss.
 *
 * @param {unknown} value
 */
const assertCapability = value => {
  if (passStyleOf(value) !== 'remotable') {
    throw makeError('Formula did not incarnate to a capability');
  }
};

/**
 * Name the class of a caught value for the local log. A Proxy trap under
 * `instanceof` or a `.name` accessor can throw; neither may escape `get`.
 *
 * @param {unknown} error
 * @returns {string}
 */
const errorClassName = error => {
  try {
    if (error instanceof Error && typeof error.name === 'string') {
      return error.name;
    }
  } catch {
    // Fall through to the generic class.
  }
  return 'Error';
};

/**
 * Make an OCapN `NonceLocator` that resolves a presented canonical formula
 * identifier for this daemon to that formula's incarnated capability. This is
 * steps 1-3 of `designs/daemon-ocapn-external-connectivity.md` §2: decode,
 * assert local, `provide(id)`.
 *
 * Every failure is the same miss: `get` never throws and returns
 * `undefined`, which the OCapN bootstrap reports as one fixed
 * `secret not found` rejection. Non-string secrets, noncanonical text,
 * well-known swissnum words such as `endo-peer-entry`, foreign-node
 * identifiers (never dialed), a rejecting `provideLocalFormula`, and a
 * non-capability value all miss.
 *
 * An identifier is local when `isLocalNode` accepts its node number. In
 * the daemon that is the same predicate as `isLocalKey`: the daemon's own
 * node number or any registered agent key, since host and guest formula
 * identifiers carry their agent's node number.
 *
 * The identifier is validated and its node checked before
 * `provideLocalFormula` runs, so the miss guarantee does not depend on the
 * provider's own validation (the daemon's `localGateway.provide` repeats
 * these checks, but throws distinguishable errors that this wrapper folds).
 *
 * @param {object} options
 * @param {(id: FormulaIdentifier) => Promise<unknown>} options.provideLocalFormula
 *   Incarnates a local formula. Every rejection becomes a miss.
 * @param {(node: NodeNumber) => boolean} options.isLocalNode
 *   Whether a node number names this daemon or one of its agents. A
 *   throw is a miss.
 * @param {Pick<Console, 'error'>} [options.logger]
 *   Receives the error class (never the message, which may echo the
 *   bearer identifier) of each miss. Defaults to `console`.
 * @returns {FormulaNonceLocator}
 */
export const makeFormulaNonceLocator = ({
  provideLocalFormula,
  isLocalNode,
  logger = console,
}) => {
  /**
   * @param {string | Uint8Array} secret The decoded Swiss number: a string
   *   for ASCII wire bytes, otherwise a `Uint8Array`, which always misses.
   * @returns {Promise<unknown>}
   */
  const get = async secret => {
    await null;
    try {
      if (typeof secret !== 'string') {
        return undefined;
      }
      assertValidId(secret);
      const { node, id } = parseId(secret);
      if (isLocalNode(node) !== true) {
        return undefined;
      }
      const value = await provideLocalFormula(id);
      assertCapability(value);
      return value;
    } catch (error) {
      try {
        logger.error(
          'formula nonce locator: presentation missed',
          errorClassName(error),
        );
      } catch {
        // A broken logger must not turn a miss into a distinct rejection.
      }
      return undefined;
    }
  };
  return harden({ get });
};
harden(makeFormulaNonceLocator);
