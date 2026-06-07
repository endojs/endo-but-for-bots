// @ts-check

/**
 * In-memory CAS store helper.
 *
 * The CAS is the underlying eviction surface for content-addressed
 * cache growth; consumers sit on top of the CAS via the `CasStore`
 * interface. This module's `makeMemoryCasStore` is the reference
 * implementation suitable for tests. Persistent storage (the
 * daemon-side `store-sha256` tree the `daemon-persistence-powers`
 * module manages) implements the same surface; a future
 * `@endo/git-cas` implements it on top of git's object store.
 *
 * Retention links are passed in explicitly so the caller's
 * dependency-tracker (typically a formula graph) keeps the pin
 * lifecycle as its concern; this keeps the CAS package agnostic about
 * how its consumers wire pinning.
 *
 * SHA-256 itself is also passed in explicitly: this module does not
 * bind to a platform-specific crypto primitive. Callers wire in a
 * `sha256` power from a companion module (for example
 * `sha256HexWebCrypto` from `./store-web-powers.js`), mirroring the
 * daemon's `daemon-node-powers.js` vs `daemon-go-powers.js` split.
 *
 * @import { CasStore, RetentionLinks, Sha256Hex } from '../types.js';
 */

import { makeError, X } from '@endo/errors';

/**
 * Default retention-link implementation: tracks pins in a `Set`.
 *
 * The daemon-integrated implementation backs this with the formula
 * graph's `thisDiesIfThatDies` primitive; for the reference store
 * the Set is sufficient.
 *
 * @returns {RetentionLinks}
 */
export const makeRetentionLinkSet = () => {
  /** @type {Set<string>} */
  const pinned = new Set();
  return harden({
    pin: hash => {
      pinned.add(hash);
    },
    unpin: hash => {
      pinned.delete(hash);
    },
    isPinned: hash => pinned.has(hash),
  });
};
harden(makeRetentionLinkSet);

/**
 * Construct an in-memory CAS store.
 *
 * The store honors retention links: an `evict(hash)` call is a no-op
 * (returning false) when the hash is pinned, mirroring the
 * daemon-side eviction pass's discipline that anything reachable from
 * a captured formula holds a hard retention link that prevents
 * eviction.
 *
 * The `sha256` power is required. Callers in a Web Crypto
 * environment can import `sha256HexWebCrypto` from
 * `./store-web-powers.js`; daemon-side callers can supply a
 * `node:crypto`-backed equivalent. Decoupling the digest keeps this
 * module portable across XS, browsers, and Node without an internal
 * platform check.
 *
 * @param {{ sha256: Sha256Hex, retentionLinks?: RetentionLinks }} options
 * @returns {CasStore & { retentionLinks: RetentionLinks }}
 */
export const makeMemoryCasStore = options => {
  if (!options || typeof options.sha256 !== 'function') {
    throw makeError(
      X`makeMemoryCasStore requires a sha256 power; supply sha256HexWebCrypto from ./store-web-powers.js or a Node-side equivalent`,
    );
  }
  const { sha256 } = options;
  const retentionLinks = options.retentionLinks ?? makeRetentionLinkSet();
  /** @type {Map<string, Uint8Array>} */
  const blobs = new Map();

  // The in-memory store is a layer-1 local utility, not an exo.
  // CAS bytes are mutable Uint8Arrays and would be rejected by an
  // exo guard's pass-style check.  The daemon-side persistent CAS
  // (in `daemon-persistence-powers.js`) lives behind the persistence
  // powers, not behind a remotable interface, so the in-memory
  // reference implementation matches that pattern.
  return harden({
    /** @param {string} hash */
    async has(hash) {
      return blobs.has(hash);
    },
    /** @param {string} hash */
    async read(hash) {
      const bytes = blobs.get(hash);
      if (bytes === undefined) {
        throw makeError(X`CAS has no entry for hash ${hash}`);
      }
      return bytes;
    },
    /** @param {Uint8Array} bytes */
    async write(bytes) {
      const hash = await sha256(bytes);
      if (!blobs.has(hash)) {
        blobs.set(hash, bytes);
      }
      return hash;
    },
    /** @param {string} hash */
    async evict(hash) {
      if (retentionLinks.isPinned(hash)) {
        return false;
      }
      return blobs.delete(hash);
    },
    async list() {
      return [...blobs.keys()];
    },
    retentionLinks,
  });
};
harden(makeMemoryCasStore);
