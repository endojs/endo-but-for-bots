// @ts-check

// Pure CRDT primitives for the synced pet store.  This module has no
// dependencies on the daemon, the filesystem, or any I/O surface; it is
// entirely synchronous and pure.  See `designs/daemon-cross-peer-gc.md`
// § "CRDT Data Model" and § "Merge Rules" for the semantics implemented
// here.
//
// The synchronized pet store is a Last-Writer-Wins Register (LWW-Register)
// per pet name, composed into a map.  A deliberate **tombstone bias**
// breaks ties between live writes and deletions in favor of the deletion,
// so that revocation is never silently overridden by a concurrent grant
// (Shapiro et al., INRIA RR-7506, 2011, § 3.2.2).

import harden from '@endo/harden';

/**
 * @import {
 *   FormulaNumber,
 *   NodeNumber,
 *   PetName,
 *   SyncedEntry,
 *   SyncedPetStoreState,
 * } from './types.js'
 */

/**
 * Returns true if the entry represents a tombstone (deletion/revocation),
 * false if it is a live binding.  A tombstone is encoded by `locator: null`.
 *
 * @param {SyncedEntry} entry
 * @returns {boolean}
 */
export const isTombstone = entry => entry.locator === null;
harden(isTombstone);

/**
 * Constructs a tombstone entry for a given Lamport timestamp and writer.
 *
 * @param {number} timestamp - The Lamport timestamp at which the
 *   deletion/revocation occurred.
 * @param {NodeNumber} writer - The node number of the peer that wrote
 *   this tombstone.
 * @returns {SyncedEntry}
 */
export const makeTombstone = (timestamp, writer) =>
  harden({ locator: null, timestamp, writer });
harden(makeTombstone);

/**
 * Constructs a live entry for a given locator, Lamport timestamp, and
 * writer.
 *
 * @param {string} locator - The formula locator (an `endo://...` URL).
 * @param {number} timestamp - The Lamport timestamp at which this entry
 *   was written.
 * @param {NodeNumber} writer - The node number of the peer that wrote
 *   this entry.
 * @returns {SyncedEntry}
 */
export const makeEntry = (locator, timestamp, writer) =>
  harden({ locator, timestamp, writer });
harden(makeEntry);

/**
 * Pure merge of two entries for the **same** pet name.
 *
 * The merge rules are, in order:
 *
 * 1. Higher Lamport timestamp wins.
 * 2. Tombstone bias on equal timestamp: a tombstone (`locator === null`)
 *    beats a live binding.  This guarantees revocation propagates even
 *    under concurrent writes.
 * 3. Lexicographically greater node ID wins on equal timestamp and
 *    matching null/non-null status.
 *
 * The function is total, deterministic, commutative, associative, and
 * idempotent on equal inputs (proved by tests).
 *
 * @param {SyncedEntry} a
 * @param {SyncedEntry} b
 * @returns {SyncedEntry}
 */
export const mergeEntries = (a, b) => {
  // Rule 1: higher timestamp wins.
  if (a.timestamp > b.timestamp) return a;
  if (b.timestamp > a.timestamp) return b;

  // Rule 2: tombstone bias on equal timestamp.
  const aIsTombstone = a.locator === null;
  const bIsTombstone = b.locator === null;
  if (aIsTombstone && !bIsTombstone) return a;
  if (bIsTombstone && !aIsTombstone) return b;

  // Rule 3: lexicographically greater node ID wins.
  // Note: when both are tombstones with equal timestamp, or both are live
  // entries with equal timestamp, the writer field is the deterministic
  // tiebreaker.  If writers are equal too, both entries are considered
  // identical and we return `a` (idempotent on equal inputs).
  if (a.writer > b.writer) return a;
  if (b.writer > a.writer) return b;
  return a;
};
harden(mergeEntries);

/**
 * Pure merge of two synced pet store states.  Returns a new map that
 * contains every key present in either input, with each value computed by
 * `mergeEntries`.  Inputs are not mutated.
 *
 * The result is hardened, but its values (entries) and the inner Map
 * structure are not — callers may insert further entries into a copy if
 * needed.  For an immutable snapshot, the caller should freeze the
 * returned Map themselves.
 *
 * @param {SyncedPetStoreState} local
 * @param {SyncedPetStoreState} remote
 * @returns {SyncedPetStoreState}
 */
export const mergeStates = (local, remote) => {
  /** @type {SyncedPetStoreState} */
  const result = new Map();
  for (const [petName, entry] of local) {
    result.set(petName, entry);
  }
  for (const [petName, remoteEntry] of remote) {
    const localEntry = result.get(petName);
    if (localEntry === undefined) {
      result.set(petName, remoteEntry);
    } else {
      result.set(petName, mergeEntries(localEntry, remoteEntry));
    }
  }
  return result;
};
harden(mergeStates);

// Re-export the FormulaNumber and PetName types for convenience to other
// modules that consume CRDT values; the runtime module exports nothing
// type-only.
/** @typedef {FormulaNumber} _FormulaNumberRef */
/** @typedef {PetName} _PetNameRef */
