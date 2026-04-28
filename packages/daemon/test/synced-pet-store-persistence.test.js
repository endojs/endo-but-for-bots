// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import { makeSyncedPetStorePersistence } from '../src/synced-pet-store-persistence.js';
import {
  makeEntry,
  makeTombstone,
  mergeStates,
} from '../src/synced-pet-store-crdt.js';

/** @import { FormulaNumber, NodeNumber, PetName, SyncedPetStoreState } from '../src/types.js' */

// ── Test fixtures and helpers ────────────────────────────────────

const nodeA = /** @type {NodeNumber} */ ('a'.repeat(64));
const nodeB = /** @type {NodeNumber} */ ('b'.repeat(64));

// 64 hex chars; first two ("ab") are the shard prefix per the design's
// directory layout.
const formulaNumber = /** @type {FormulaNumber} */ (
  `ab${'cdef0123456789'.repeat(4)}cdef`
);

const petAlice = /** @type {PetName} */ ('alice');
const petBob = /** @type {PetName} */ ('bob');

let counter = 0;
/**
 * Deterministic-ish source of unique hex strings for atomic-write
 * temporaries.  We do not need cryptographic randomness in tests.
 *
 * @returns {Promise<string>}
 */
const fakeRandomHex = async () => {
  counter += 1;
  return `tmp${counter.toString(16).padStart(4, '0')}`;
};

const makeTempStateDir = async () => {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'endo-synced-pet-store-test-'));
};

/**
 * @param {string} statePath
 * @param {FormulaNumber} fmla
 */
const makeFixture = (statePath, fmla) => {
  const filePowers = makeFilePowers({ fs, path });
  const persistence = makeSyncedPetStorePersistence(
    filePowers,
    fakeRandomHex,
    statePath,
    fmla,
  );
  const storeRoot = path.join(
    statePath,
    'synced-pet-store',
    fmla.slice(0, 2),
    fmla.slice(2),
  );
  const namesDir = path.join(storeRoot, 'names');
  return { filePowers, persistence, storeRoot, namesDir };
};

// ── Happy path ──────────────────────────────────────────────────

test('writeEntry/readState round-trips a live entry', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence } = makeFixture(statePath, formulaNumber);
    const entry = makeEntry('endo://example/handle:abc', 5, nodeA);
    await persistence.writeEntry(petAlice, entry);

    const state = await persistence.readState();
    t.is(state.size, 1);
    t.deepEqual(state.get(petAlice), entry);
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

test('writeEntry/readState round-trips a tombstone', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence } = makeFixture(statePath, formulaNumber);
    const tombstone = makeTombstone(7, nodeB);
    await persistence.writeEntry(petBob, tombstone);

    const state = await persistence.readState();
    t.is(state.size, 1);
    t.deepEqual(state.get(petBob), tombstone);
    t.is(state.get(petBob)?.locator, null);
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

test('writeMetadata/readMetadata round-trips clock state', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence } = makeFixture(statePath, formulaNumber);
    await persistence.writeMetadata(
      harden({ localClock: 12, remoteAckedClock: 8 }),
    );
    const m = await persistence.readMetadata();
    t.is(m.localClock, 12);
    t.is(m.remoteAckedClock, 8);
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

test('readMetadata returns zero defaults when no clock.json exists', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence } = makeFixture(statePath, formulaNumber);
    const m = await persistence.readMetadata();
    t.is(m.localClock, 0);
    t.is(m.remoteAckedClock, 0);
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

test('readState returns empty Map for a fresh store', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence } = makeFixture(statePath, formulaNumber);
    const state = await persistence.readState();
    t.is(state.size, 0);
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

test('multiple writes accumulate; per-key idempotent overwrite', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence } = makeFixture(statePath, formulaNumber);
    await persistence.writeEntry(petAlice, makeEntry('loc-1', 1, nodeA));
    await persistence.writeEntry(petBob, makeEntry('loc-2', 2, nodeA));
    // Overwrite alice with a newer entry; on disk the file is
    // rewritten via the atomic write-then-rename sequence.
    await persistence.writeEntry(petAlice, makeEntry('loc-3', 5, nodeB));

    const state = await persistence.readState();
    t.is(state.size, 2);
    t.deepEqual(state.get(petAlice), makeEntry('loc-3', 5, nodeB));
    t.deepEqual(state.get(petBob), makeEntry('loc-2', 2, nodeA));
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

