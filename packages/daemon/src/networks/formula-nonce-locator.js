// @ts-check
/// <reference types="ses" />

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { makeError } from '@endo/errors';
import { assertValidId, parseId } from '../formula-identifier.js';

/**
 * @import { FormulaIdentifier, NodeNumber } from '../types.js'
 * @import { SessionLocatorContext } from '@endo/ocapn/client/types'
 */

/**
 * The per-session factory `makeFormulaNonceLocator` returns for
 * `makeOcapn`'s `makeLocatorForSession` hook. Its result's `get` is
 * widened to the wire's `string | Uint8Array` secret (the incoming
 * `bootstrap.fetch` path may hand raw bytes for a non-ASCII secret),
 * which the `string`-keyed `NonceLocator` typedef cannot express — so the
 * return shape is spelled out here rather than borrowed from
 * `MakeLocatorForSession`. The widened `get` stays assignable to
 * `MakeLocatorForSession` by parameter contravariance, so this remains a
 * valid `makeOcapn` hook.
 *
 * @typedef {(context: SessionLocatorContext) => { get: (secret: string | Uint8Array) => Promise<unknown> }} MakeSessionFormulaLocator
 */

/**
 * The pairing `makeFormulaNonceLocator` returns. Its `get` is a
 * `NonceLocator` widened to the wire's `string | Uint8Array` secret (the
 * `bootstrap.fetch` path may hand raw bytes for a non-ASCII secret),
 * which a `string`-only `NonceLocator` typedef cannot express, so this is
 * a named local type rather than `NonceLocator & ...`.
 *
 * @typedef {object} FormulaNonceLocator
 * @property {(secret: string | Uint8Array) => Promise<unknown>} get
 *   The shared, **unbounded** formula adapter. It carries no miss counter
 *   and no abort, so it is safe as `makeOcapn`'s `locator` **only** for
 *   the outgoing, self-local `enlivenSturdyRef` path (resolving your own
 *   node's sturdyrefs). It is **not** safe as the sole `locator` for
 *   *incoming* peer `bootstrap.fetch`: used that way it hands every
 *   authenticated (and, depending on the netlayer, unauthenticated) peer
 *   an unlimited, un-torn-down formula-identifier probing surface. For
 *   incoming peer traffic, always pair it with `makeLocatorForSession`
 *   (below), which is what applies the per-peer miss bound and abort.
 * @property {MakeSessionFormulaLocator} makeLocatorForSession
 *   The per-session factory for `makeOcapn`'s `makeLocatorForSession`
 *   hook; its session locator's `get` carries the same widened
 *   `string | Uint8Array` secret the shared `get` does. This is the
 *   member that makes the mechanism non-inert against a probing peer.
 *   Note it refuses every well-known swissnum *word* (e.g.
 *   `endo-peer-entry`) by construction — see the well-known-swissnum note
 *   on {@link makeFormulaNonceLocator} — so a deployment that keeps a
 *   live well-known swissnum must compose, not replace.
 */

// How many failed presentations one authenticated session may make
// before it is torn down. The bound exists to stop a session from
// walking the (unguessably large) formula-identifier space; a peer that
// holds a valid identifier presents it and hits, so it never
// accumulates misses. Chosen small: a legitimate client that has the
// nonce does not miss, and a prober learns nothing from any single
// presentation, so a tight bound costs an honest *serial* peer nothing.
// The one liveness cost a tight bound *can* impose falls only on a peer
// that pipelines more than `missBound` presentations at once: the
// in-flight admission gate (see the `misses + inFlight >= missBound`
// term below) may refuse one such concurrent presentation as a miss
// without aborting the session. That is a bounded, retryable cost a
// high-concurrency peer pays, never a security relaxation — a peer that
// simply awaits each presentation before the next never encounters it.
const DEFAULT_MISS_BOUND = 16;

/**
 * Assert `value` is a capability this locator is willing to serve. This
 * endpoint deliberately serves *only capabilities*: a remotable, or
 * nothing. That is a **policy** of this locator, not a protocol
 * constraint — OCapN's `bootstrap.fetch` can carry any `OcapnPassable`,
 * so a formula that incarnates to data (a copyRecord, a `SturdyRef`,
 * which is a `makeTagged` value, a primitive) would be perfectly
 * exportable on the wire; we simply choose not to hand out anything but a
 * capability here, so those are treated as a miss rather than surfacing a
 * distinguishable error. We test with `@endo/pass-style`'s `passStyleOf`
 * rather than OCapN's `ocapnPassStyleOf` on purpose: the question is not
 * "can OCapN export this?" (it can) but "is this a bare remotable
 * capability?", and `passStyleOf` answers exactly that. `passStyleOf`
 * itself throws on a non-passable, which the caller's catch likewise
 * folds into a miss.
 *
 * @param {unknown} value
 */
