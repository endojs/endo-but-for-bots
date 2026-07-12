// @ts-check

/**
 * Foreign-SturdyRef internalization at the facet seam (design cut 5, "daemon
 * as B"; see designs/sturdy-refs-cross-peer-bridge.md § 2, "Foreign-locator
 * internalization").
 *
 * PR #541's facet seam resolves a SturdyRef this daemon minted (its off-band
 * `sturdyRefToId` map) and REJECTS anything else. This module supplies the
 * fallback that replaces that rejection: a SturdyRef whose peer locator names
 * a foreign peer resolves through the closely-held OCapN capability to a local
 * `ocapn-sturdyref` formula identifier, which denotes "the object the peer at
 * `location` serves for `swissNum`" and re-enlivens on demand.
 *
 * The pipeline (mirroring the design's flowchart):
 *
 *   reveal has details?  no  -> undefined (the seam then rejects: forged
 *                               look-alike, or a foreign-instance mint this
 *                               daemon never materialized)
 *                        yes ->
 *     location is self?  yes -> the swiss-num store's local formula id
 *                              (a self-mint arriving back over the wire)
 *                        no  -> the dedup index's existing id, or a freshly
 *                               formulated ocapn-sturdyref (over a deduped
 *                               ocapn-peer), recorded in the index
 *
 * Formulation is durable but enlivenment is NOT: this module never dials. The
 * `ocapn-sturdyref` formula's VALUE (a live presence) is produced lazily by
 * its formula maker on the next `provide`, so holding the inert box retains
 * nothing at either peer (PR #541's discipline). A failed dial or a revoked
 * grant therefore surfaces at use, never here.
 *
 * Confinement: this whole path runs daemon-side. It hands back only a formula
 * identifier; the `(location, secret)` it reveals stays in daemon-private
 * state (the formula body and this module's locals), and the resulting
 * presence reaches a worker or guest only as a daemon-local proxy. A confined
 * guest can neither dial nor learn a locator through anything it holds (the
 * no-location invariant).
 */

/** @import { FormulaIdentifier, KnownSturdyRefsStore, SturdyRefStore } from './types.js' */
/** @import { OcapnLocation } from '@endo/ocapn' */

import { makeError, X } from '@endo/errors';

/**
 * Build the daemon's foreign-SturdyRef internalizer.
 *
 * @param {object} powers
 * @param {(sturdyRef: unknown) => ({ location: OcapnLocation, secret: string | Uint8Array } | undefined)} powers.reveal
 *   The closely-held reveal: the off-band `(location, swissNum)` of a
 *   SturdyRef this daemon minted or materialized from the wire (an OCapN
 *   session or an `ocapn://` URI), or `undefined` for anything this daemon
 *   never constructed (a forged look-alike, or a foreign-instance mint).
 * @param {() => OcapnLocation} powers.getSelfLocation - the daemon's self
 *   peer-locator, to recognize a self-mint that arrived back over the wire.
 * @param {(location: OcapnLocation) => string} powers.locationToLocationId -
 *   the OCapN location→id function (byte-independent of the secret), the dedup
 *   index's peer key and half its sturdyref key.
 * @param {SturdyRefStore} powers.store - the swiss-num store, consulted on the
 *   self-location branch to recover the local formula id.
 * @param {KnownSturdyRefsStore} powers.knownSturdyRefs - the dedup index.
 * @param {(location: OcapnLocation) => Promise<FormulaIdentifier>} powers.formulateOcapnPeer
 *   Formulate (lazily, without dialing) the `ocapn-peer` for a foreign peer
 *   identity.
 * @param {(ocapnPeerId: FormulaIdentifier, swissNum: string | Uint8Array) => Promise<FormulaIdentifier>} powers.formulateOcapnSturdyRef
 *   Formulate (lazily, without enlivening) the `ocapn-sturdyref` over a peer.
 * @returns {(sturdyRef: unknown) => Promise<FormulaIdentifier | undefined>}
 */
export const makeForeignSturdyRefInternalizer = ({
  reveal,
  getSelfLocation,
  locationToLocationId,
  store,
  knownSturdyRefs,
  formulateOcapnPeer,
  formulateOcapnSturdyRef,
}) => {
  const selfLocationId = () => locationToLocationId(getSelfLocation());

  /**
   * @param {unknown} sturdyRef
   * @returns {Promise<FormulaIdentifier | undefined>}
   */
  const internalizeForeignSturdyRef = async sturdyRef => {
    await null;
    const details = reveal(sturdyRef);
    if (details === undefined) {
      // Not revealable by this daemon: never minted or materialized here.
      // The seam turns this into its forged-look-alike rejection.
      return undefined;
    }
    const { location, secret } = details;
    const locationId = locationToLocationId(location);

    // A self-mint that came back over the wire: resolve it through the
    // swiss-num store rather than dialing ourselves. `secret` is the hex
    // swiss-num the store keys on.
    if (locationId === selfLocationId()) {
      // Self-mints key the store by their hex-string swiss-num; a non-string
      // (raw-byte) secret is never a self-mint, so it has no self row.
      const localId =
        typeof secret === 'string' ? store.getBySwissNum(secret) : undefined;
      if (localId === undefined) {
        // Revoked, or minted by a since-restarted incarnation with a lost
        // row: never naming the swiss-num (the #521 secret-free discipline).
        throw makeError(
          X`ocapn: this daemon's swiss-num store has no capability for the sturdyref`,
        );
      }
      return localId;
    }

    // Foreign: dedup on `(locationId, sha256(swissNum))`.
    const existing = knownSturdyRefs.getSturdyRef(locationId, secret);
    if (existing !== undefined) {
      return existing;
    }

    // Dedup the peer layer too (same-peer rule: one ocapn-peer per identity),
    // so every ocapn-sturdyref at this peer shares one session/context.
    let ocapnPeerId = knownSturdyRefs.getPeer(locationId);
    if (ocapnPeerId === undefined) {
      ocapnPeerId = await formulateOcapnPeer(location);
      knownSturdyRefs.setPeer(locationId, ocapnPeerId);
    }

    const ocapnSturdyRefId = await formulateOcapnSturdyRef(ocapnPeerId, secret);
    knownSturdyRefs.setSturdyRef(locationId, secret, ocapnSturdyRefId);
    return ocapnSturdyRefId;
  };
  return harden(internalizeForeignSturdyRef);
};
harden(makeForeignSturdyRefInternalizer);
