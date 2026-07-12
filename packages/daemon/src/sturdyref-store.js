// @ts-check

/**
 * The daemon's SturdyRef EXPORT surface: the durable swiss-num store and the
 * exporter that mints, serves, lists, and revokes wire-tier SturdyRefs
 * (design cut 3, "daemon as C"; see
 * designs/sturdy-refs-cross-peer-bridge.md § "Mint and export").
 *
 * A daemon exports a wire-tier SturdyRef by binding a fresh secret to a
 * formula identifier in a durable, daemon-private table (the
 * `sturdyref-store`). The store read side is the `locator` the daemon's
 * OCapN client dials for `bootstrap.fetch(swissNum)`; the exported SturdyRef
 * is constructed through `@endo/ocapn`'s session-manager tracker so its
 * `(location, swissNum)` details are held off-band and the codec can
 * serialize it later. This module holds no networking; the placeholder
 * self-location it stamps into mints is replaced by the real self
 * peer-locator in cut 4 (the `ocapn` singleton).
 */

/** @import { FormulaIdentifier, MakeSha256, SturdyRefGrant, SturdyRefStore } from './types.js' */
/** @import { OcapnLocation } from '@endo/ocapn' */
/** @import { SturdyRef } from '@endo/pass-style' */

import { makeError, X } from '@endo/errors';
import { makeSturdyRefTracker } from '@endo/ocapn';

const { entries } = Object;

/**
 * @typedef {object} SturdyRefRow
 * @property {FormulaIdentifier} formulaIdentifier - the local formula the
 *   swiss-num resolves to.
 * @property {number} mintedAt - mint date (epoch milliseconds).
 * @property {string} grantHandle - the SHA-256 hash of the swiss-num, which
 *   names the grant for listing and revocation without conferring it.
 * @property {string} [type] - an optional advisory type hint (local-only;
 *   the Syrup wire form cannot carry it).
 */

/**
 * The durable swiss-num store: a JSON blob of `swissNum -> SturdyRefRow`
 * persisted in the daemon's key/value state under `stateKey` (the store's
 * formula number). The blob is daemon-private; it is never handed to a
 * worker or guest. Keying rows by the swiss-num keeps the serve path a
 * direct `rows[secret]` lookup, exactly the row the design's `locator.get`
 * consults; the grant handle is stored alongside so listing and revocation
 * never need the secret.
 *
 * @param {object} powers
 * @param {(key: string) => string | undefined} powers.getState
 * @param {(key: string, value: string) => void} powers.setState
 * @param {string} powers.stateKey
 * @param {MakeSha256} powers.makeSha256
 * @returns {SturdyRefStore}
 */
export const makeSturdyRefStore = ({
  getState,
  setState,
  stateKey,
  makeSha256,
}) => {
  /** @returns {Record<string, SturdyRefRow>} */
  const load = () => {
    const text = getState(stateKey);
    return text === undefined ? {} : JSON.parse(text);
  };
  /** @param {Record<string, SturdyRefRow>} rows */
  const save = rows => setState(stateKey, JSON.stringify(rows));

  /** @param {string} swissNum */
  const grantHandleFor = swissNum => {
    const digester = makeSha256();
    digester.updateText(swissNum);
    return digester.digestHex();
  };

  /** @type {SturdyRefStore['mint']} */
  const mint = (swissNum, formulaIdentifier, mintedAt, type) => {
    const rows = load();
    const grantHandle = grantHandleFor(swissNum);
    /** @type {SturdyRefRow} */
    const row = {
      formulaIdentifier,
      mintedAt,
      grantHandle,
    };
    if (type !== undefined) {
      row.type = type;
    }
    rows[swissNum] = row;
    save(rows);
    return grantHandle;
  };

  /** @type {SturdyRefStore['getBySwissNum']} */
  const getBySwissNum = swissNum => {
    const row = load()[swissNum];
    return row === undefined ? undefined : row.formulaIdentifier;
  };

  /** @type {SturdyRefStore['list']} */
  const list = () =>
    entries(load()).map(([, row]) => {
      /** @type {SturdyRefGrant} */
      const grant = {
        grantHandle: row.grantHandle,
        formulaIdentifier: row.formulaIdentifier,
        mintedAt: row.mintedAt,
      };
      if (row.type !== undefined) {
        grant.type = row.type;
      }
      return harden(grant);
    });

  /** @type {SturdyRefStore['revokeByHandle']} */
  const revokeByHandle = grantHandle => {
    const rows = load();
    let removed = false;
    for (const [swissNum, row] of entries(rows)) {
      if (row.grantHandle === grantHandle) {
        delete rows[swissNum];
        removed = true;
      }
    }
    if (removed) {
      save(rows);
    }
    return removed;
  };

  return harden({ mint, getBySwissNum, list, revokeByHandle });
};
harden(makeSturdyRefStore);