const assertCapability = value => {
  if (passStyleOf(value) !== 'remotable') {
    throw makeError('Formula did not incarnate to a capability');
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
 * This is the reusable mechanism (the `@endo/daemon` side) of the nonce
 * locator described in `designs/daemon-ocapn-external-connectivity.md`
 * § 2, not the minion.town deployment.
 *
 * The single security property this enforces is non-oracularity: a
 * presentation that yields no capability reveals only that it yielded no
 * capability. Malformed ASCII, noncanonical form, an identifier for
 * another node, an absent / collected / corrupt formula, a value that
 * does not incarnate to a capability (see {@link assertCapability}: a
 * policy of this locator, not a protocol limit), and an incarnation that
 * throws are all the same miss. The adapter never throws and never returns a
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
 * The returned object's shared `get` is a plain `NonceLocator`, but it is
 * **unbounded**: it carries no miss counter and no abort. Passing it alone
 * as `makeOcapn`'s `locator` is safe **only** for the outgoing, self-local
 * `enlivenSturdyRef` path; as the sole locator for *incoming* peer
 * `bootstrap.fetch` it is the one inert configuration — an unlimited,
 * un-torn-down probing surface with nothing flagging it. The bound and the
 * abort live entirely in the per-session locator, so for incoming peer
 * traffic the shared `get` must be **paired** with `makeLocatorForSession`
 * (the historical single-`locator` wiring is inert against a prober). The
 * returned `makeLocatorForSession` is the per-session factory for
 * `makeOcapn`'s `makeLocatorForSession` hook: it wraps the shared `get`
 * with a miss counter scoped to one authenticated peer/connection.
 *
 * Well-known swissnums (a fixed *word* like `endo-peer-entry`, not a
 * formula identifier) are refused by construction — every non-formula
 * presentation is a uniform miss — so this mechanism cannot itself serve
 * the daemon's live well-known peer-entry swissnum, and the per-session
 * locator, being the `locator` for incoming fetches, would displace any
 * plain `locator` that does. A deployment that retains a well-known
 * swissnum (see `designs/daemon-ocapn-external-connectivity.md` §2 and
 * `networks/ocapn.js`'s `PEER_ENTRY_SWISSNUM`) must therefore **compose**:
 * route the fixed well-known swissnum(s) through a thin outer locator that
 * delegates everything else to this formula locator, rather than replacing
 * its locator with this one wholesale, or migrate the peer-entry exo onto
 * a formula identifier. This mechanism deliberately carries no well-known
 * branch of its own; that composition is the embedder's responsibility. Only *misses* are
 * ordered against the bound — hits are never serialized behind one
 * another. A synchronous in-flight counter is incremented at entry, and a
 * presentation is refused outright (no lookup runs) once
 * `misses + inFlight >= missBound`. That caps the presentations a session
 * can have in flight at `missBound`, so a peer that pipelines K probes
 * cannot clear the gate before the earlier lookups settle: the bound
 * counts every settled miss, never a race against transport teardown. It
 * also means one non-settling lookup can no longer wedge the whole
 * session — it holds a single in-flight slot, it does not block every
 * later presentation behind one pending tail. Once `missBound` misses
 * have *settled* the session locator both (a) latches closed — every
 * further presentation is refused synchronously without running the
 * lookup, so no capability can be redeemed on that session again
 * regardless of how fast the transport tears down — and (b) calls
 * `abortSession` to sever the connection via the transport's generic
 * disconnect, naming nothing. A throwing embedder `abortSession` is
 * caught and logged locally, never propagated to the crossing peer (which
 * still sees one uniform miss). Enforcement lives in the locator, not in
 * the speed of the disconnect.
 *
 * The in-flight cap can, under `missBound` genuinely-concurrent in-flight
 * presentations, refuse (miss) an otherwise-valid id without aborting the
 * session; that is a bounded liveness cost a high-concurrency peer pays,
 * never a security relaxation, and it does not count as a miss toward the
 * bound.
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
  // A throwing embedder `logger` must never become an oracle. If
  // `logger.error` threw where the miss path calls it, the rejection would
  // escape `get` as a distinct error — a distinguishable failure the peer
  // could observe — and, worse, the miss would never be counted (the
  // `misses += 1` below the `await get(...)` would be skipped), silently
  // disarming the session bound. Route every diagnostic through a wrapper
  // that swallows a broken logger, so what the peer observes never depends
  // on the logger behaving.
  /** @param {...unknown} args */
  const logError = (...args) => {
    try {
      logger.error(...args);
    } catch {
      // A broken logger must not change what the peer observes, nor whether
      // a miss counts; there is nowhere safe left to report the failure.
    }
  };
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
      // an uppercased or wrong-length identifier, and well-known swissnum
      // *words* like `endo-bootstrap` or `endo-peer-entry` — the latter is
      // a live well-known peer-entry swissnum used elsewhere (see
      // `ocapn.js`'s `PEER_ENTRY_SWISSNUM`), but it is not a *formula
      // identifier*, so this formula locator never resolves it — and any
      // other noncanonical text all throw here and become the same miss.
      assertValidId(secret);
      const { node, id } = parseId(secret);
      if (node !== localNodeNumber) {
        // An identifier for another node is a miss, not a dial.
        return undefined;
      }
      const value = await provideLocalFormula(id, localNodeNumber);
      assertCapability(value);
      return value;
    } catch (error) {
      // Name only the error *class* locally, never the caught message.
      // Non-oracularity is owed to the peer, which still sees one uniform
      // miss; a silent daemon hides a genuine internal defect (a
      // `TypeError`, a `harden` failure) among the expected misses, and
      // the error name preserves that signal. The message must NOT be
      // logged: a valid, live identifier that misses transiently (a
      // `provide` that throws with the id in its message, an
      // `assertValidId` echo) would otherwise land that bearer nonce in
      // the daemon log. Per authenticated session the volume is bounded by
      // the miss bound below.
      logError(
        'formula nonce locator: presentation missed',
        error instanceof Error ? error.name : 'Error',
      );
      return undefined;
    }
  };

  // Each authenticated session gets its own miss counter, so one peer's
  // probing cannot influence any other peer's session. The context also
  // carries `remoteDesignator`, but that is only the peer's *claimed*
  // designator unless the netlayer authenticates it, so an embedder that
  // wants to aggregate misses across a peer's reconnections should key on
  // the session's handshake-verified `context.peerPublicKey` rather than on
  // `remoteDesignator` (see `SessionLocatorContext`). The shared formula
  // lookup stays common;
  // only the counter and the abort decision are session-scoped.
  /** @type {MakeSessionFormulaLocator} */
  const makeLocatorForSession = context => {
    const { abortSession } = context;
    let misses = 0;
    // Presentations whose outcome has not yet settled. Counting these at
    // the synchronous admission gate is what makes ordering only *misses*
    // sufficient: a pipelined burst cannot clear the gate before the
    // earlier lookups settle, yet a hit never waits behind another
    // presentation.
    let inFlight = 0;
    let aborted = false;
    // Sever this session at most once. A throwing embedder `abortSession`
    // must not become an oracle: it is caught and logged locally, never
    // propagated to the crossing presentation (which stays one uniform
    // miss). `sessionGet` guards `abortSession`, not just the miss counter,
    // precisely so a throw here cannot reach `bootstrap.fetch`.
    const abortSessionOnce = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      try {
        abortSession();
      } catch (error) {
        logError(
          'formula nonce locator: abortSession threw',
          error instanceof Error ? error.name : 'Error',
        );
      }
    };
    /**
     * @param {string | Uint8Array} secret
     * @returns {Promise<unknown>}
     */
    const sessionGet = secret => {
      // Synchronous admission gate. Once the session has latched closed, or
      // once the settled misses plus the presentations still in flight
      // would reach the bound, refuse outright: run no lookup, so nothing
      // can be redeemed on this session regardless of transport-teardown
      // timing. The `inFlight` term is what a pipelined burst cannot
      // outrun; ordering only misses (never hits) is enough.
      if (aborted || misses + inFlight >= missBound) {
        return Promise.resolve(undefined);
      }
      inFlight += 1;
      // `get` never throws, but the `finally` keeps `inFlight` honest even
      // if it somehow did.
      return (async () => {
        await null;
        try {
          const value = await get(secret);
          if (value === undefined) {
            misses += 1;
            if (misses >= missBound) {
              abortSessionOnce();
            }
          }
          return value;
        } finally {
          inFlight -= 1;
        }
      })();
    };
    return harden({ get: sessionGet });
  };

  return harden({ get, makeLocatorForSession });
};
harden(makeFormulaNonceLocator);
