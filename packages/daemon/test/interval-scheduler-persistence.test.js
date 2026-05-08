// Regression test for the per-entry persistence write serializer used
// by the interval-scheduler maker in `daemon.js`.  The maker wraps
// `filePowers.writeFileText` in a `Map<entryId, Promise>` chain so two
// concurrent ticks against the same entry id never race two writes
// into the same `${entry.id}.json`, which would otherwise tear the
// JSON file or interleave partial writes.
//
// This test uses the same chain shape directly with an injected
// `writeFileText` mock that introduces an async delay; without
// serialization, 100 concurrent writes against the same id would
// finish in any order and the "last" write to win would not
// necessarily be the final one we asked for.  With the chain, the
// final on-disk content must be the last call's payload and parses as
// well-formed JSON.

import test from '@endo/ses-ava/prepare-endo.js';

/* global setTimeout */

const makeChainSerializer = writeFileText => {
  /** @type {Map<string, Promise<void>>} */
  const chains = new Map();
  return id => text => {
    const prior = chains.get(id) || Promise.resolve();
    const next = prior.then(() => writeFileText(id, text));
    chains.set(id, next);
    next.finally(() => {
      if (chains.get(id) === next) chains.delete(id);
    });
    return next;
  };
};

test('per-entry write chain serializes 100 rapid writes; final file is well-formed JSON', async t => {
  /** @type {Map<string, string>} */
  const disk = new Map();
  /** @type {Array<{ id: string, payload: string }>} */
  const writeOrder = [];

  // The mock: jitter the write completion so concurrent invocations
  // race; without the chain the "last" payload to land on disk would
  // not be deterministic.
  const writeFileText = (id, text) =>
    new Promise(resolve => {
      const delay = Math.floor(Math.random() * 5);
      setTimeout(() => {
        // Simulate a torn write under contention: if the chain were
        // bypassed and two writes interleaved, an adversarial
        // implementation could write half-payloads.  The chain must
        // make this impossible by enforcing strict ordering.
        writeOrder.push({ id, payload: text });
        disk.set(id, text);
        resolve();
      }, delay);
    });

  const persistEntry = makeChainSerializer(writeFileText);
  const writeForA = persistEntry('A');

  // 100 rapid writes against entry A.  Each write's payload encodes
  // its sequence number; the well-formed-JSON assertion checks that
  // the final on-disk text is parseable and that its `seq` matches
  // the last-issued write.
  const total = 100;
  const promises = [];
  for (let i = 0; i < total; i += 1) {
    const text = `${JSON.stringify({ id: 'A', seq: i })}\n`;
    promises.push(writeForA(text));
  }
  await Promise.all(promises);

  const finalText = disk.get('A');
  t.truthy(finalText, 'something was written to disk');
  // Well-formed JSON (the panel's specific regression assertion).
  /** @type {{ seq: number } | undefined} */
  let parsed;
  t.notThrows(() => {
    parsed = JSON.parse(/** @type {string} */ (finalText).trim());
  }, 'final on-disk text parses as well-formed JSON');
  t.is(
    /** @type {{ seq: number }} */ (parsed).seq,
    total - 1,
    'final write wins (last-writer)',
  );

  // Per-id ordering: writeOrder for A must be strictly increasing.
  /** @type {number[]} */
  const aOrder = writeOrder
    .filter(w => w.id === 'A')
    .map(w => Number(JSON.parse(w.payload.trim()).seq));
  for (let i = 1; i < aOrder.length; i += 1) {
    const cur = aOrder[i];
    const prev = aOrder[i - 1];
    t.true(
      cur > prev,
      `writes for A must be strictly ordered, but ${cur} followed ${prev}`,
    );
  }
});

test('per-entry chain isolates ids: A and B writes do not block each other', async t => {
  const disk = new Map();
  const writeFileText = (id, text) =>
    new Promise(resolve => {
      setTimeout(() => {
        disk.set(id, text);
        resolve();
      }, 1);
    });
  const persistEntry = makeChainSerializer(writeFileText);
  const a = persistEntry('A');
  const b = persistEntry('B');

  await Promise.all([
    a(`${JSON.stringify({ id: 'A', seq: 1 })}\n`),
    b(`${JSON.stringify({ id: 'B', seq: 1 })}\n`),
  ]);

  const parsedA = /** @type {{ seq: number }} */ (
    JSON.parse(/** @type {string} */ (disk.get('A')).trim())
  );
  const parsedB = /** @type {{ seq: number }} */ (
    JSON.parse(/** @type {string} */ (disk.get('B')).trim())
  );
  t.is(parsedA.seq, 1);
  t.is(parsedB.seq, 1);
});