// ── Stale-temporary cleanup ─────────────────────────────────────

test('listStaleTemporaries finds .tmp.* in names directory', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence, namesDir } = makeFixture(statePath, formulaNumber);
    await persistence.writeEntry(petAlice, makeEntry('loc', 1, nodeA));
    // Pre-create a stale temporary file from a hypothetical interrupted
    // write.
    const staleName = '.tmp.deadbeef';
    const stalePath = path.join(namesDir, staleName);
    await fsp.writeFile(stalePath, 'partial-write');

    const stale = await persistence.listStaleTemporaries();
    t.true(stale.includes(stalePath), 'stale temporary listed');
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

test('listStaleTemporaries finds .tmp.* in store root (metadata writes)', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence, storeRoot } = makeFixture(statePath, formulaNumber);
    // Force directory creation by reading metadata first.
    await persistence.readMetadata();
    const stalePath = path.join(storeRoot, '.tmp.cafe1234');
    await fsp.writeFile(stalePath, 'partial-clock-write');

    const stale = await persistence.listStaleTemporaries();
    t.true(stale.includes(stalePath));
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

test('deleteStaleTemporaries removes pre-existing .tmp.* file', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence, namesDir } = makeFixture(statePath, formulaNumber);
    // Touch the directory tree.
    await persistence.writeEntry(petAlice, makeEntry('loc', 1, nodeA));
    const stalePath = path.join(namesDir, '.tmp.partial');
    await fsp.writeFile(stalePath, 'incomplete');

    // Sanity: the file exists.
    t.true(fs.existsSync(stalePath));

    await persistence.deleteStaleTemporaries();

    t.false(fs.existsSync(stalePath), 'stale temporary should be removed');
    // The committed entry must be untouched.
    const state = await persistence.readState();
    t.is(state.size, 1);
    t.deepEqual(state.get(petAlice), makeEntry('loc', 1, nodeA));
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

test('deleteStaleTemporaries is idempotent and safe on empty dirs', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence } = makeFixture(statePath, formulaNumber);
    // Run twice on a fresh store; should not throw.
    await persistence.deleteStaleTemporaries();
    await persistence.deleteStaleTemporaries();
    t.pass();
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

// ── readState ignores temporaries and unrecognised filenames ────

test('readState ignores .tmp.* files', async t => {
  const statePath = await makeTempStateDir();
  try {
    const { persistence, namesDir } = makeFixture(statePath, formulaNumber);
    await persistence.writeEntry(petAlice, makeEntry('loc', 1, nodeA));
    await fsp.writeFile(path.join(namesDir, '.tmp.zzz'), 'partial');

    const state = await persistence.readState();
    t.is(state.size, 1);
    t.true(state.has(petAlice));
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});

// ── Cross-module: persistence types match CRDT types ────────────

test('state read from disk merges cleanly with an in-memory state', async t => {
  // This exercises the contract that `readState` returns a value of the
  // same shape that the CRDT primitives produce.  If the persistence
  // module ever reshapes entries (e.g. wraps them, omits a field), the
  // mergeStates call below would fail or produce wrong results.
  const statePath = await makeTempStateDir();
  try {
    const { persistence } = makeFixture(statePath, formulaNumber);
    await persistence.writeEntry(petAlice, makeEntry('loc-A', 1, nodeA));
    await persistence.writeEntry(petBob, makeTombstone(2, nodeA));

    const onDisk = await persistence.readState();

    /** @type {SyncedPetStoreState} */
    const inMemory = new Map([
      // newer entry for alice; should replace the on-disk one
      [petAlice, makeEntry('loc-A2', 5, nodeB)],
      // newer-or-equal write for bob, but tombstone bias keeps the disk
      // tombstone (timestamps are equal at 2 -> 2 case below; we use 2
      // and 2 to exercise the tombstone-bias branch):
      [petBob, makeEntry('loc-B-attempted-regrant', 2, nodeB)],
    ]);

    const merged = mergeStates(onDisk, inMemory);
    t.is(merged.size, 2);
    // Alice: in-memory wins on higher timestamp.
    t.deepEqual(merged.get(petAlice), makeEntry('loc-A2', 5, nodeB));
    // Bob: tombstone bias on tie keeps disk tombstone.
    t.is(merged.get(petBob)?.locator, null);
  } finally {
    await fsp.rm(statePath, { recursive: true, force: true });
  }
});
