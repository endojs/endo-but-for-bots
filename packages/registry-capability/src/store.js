// @ts-check
/* global globalThis */

/**
 * In-memory CAS store and SHA-256 content-addressing helper.
 *
 * The CAS itself is the underlying eviction surface for registry
 * cache growth per `designs/registry-capability.md` § Bounded growth;
 * the registry sits on top of the CAS via this interface. This
 * module's `makeMemoryCasStore` is the reference implementation
 * suitable for tests. Persistent storage (the daemon-side `store-sha256`
 * tree the `daemon-persistence-powers` module manages) implements the
 * same surface.
 *
 * Retention links are passed in explicitly so the formula graph's
 * pin lifecycle stays the caller's concern; this keeps layer 1
 * agnostic about how layer 3 (snapshot-mapper) wires its captured
 * formulas into the CAS pinning surface.
 *
 * @import { CasStore, RetentionLinks } from '../types.js';
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
 * Compute a SHA-256 hex digest of the bytes.
 *
 * Uses Web Crypto when available (Node 19+, browsers) so the helper
 * works in both daemon and worker contexts. The hex string is what
 * the CAS uses as the content-address key.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export const sha256Hex = async bytes => {
  // eslint-disable-next-line no-restricted-globals
  const crypto = globalThis.crypto;
  if (!crypto || !crypto.subtle) {
    throw makeError(
      X`sha256Hex requires globalThis.crypto.subtle (Web Crypto)`,
    );
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    /** @type {BufferSource} */ (/** @type {unknown} */ (bytes)),
  );
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    const byte = view[i];
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
};
harden(sha256Hex);

/**
 * Construct an in-memory CAS store.
 *
 * The store honors retention links: an `evict(hash)` call is a no-op
 * (returning false) when the hash is pinned, mirroring the daemon-
 * side eviction pass's discipline that "anything reachable from a
 * captured formula holds a hard retention link that prevents
 * eviction" per `designs/registry-capability.md` § Caching and
 * retention.
 *
 * @param {{ retentionLinks?: RetentionLinks }} [options]
 * @returns {CasStore & { retentionLinks: RetentionLinks }}
 */
export const makeMemoryCasStore = (options = {}) => {
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
      const hash = await sha256Hex(bytes);
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
