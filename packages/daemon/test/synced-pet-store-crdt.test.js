// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  isTombstone,
  makeEntry,
  makeTombstone,
  mergeEntries,
  mergeStates,
} from '../src/synced-pet-store-crdt.js';

/** @import { NodeNumber, PetName, SyncedEntry, SyncedPetStoreState } from '../src/types.js' */

// ── Test fixtures ────────────────────────────────────────────────

const nodeA = /** @type {NodeNumber} */ ('a'.repeat(64));
const nodeB = /** @type {NodeNumber} */ ('b'.repeat(64));
const nodeC = /** @type {NodeNumber} */ ('c'.repeat(64));

const locatorX = 'endo://example/handle:abc';
const locatorY = 'endo://example/handle:def';

const petAlice = /** @type {PetName} */ ('alice');
const petBob = /** @type {PetName} */ ('bob');
const petCarol = /** @type {PetName} */ ('carol');

// ── isTombstone ─────────────────────────────────────────────────

test('isTombstone returns true for null locator', t => {
  t.true(isTombstone(makeTombstone(1, nodeA)));
});

test('isTombstone returns false for non-null locator', t => {
  t.false(isTombstone(makeEntry(locatorX, 1, nodeA)));
});

// ── Rule 1: higher timestamp wins ───────────────────────────────

test('mergeEntries: higher timestamp wins (left newer)', t => {
  const newer = makeEntry(locatorX, 5, nodeA);
  const older = makeEntry(locatorY, 3, nodeB);
  t.deepEqual(mergeEntries(newer, older), newer);
});

test('mergeEntries: higher timestamp wins (right newer)', t => {
  const older = makeEntry(locatorX, 3, nodeA);
  const newer = makeEntry(locatorY, 5, nodeB);
  t.deepEqual(mergeEntries(older, newer), newer);
});

test('mergeEntries: higher timestamp beats tombstone with lower timestamp', t => {
  // A live entry at T=5 must beat a tombstone at T=4.  Tombstone bias only
  // applies on EQUAL timestamps; a strictly higher live write is a
  // deliberate re-grant.
  const live = makeEntry(locatorX, 5, nodeA);
  const stale = makeTombstone(4, nodeB);
  t.deepEqual(mergeEntries(live, stale), live);
  t.deepEqual(mergeEntries(stale, live), live);
});

// ── Rule 2: tombstone bias on equal timestamp ───────────────────

test('mergeEntries: tombstone bias on tie (left tombstone)', t => {
  const tombstone = makeTombstone(7, nodeA);
  const live = makeEntry(locatorX, 7, nodeB);
  t.deepEqual(mergeEntries(tombstone, live), tombstone);
});

test('mergeEntries: tombstone bias on tie (right tombstone)', t => {
  const live = makeEntry(locatorX, 7, nodeA);
  const tombstone = makeTombstone(7, nodeB);
  t.deepEqual(mergeEntries(live, tombstone), tombstone);
});

test('SECURITY: revocation must win on tie regardless of writer ordering', t => {
  // This test locks the security policy: a concurrent revoke at the same
  // Lamport timestamp as a live grant MUST result in revocation, even
  // when the writer of the live entry is lexicographically greater than
  // the writer of the tombstone.  Without tombstone bias, the node-ID
  // tiebreaker would let the grant win and silently un-revoke.
  const tombstoneFromLowerNode = makeTombstone(7, nodeA);
  const liveFromHigherNode = makeEntry(locatorX, 7, nodeC);
  t.true(isTombstone(mergeEntries(tombstoneFromLowerNode, liveFromHigherNode)));
  t.true(isTombstone(mergeEntries(liveFromHigherNode, tombstoneFromLowerNode)));
});

// ── Rule 3: node-ID tiebreaker ─────────────────────────────────

test('mergeEntries: node-ID tiebreaker on equal timestamp + both live', t => {
  const fromA = makeEntry(locatorX, 7, nodeA);
  const fromB = makeEntry(locatorY, 7, nodeB);
  t.deepEqual(mergeEntries(fromA, fromB), fromB); // 'b' > 'a' lexicographically
  t.deepEqual(mergeEntries(fromB, fromA), fromB);
});

test('mergeEntries: node-ID tiebreaker on equal timestamp + both tombstones', t => {
  const tombFromA = makeTombstone(7, nodeA);
  const tombFromC = makeTombstone(7, nodeC);
  t.deepEqual(mergeEntries(tombFromA, tombFromC), tombFromC);
  t.deepEqual(mergeEntries(tombFromC, tombFromA), tombFromC);
});

test('mergeEntries: identical entries are idempotent', t => {
  const entry = makeEntry(locatorX, 7, nodeA);
  t.deepEqual(mergeEntries(entry, entry), entry);
});

// ── Algebraic properties ────────────────────────────────────────

