// @ts-check
/// <reference types="ses" />

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { makeError } from '@endo/errors';
import { assertValidId, parseId } from '../formula-identifier.js';

/**
 * @import { FormulaIdentifier, NodeNumber } from '../types.js'
 * @import { MakeLocatorForSession } from '@endo/ocapn/client/types'
 */

/**
 * The pairing `makeFormulaNonceLocator` returns. Its `get` is a
 * `NonceLocator` widened to the wire's `string | Uint8Array` secret (the
 * `bootstrap.fetch` path may hand raw bytes for a non-ASCII secret),
 * which a `string`-only `NonceLocator` typedef cannot express, so this is
 * a named local type rather than `NonceLocator & …`.
 *
 * @typedef {object} FormulaNonceLocator
 * @property {(secret: string | Uint8Array) => Promise<unknown>} get
 *   The shared formula adapter, usable directly as `makeOcapn`'s
 *   `locator`.
 * @property {MakeLocatorForSession} makeLocatorForSession
 *   The per-session factory for `makeOcapn`'s `makeLocatorForSession`
 *   hook.
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
 * The returned object is itself a plain shared `NonceLocator` (its `get`
 * is usable directly as `makeOcapn`'s `locator`). The returned
 * `makeLocatorForSession` is the per-session factory for `makeOcapn`'s
 * `makeLocatorForSession` hook: it wraps the shared `get` with a miss
 * counter scoped to one authenticated peer/connection. The wrapped
 * lookups are *serialized* per session — each presentation's outcome is
 * settled (and any miss counted) before the next begins — so a peer that
 * pipelines K probes cannot clear the gate before the first miss
 * resolves; the bound counts every settled miss, not a race against
 * transport teardown. Once the counter crosses `missBound` the session
 * locator both (a) refuses every further presentation outright — it stops
 * running the lookup, so no capability can be redeemed on that session
 * again regardless of how fast the transport tears down — and (b) calls
 * `abortSession` to sever the connection via the transport's generic
 * disconnect, naming nothing. Enforcement lives in the locator, not in
 * the speed of the disconnect.
 *
 * Non-oracularity is a property of each *individual* presentation below
 * the bound: any single miss reveals only that it yielded no capability,
 * never which class of failure it was. Crossing the bound severs the
 * session, and that severance is observable to the crossing peer — but it
 * discloses only that the peer exceeded the miss bound (which it already
 * knows, having made that many misses), never anything about any
 * identifier. The security property does not rest on the crossing miss
 * being byte-identical to a below-bound miss.
 *
 * The formula lookup stays shared; only the counter and the abort
 * decision are session-scoped, so one session crossing its bound cannot
 * affect any other peer's session.
 *
 * @param {object} options
 * @param {(id: FormulaIdentifier, localNodeNumber: NodeNumber) => Promise<unknown>} options.provideLocalFormula
 *   Reads the local formula table and incarnates the formula through the
 *   daemon's existing `provide` path. May reject (absent, collected,
 *   corrupt, failed-to-incarnate); the adapter folds every rejection
 *   into a miss.
 * @param {NodeNumber} options.localNodeNumber
 * @param {number} [options.missBound]
 * @param {Pick<Console, 'error'>} [options.logger]
 *   Where the adapter names, locally, why a presentation missed. The peer
 *   still sees one uniform miss; this only makes a silent daemon
 *   debuggable. Defaults to the ambient `console`.
 * @returns {FormulaNonceLocator}
 */
export const makeFormulaNonceLocator = ({
  provideLocalFormula,
  localNodeNumber,
  missBound = DEFAULT_MISS_BOUND,
  logger = console,
}) => {
  // Fail closed on a nonsensical bound: `misses >= NaN` and
  // `misses >= -1` are never true, so a `NaN`/negative/non-integer bound
  // would silently disable the guard rather than tighten it.
  if (!Number.isSafeInteger(missBound) || missBound < 1) {
    throw makeError(
      'makeFormulaNonceLocator: missBound must be a positive integer',
    );
  }
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
      // A canonical identifier is always an ASCII string; raw non-ASCII
      // wire bytes arrive as a `Uint8Array` and can never be one, so they
      // miss here. Narrowing to `string` up front lets the rest of the
      // body drop the casts `assertValidId`/`parseId` would otherwise
      // need.
      if (typeof secret !== 'string') {
        return undefined;
      }
      // `assertValidId` requires the canonical `{64hex}:{64hex}` form, so
      // an uppercased or wrong-length identifier, the old fixed
      // `endo-bootstrap` / `endo-peer-entry` names, and any other
      // noncanonical text all throw here and become the same miss.
      assertValidId(secret);
      const { node, id } = parseId(secret);
      if (node !== localNodeNumber) {
        // An identifier for another node is a miss, not a dial.
        return undefined;
      }
      const value = await provideLocalFormula(id, localNodeNumber);
      assertOcapnTarget(value);
      return value;
    } catch (error) {
      // Name the failing stage locally. Non-oracularity is owed to the
      // peer, which still sees one uniform miss; a silent daemon hides a
      // genuine internal defect (a `TypeError`, a `harden` failure) here
      // among the expected misses. Per authenticated session the volume
      // is bounded by the miss bound below.
      logger.error('formula nonce locator: presentation missed', error);
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
    // Serialize this session's lookups: each presentation's outcome — and
    // any miss it counts — is settled before the next begins. Without
    // this, a peer can pipeline K `fetch` frames that every one clears the
    // pre-lookup guard before the first miss increments the counter, so
    // the bound never bites (the frames are dispatched without awaiting
    // and the pump feeds the next immediately). The tail is kept
    // unrejectable so one thrown lookup cannot sever the chain for the
    // next presentation.
    let tail = Promise.resolve();
    /** @param {string | Uint8Array} secret */
    const sessionGet = secret => {
      const result = tail.then(async () => {
        // Every earlier presentation on this session has now settled, so
        // `aborted` reflects the true settled-miss count. Once the bound
        // is crossed, refuse every further presentation outright — no
        // lookup runs, so nothing can be redeemed on this session again
        // regardless of how fast the transport tears down.
        if (aborted) {
          return undefined;
        }
        const value = await get(secret);
        if (value === undefined) {
          misses += 1;
          if (misses >= missBound) {
            aborted = true;
            abortSession();
          }
          return undefined;
        }
        return value;
      });
      // `get` never throws, but guard the chain regardless.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    return harden({ get: sessionGet });
  };

  return harden({ get, makeLocatorForSession });
};
harden(makeFormulaNonceLocator);
