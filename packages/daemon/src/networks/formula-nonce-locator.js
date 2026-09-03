// @ts-check
/// <ref types="ses">

// spell-out-exempt: swissNum spells the OCapN "Swiss number" domain term.

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { makeError } from '@endo/errors';
import { assertValidId, parseId } from '../formula-identifier.js';

/**
 * @import { FormulaIdentifier, NodeNumber } from '../types.js'
 * @import { MakeLocatorForSession, NonceLocator } from '@endo/ocapn/client/types'
 */

// How many failed presentations one authenticated session may make
// before it is torn down. The bound exists to stop a session from
// walking the (unguessably large) formula-identifier space; a peer that
// holds a valid identifier presents it and hits, so it never
// accumulates misses. Chosen small: a legitimate client that has the
// nonce does not miss, and a prober learns nothing from any single
// presentation, so a tight bound costs honest peers nothing.
const DEFAULT_MISS_BOUND = 16;

/**
 * Assert `value` is something OCapN can export as a capability. Only a
 * remotable qualifies; a formula that incarnates to data, a primitive,
 * or any other non-remotable passable is "non-exportable" and must be
 * treated as a miss rather than surfacing a distinguishable error.
 * `passStyleOf` itself throws on a non-passable, which the caller's
 * catch likewise folds into a miss.
 *
 * @param {unknown} value
 */
const assertOcapnTarget = value => {
  if (passStyleOf(value) !== 'remotable') {
    throw makeError('Formula did not incarnate to an OCapN target');
  }
};

/**
 * The adapter between `@endo/ocapn`'s injected-locator seam and
 * `@endo/daemon`'s formula-provide seam. It turns a bearer formula
 * identifier — presented on the wire as an OCapN Swiss number, the
 * canonical ASCII bytes of the `FormulaIdentifier` — into exactly that
 * formula's incarnated capability, and turns *every* way that can fail
 * into one indistinguishable miss.
 *
 * The single security property this enforces is non-oracularity: a
 * presentation that yields no capability reveals only that it yielded no
 * capability. Malformed ASCII, noncanonical form, an identifier for
 * another node, an absent / collected / corrupt formula, a value that
 * does not incarnate to an OCapN target, and an incarnation that throws
 * are all the same miss. The adapter never throws and never returns a
 * distinct sentinel; it returns `undefined`, which the OCapN bootstrap
 * turns into one fixed `secret not found` rejection. It never echoes the
 * identifier, the node, the formula type, the lookup stage, or the
 * underlying exception.
 *
 * Because possession of an unguessable 256-bit formula identifier is
 * itself the authority to obtain that formula's capability, this is
 * attenuation by designation, not a bootstrap in disguise: the only
 * daemon-specific operation is equality-free presentation of a bearer
 * nonce. Foreign-node identifiers are a miss, never a peer dial — this
 * endpoint only ever discloses local formulas.
 *
 * The returned `get` is a plain shared `NonceLocator` (usable directly
 * as `makeOcapn`'s `locator`). The returned `makeLocatorForSession` is
 * the per-session factory for `makeOcapn`'s `makeLocatorForSession`
 * hook: it wraps the shared `get` with a miss counter scoped to one
 * authenticated peer/connection and tears that session down (via the
 * transport's generic disconnect, naming nothing) once the counter
 * crosses `missBound`. The formula lookup stays shared; only the
 * counter and the abort decision are session-scoped, so one session
 * crossing its bound cannot affect any other peer's session.
 *
 * @param {object} options
 * @param {(id: FormulaIdentifier, localNodeNumber: NodeNumber) => Promise<unknown>} options.provideLocalFormula
 *   Reads the local formula table and incarnates the formula through the
 *   daemon's existing `provide` path. May reject (absent, collected,
 *   corrupt, failed-to-incarnate); the adapter folds every rejection
 *   into a miss.
 * @param {string} options.localNodeNumber
 * @param {number} [options.missBound]
 * @returns {NonceLocator & { makeLocatorForSession: MakeLocatorForSession }}
 */
export const makeFormulaNonceLocator = ({
  provideLocalFormula,
  localNodeNumber,
  missBound = DEFAULT_MISS_BOUND,
}) => {
  /**
   * The shared formula adapter. `secret` is whatever the OCapN bootstrap
   * decoded from the Swiss number: the canonical ASCII identifier as a
   * string, or (for non-ASCII wire bytes) a `Uint8Array`. Only a
   * canonical ASCII `FormulaIdentifier` string can hit; everything else
   * misses.
   *
   * @param {string | Uint8Array} secret
   * @returns {Promise<unknown>}
   */
  const get = async secret => {
    await null;
    try {
      // `assertValidId` requires a string in canonical
      // `{64hex}:{64hex}` form, so a `Uint8Array`, an uppercased or
      // wrong-length identifier, the old fixed `endo-bootstrap` /
      // `endo-peer-entry` names, and any other noncanonical text all
      // throw here and become the same miss.
      assertValidId(/** @type {string} */ (secret));
      const { node, id } = parseId(/** @type {string} */ (secret));
      if (node !== localNodeNumber) {
        // An identifier for another node is a miss, not a dial.
        return undefined;
      }
      const value = await provideLocalFormula(
        id,
        /** @type {NodeNumber} */ (localNodeNumber),
      );
      assertOcapnTarget(value);
      return value;
    } catch {
      return undefined;
    }
  };

  // Each authenticated session gets its own miss counter, so one
  // peer's probing cannot influence any other peer's session. The
  // context also carries `remoteDesignator` for an embedder that wants
  // to aggregate misses across a peer's reconnections; the shared
  // formula lookup stays common, only the counter is session-scoped.
  /** @type {MakeLocatorForSession} */
  const makeLocatorForSession = context => {
    const { abortSession } = context;
    let misses = 0;
    let aborted = false;
    /** @param {string} secret */
    const sessionGet = async secret => {
      await null;
      const value = await get(secret);
      if (value === undefined) {
        misses += 1;
        if (!aborted && misses >= missBound) {
          aborted = true;
          abortSession();
        }
        return undefined;
      }
      return value;
    };
    return harden({ get: sessionGet });
  };

  return harden({ get, makeLocatorForSession });
};
harden(makeFormulaNonceLocator);