test('mergeEntries: commutativity over several pairs', t => {
  /** @type {Array<[SyncedEntry, SyncedEntry]>} */
  const pairs = [
    [makeEntry(locatorX, 1, nodeA), makeEntry(locatorY, 2, nodeB)],
    [makeEntry(locatorX, 5, nodeA), makeTombstone(5, nodeB)],
    [makeEntry(locatorX, 5, nodeC), makeEntry(locatorY, 5, nodeA)],
    [makeTombstone(3, nodeA), makeTombstone(3, nodeB)],
    [makeEntry(locatorX, 9, nodeA), makeEntry(locatorY, 1, nodeB)],
    [makeTombstone(2, nodeA), makeEntry(locatorX, 5, nodeB)],
  ];
  for (const [a, b] of pairs) {
    t.deepEqual(
      mergeEntries(a, b),
      mergeEntries(b, a),
      `commutative for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    );
  }
});

test('mergeEntries: associativity on a representative triple', t => {
  const a = makeEntry(locatorX, 3, nodeA);
  const b = makeTombstone(3, nodeB);
  const c = makeEntry(locatorY, 5, nodeC);
  // (a ∘ b) ∘ c
  const left = mergeEntries(mergeEntries(a, b), c);
  // a ∘ (b ∘ c)
  const right = mergeEntries(a, mergeEntries(b, c));
  t.deepEqual(left, right);
});

test('mergeEntries: associativity with all-tombstones triple', t => {
  const a = makeTombstone(2, nodeA);
  const b = makeTombstone(2, nodeB);
  const c = makeTombstone(2, nodeC);
  const left = mergeEntries(mergeEntries(a, b), c);
  const right = mergeEntries(a, mergeEntries(b, c));
  t.deepEqual(left, right);
});

// ── mergeStates ────────────────────────────────────────────────

test('mergeStates: union of disjoint keys', t => {
  /** @type {SyncedPetStoreState} */
  const local = new Map([[petAlice, makeEntry(locatorX, 1, nodeA)]]);
  /** @type {SyncedPetStoreState} */
  const remote = new Map([[petBob, makeEntry(locatorY, 1, nodeB)]]);
  const merged = mergeStates(local, remote);
  t.is(merged.size, 2);
  t.deepEqual(merged.get(petAlice), makeEntry(locatorX, 1, nodeA));
  t.deepEqual(merged.get(petBob), makeEntry(locatorY, 1, nodeB));
});

test('mergeStates: applies mergeEntries per key', t => {
  /** @type {SyncedPetStoreState} */
  const local = new Map([
    [petAlice, makeEntry(locatorX, 1, nodeA)],
    [petBob, makeEntry(locatorX, 5, nodeA)],
  ]);
  /** @type {SyncedPetStoreState} */
  const remote = new Map([
    [petAlice, makeEntry(locatorY, 3, nodeB)], // newer; should win
    [petBob, makeTombstone(5, nodeB)], // tie + tombstone bias; should win
  ]);
  const merged = mergeStates(local, remote);
  t.deepEqual(merged.get(petAlice), makeEntry(locatorY, 3, nodeB));
  t.true(isTombstone(/** @type {SyncedEntry} */ (merged.get(petBob))));
});

test('mergeStates: idempotent — merge(s, s) deepEquals s', t => {
  /** @type {SyncedPetStoreState} */
  const s = new Map([
    [petAlice, makeEntry(locatorX, 1, nodeA)],
    [petBob, makeTombstone(2, nodeB)],
    [petCarol, makeEntry(locatorY, 3, nodeC)],
  ]);
  const merged = mergeStates(s, s);
  t.is(merged.size, s.size);
  for (const [name, entry] of s) {
    t.deepEqual(merged.get(name), entry);
  }
});

test('mergeStates: commutative on a multi-key example', t => {
  /** @type {SyncedPetStoreState} */
  const a = new Map([
    [petAlice, makeEntry(locatorX, 1, nodeA)],
    [petBob, makeEntry(locatorX, 5, nodeA)],
    [petCarol, makeTombstone(2, nodeA)],
  ]);
  /** @type {SyncedPetStoreState} */
  const b = new Map([
    [petAlice, makeTombstone(1, nodeB)], // tombstone bias on tie
    [petBob, makeEntry(locatorY, 7, nodeB)], // higher timestamp
    [petCarol, makeEntry(locatorY, 2, nodeB)], // tombstone bias on tie
  ]);
  const ab = mergeStates(a, b);
  const ba = mergeStates(b, a);
  t.is(ab.size, ba.size);
  for (const name of ab.keys()) {
    t.deepEqual(ab.get(name), ba.get(name));
  }
});

test('mergeStates: associative on a multi-key example', t => {
  /** @type {SyncedPetStoreState} */
  const a = new Map([[petAlice, makeEntry(locatorX, 1, nodeA)]]);
  /** @type {SyncedPetStoreState} */
  const b = new Map([
    [petAlice, makeTombstone(1, nodeB)],
    [petBob, makeEntry(locatorY, 4, nodeB)],
  ]);
  /** @type {SyncedPetStoreState} */
  const c = new Map([
    [petBob, makeTombstone(4, nodeC)],
    [petCarol, makeEntry(locatorX, 9, nodeC)],
  ]);

  const left = mergeStates(mergeStates(a, b), c);
  const right = mergeStates(a, mergeStates(b, c));
  t.is(left.size, right.size);
  for (const name of left.keys()) {
    t.deepEqual(left.get(name), right.get(name));
  }
});

test('mergeStates: does not mutate its inputs', t => {
  /** @type {SyncedPetStoreState} */
  const local = new Map([[petAlice, makeEntry(locatorX, 1, nodeA)]]);
  /** @type {SyncedPetStoreState} */
  const remote = new Map([[petBob, makeEntry(locatorY, 1, nodeB)]]);
  const localBefore = [...local.entries()];
  const remoteBefore = [...remote.entries()];
  mergeStates(local, remote);
  t.deepEqual([...local.entries()], localBefore);
  t.deepEqual([...remote.entries()], remoteBefore);
});