/**
 * @typedef {object} SturdyRefExporter
 * @property {{ get(secret: string | Uint8Array): Promise<unknown> }} locator
 *   The store read side injected into the daemon's OCapN client: a peer's
 *   `bootstrap.fetch(swissNum)` resolves through `locator.get(secret)`.
 * @property {(formulaIdentifier: FormulaIdentifier, type?: string) => Promise<{ sturdyRef: SturdyRef, grantHandle: string }>} mintGrant
 *   Mint a fresh grant for a local formula identifier. Returns the wire-tier
 *   SturdyRef — constructed through the OCapN session-manager tracker so its
 *   `(location, swissNum)` details are held off-band for the wire codec (cut
 *   4+) — together with the grant handle that names it for listing and
 *   revocation. The SturdyRef object stays daemon-side; the handle is the
 *   marshalable management reference surfaced to a host client.
 * @property {() => SturdyRefGrant[]} listGrants
 * @property {(grantHandle: string) => boolean} revokeGrant
 * @property {(sturdyRef: SturdyRef) => ({ location: OcapnLocation, secret: string | Uint8Array } | undefined)} reveal
 *   The closely-held reveal side: the off-band `(location, swissNum)` of a
 *   SturdyRef this exporter minted, or `undefined` for anything else.
 * @property {(location: OcapnLocation, secret: string | Uint8Array, type?: string) => SturdyRef} materialize
 *   Materialize a foreign SturdyRef from `(location, secret)` through this
 *   exporter's session-manager tracker, so its off-band details are held and
 *   `reveal` answers for it. Used by the out-of-band `acceptSturdyRefUri`
 *   accept path (design cut 5) — the URI carries `(location, swissNum)` and a
 *   SturdyRef object must exist for the seam to internalize. The secret stays
 *   off-band; the returned object carries no secret property.
 * @property {(sturdyRef: SturdyRef) => Promise<unknown>} enlivenSelf
 *   Serve a self-minted SturdyRef in-process (the one-process equivalent of
 *   a peer's `fetch`): reveal, confirm the self-location, then resolve the
 *   swiss-num through the store-backed locator. Rejects secret-free when the
 *   grant was never minted here or has been revoked.
 */

/**
 * Build the daemon's SturdyRef exporter over a swiss-num store. Minting draws
 * a fresh 256-bit swiss-num, writes the store row, and constructs the SturdyRef
 * through `@endo/ocapn`'s session-manager tracker so the session manager holds
 * the `(location, swissNum)` details off-band; the store-backed `locator`
 * serves fetches by that swiss-num.
 *
 * @param {object} powers
 * @param {SturdyRefStore} powers.store
 * @param {() => Promise<string>} powers.randomHex256 - the fresh-swiss-num
 *   source (the daemon's `randomHex256` randomness discipline).
 * @param {OcapnLocation} powers.selfLocation - the daemon's self peer-locator
 *   stamped into every mint. A placeholder in cut 3; replaced by the real
 *   self-location in cut 4.
 * @param {(id: FormulaIdentifier) => Promise<unknown>} powers.provide - the
 *   daemon-core `provide`, turning a formula identifier into its value.
 * @returns {SturdyRefExporter}
 */
export const makeSturdyRefExporter = ({
  store,
  randomHex256,
  selfLocation,
  provide,
}) => {
  /**
   * The store read side. A peer's `bootstrap.fetch(swissNum)` — and the
   * in-process `enlivenSelf` path — resolve through here: look up the row and
   * provide the bound formula. A miss (never minted, or revoked) returns
   * `undefined`, which the caller turns into a secret-free rejection.
   */
  const locator = harden({
    /** @param {string | Uint8Array} secret */
    get: async secret => {
      // Our own mints key the store by the hex-string swiss-num; a raw-byte
      // secret (a foreign implementation's swiss-num) has no self-minted row.
      if (typeof secret !== 'string') {
        return undefined;
      }
      const formulaIdentifier = store.getBySwissNum(secret);
      if (formulaIdentifier === undefined) {
        return undefined;
      }
      return provide(formulaIdentifier);
    },
  });

  // One session-manager tracker for this exporter: its `makeSturdyRef` holds
  // the off-band details and `reveal` answers only for this exporter's mints.
  const tracker = makeSturdyRefTracker(locator);

  // A minted SturdyRef stamps `selfLocation` verbatim, so a reveal returns the
  // same frozen record and self-recognition is identity. Cut 4 replaces this
  // placeholder with the real self peer-locator and a locator-id comparison.
  /** @param {OcapnLocation} location */
  const isSelfLocation = location => location === selfLocation;

  /** @type {SturdyRefExporter['mintGrant']} */
  const mintGrant = async (formulaIdentifier, type) => {
    const swissNum = await randomHex256();
    const mintedAt = Date.now();
    const grantHandle = store.mint(swissNum, formulaIdentifier, mintedAt, type);
    const sturdyRef = tracker.makeSturdyRef(selfLocation, swissNum, type);
    return harden({ sturdyRef, grantHandle });
  };

  /** @type {SturdyRefExporter['enlivenSelf']} */
  const enlivenSelf = async sturdyRef => {
    const details = tracker.reveal(sturdyRef);
    if (details === undefined || !isSelfLocation(details.location)) {
      // Deliberately secret-free: this rejection may ride up into logs or a
      // peer-visible abort, and the swiss-num is the long-lived authority.
      throw makeError(
        X`ocapn: cannot enliven a sturdyref not minted by this daemon`,
      );
    }
    const value = await locator.get(details.secret);
    if (value === undefined) {
      // Revoked, or never minted: indistinguishable by design, and never
      // naming the swiss-num.
      throw makeError(X`ocapn: locator has no capability for sturdyref secret`);
    }
    return value;
  };

  /** @type {SturdyRefExporter['materialize']} */
  const materialize = (location, secret, type) =>
    tracker.makeSturdyRef(location, secret, type);

  return harden({
    locator,
    mintGrant,
    listGrants: () => store.list(),
    revokeGrant: grantHandle => store.revokeByHandle(grantHandle),
    reveal: sturdyRef => tracker.reveal(sturdyRef),
    materialize,
    enlivenSelf,
  });
};
harden(makeSturdyRefExporter);
