// @ts-check
import '@endo/init';

import test from 'ava';

import {
  canonicalAuditJson,
  makeAuditJournal,
  makeStoredAuditJournal,
  verifyAuditEntries,
} from '../src/audit-journal.js';

const makeHeadStore = () => {
  const heads = [];
  return {
    readHead: async () => heads.at(-1),
    writeHead: async head => {
      const existing = heads.find(
        candidate => candidate.sequence === head.sequence,
      );
      if (existing) {
        if (canonicalAuditJson(existing) !== canonicalAuditJson(head)) {
          throw Error('head collision');
        }
        return;
      }
      heads.push(head);
    },
  };
};

test('audit journal serializes concurrent appends into a durable hash chain', async t => {
  const durable = [];
  const heads = makeHeadStore();
  const { writer, reader } = makeAuditJournal({
    ...heads,
    journalId: 'journal-1',
    sessionId: 'session-1',
    readEntries: async () => durable,
    appendEntry: async entry => {
      t.is(entry.sequence, BigInt(durable.length));
      durable.push(entry);
    },
    now: () => '2026-09-03T00:00:00.000Z',
  });

  await Promise.all([
    writer.append('turn-requested', { promptBytes: 12 }),
    writer.append('tool-intent', { tool: 'lookup', arguments: { name: 'x' } }),
    writer.append('turn-terminal', { status: 'completed' }),
  ]);

  const entries = await reader.entries();
  t.is(entries.length, 3);
  t.deepEqual(
    entries.map(entry => entry.sequence),
    [0n, 1n, 2n],
  );
  t.deepEqual(await reader.verify(), verifyAuditEntries(entries));
  t.true((await reader.verify()).ok);
});

test('a reader queued ahead of an append never sees the append half-written', async t => {
  const durable = [];
  const heads = makeHeadStore();
  let releaseEntry = () => {};
  const entryGate = new Promise(resolve => {
    releaseEntry = () => resolve(undefined);
  });
  let gated = false;
  const { writer, reader } = makeAuditJournal({
    ...heads,
    journalId: 'journal-race',
    sessionId: 'session-race',
    readEntries: async () => durable,
    appendEntry: async entry => {
      // Hold the entry write after the anchor has landed: the window in which
      // the store shows a head one ahead of the entries.
      if (gated) await entryGate;
      durable.push(entry);
    },
  });
  await writer.append('session-open');
  gated = true;
  const verifying = reader.verify();
  const listing = reader.entries();
  const appending = writer.append('turn-requested');
  await null;
  await null;
  releaseEntry();
  await appending;
  t.true(
    (await verifying).ok,
    'a legitimate append is not reported as corruption',
  );
  t.is((await listing).length, 1);
  t.true((await reader.verify()).ok);
  t.is((await reader.entries()).length, 2);
});

test('audit recovery detects interior mutation before another append', async t => {
  const durable = [];
  const heads = makeHeadStore();
  const first = makeAuditJournal({
    ...heads,
    journalId: 'journal-2',
    sessionId: 'session-2',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await first.writer.append('session-open', { imageDigest: 'sha256:abc' });
  await first.writer.append('thread-bound', { threadId: 'thread-1' });
  durable[0] = harden({
    ...durable[0],
    payload: harden({ imageDigest: 'sha256:tampered' }),
  });

  const recovered = makeAuditJournal({
    ...heads,
    journalId: 'journal-2',
    sessionId: 'session-2',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await t.throwsAsync(() => recovered.writer.append('turn-requested'), {
    message: /corrupt at sequence.*1n/,
  });
});

test('audit recovery rejects a valid chain from another session', async t => {
  const durable = [];
  const heads = makeHeadStore();
  const first = makeAuditJournal({
    ...heads,
    journalId: 'journal-a',
    sessionId: 'session-a',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await first.writer.append('session-open');

  const swapped = makeAuditJournal({
    ...heads,
    journalId: 'journal-b',
    sessionId: 'session-b',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await t.throwsAsync(() => swapped.writer.append('turn-requested'), {
    message: /corrupt at sequence.*0n/,
  });
});

test('audit recovery completes only an anchor-prepared entry', async t => {
  const durable = [];
  const heads = makeHeadStore();
  let failAppend = true;
  const first = makeAuditJournal({
    ...heads,
    journalId: 'crash-gap',
    sessionId: 'crash-session',
    readEntries: async () => durable,
    appendEntry: async entry => {
      if (failAppend) {
        failAppend = false;
        throw Error('simulated entry-store outage after anchor prepare');
      }
      durable.push(entry);
    },
    now: () => '2026-09-03T00:00:00.000Z',
  });
  await t.throwsAsync(() => first.writer.append('session-open'), {
    message: /entry-store outage/,
  });
  const recovered = makeAuditJournal({
    ...heads,
    journalId: 'crash-gap',
    sessionId: 'crash-session',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await recovered.writer.append('turn-requested');
  t.deepEqual(
    (await recovered.reader.entries()).map(entry => entry.sequence),
    [0n, 1n],
  );
  t.true((await recovered.reader.verify()).ok);
});

test('audit recovery never blesses an entry-store-forged suffix', async t => {
  const durable = [];
  const heads = makeHeadStore();
  const first = makeAuditJournal({
    ...heads,
    journalId: 'forged-gap',
    sessionId: 'forged-session',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
    now: () => '2026-09-03T00:00:00.000Z',
  });
  await first.writer.append('session-open');
  durable.push(
    harden({
      version: 1,
      journalId: 'forged-gap',
      sessionId: 'forged-session',
      sequence: 1n,
      at: '2026-09-03T00:00:01.000Z',
      kind: 'forged',
      previousHash: verifyAuditEntries(durable).previousHash,
      payload: harden({}),
    }),
  );
  const recovered = makeAuditJournal({
    ...heads,
    journalId: 'forged-gap',
    sessionId: 'forged-session',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await t.throwsAsync(() => recovered.writer.append('must-not-land'), {
    message: /head is corrupt/,
  });
});

test('an empty audit journal verifies without a synthetic head', async t => {
  const heads = makeHeadStore();
  const journal = makeAuditJournal({
    ...heads,
    journalId: 'empty',
    sessionId: 'empty-session',
    readEntries: async () => [],
    appendEntry: async () => undefined,
  });
  t.true((await journal.reader.verify()).ok);
});

test('audit head repairs one authorized deletion and rejects a longer rollback', async t => {
  const durable = [];
  const heads = makeHeadStore();
  const first = makeAuditJournal({
    ...heads,
    journalId: 'tail-check',
    sessionId: 'tail-session',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await first.writer.append('one');
  await first.writer.append('two');
  durable.pop();

  const recovered = makeAuditJournal({
    ...heads,
    journalId: 'tail-check',
    sessionId: 'tail-session',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await recovered.writer.append('three');
  t.deepEqual(
    (await recovered.reader.entries()).map(entry => entry.kind),
    ['one', 'two', 'three'],
  );
  durable.splice(-2);
  const rolledBack = makeAuditJournal({
    ...heads,
    journalId: 'tail-check',
    sessionId: 'tail-session',
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await t.throwsAsync(() => rolledBack.writer.append('four'), {
    message: /head is corrupt/,
  });
});

test('audit canonical encoding rejects authority and unstable values', t => {
  t.is(
    canonicalAuditJson(harden({ z: 1, a: [2n, 'x'] })),
    '["record",[["a",["array",[["bigint","2"],["string","x"]]]],["z",["number","1"]]]]',
  );
  t.not(canonicalAuditJson(2n), canonicalAuditJson(harden({ '#big': '2' })));
  t.not(canonicalAuditJson(-0), canonicalAuditJson(0));
  t.throws(() => canonicalAuditJson(Promise.resolve()), {
    message: /copy records/,
  });
  t.throws(() => canonicalAuditJson(undefined), {
    message: /cannot contain.*undefined/,
  });
});

test('petstore audit journal survives reconstruction outside the session', async t => {
  const values = new Map();
  const anchors = new Map();
  const makePowers = valuesMap =>
    harden({
      async list() {
        return [...valuesMap.keys()];
      },
      async has(name) {
        return valuesMap.has(name);
      },
      async lookup(name) {
        return valuesMap.get(name);
      },
      async storeValue(value, name) {
        if (valuesMap.has(name)) throw Error('already exists');
        valuesMap.set(name, value);
      },
    });
  const powers = makePowers(values);
  const anchorPowers = makePowers(anchors);
  const first = makeStoredAuditJournal(powers, {
    journalId: 'operator-journal',
    sessionId: 'session-3',
    anchorPowers,
  });
  await first.writer.append('session-open', { policyVersion: 'v1' });

  const recovered = makeStoredAuditJournal(powers, {
    journalId: 'operator-journal',
    sessionId: 'session-3',
    anchorPowers,
  });
  await recovered.writer.append('session-close', {});
  const entries = await recovered.reader.entries();
  t.deepEqual(
    entries.map(entry => entry.sequence),
    [0n, 1n],
  );
  t.true((await recovered.reader.verify()).ok);

  // One deleted tail entry is restored from the independently protected
  // write-ahead anchor.
  values.delete('codex-audit-session-3-00000000000000000001');
  const rolledBack = makeStoredAuditJournal(powers, {
    journalId: 'operator-journal',
    sessionId: 'session-3',
    anchorPowers,
  });
  await rolledBack.writer.append('after-one-entry-rollback');
  t.true((await rolledBack.reader.verify()).ok);

  // A longer rollback cannot be mistaken for a single prepared append.
  values.delete('codex-audit-session-3-00000000000000000001');
  values.delete('codex-audit-session-3-00000000000000000002');
  const longerRollback = makeStoredAuditJournal(powers, {
    journalId: 'operator-journal',
    sessionId: 'session-3',
    anchorPowers,
  });
  await t.throwsAsync(() => longerRollback.writer.append('after-rollback'), {
    message: /head is corrupt/,
  });
});

test('petstore journals do not cross-select overlapping head prefixes', async t => {
  const values = new Map();
  const anchors = new Map();
  const makePowers = valuesMap =>
    harden({
      async list() {
        return [...valuesMap.keys()];
      },
      async has(name) {
        return valuesMap.has(name);
      },
      async lookup(name) {
        return valuesMap.get(name);
      },
      async storeValue(value, name) {
        if (valuesMap.has(name)) throw Error('already exists');
        valuesMap.set(name, value);
      },
    });
  const powers = makePowers(values);
  const anchorPowers = makePowers(anchors);
  const short = makeStoredAuditJournal(powers, {
    journalId: 'short',
    sessionId: 'a',
    anchorPowers,
  });
  const overlapping = makeStoredAuditJournal(powers, {
    journalId: 'overlapping',
    sessionId: 'a-head-z',
    anchorPowers,
  });
  await short.writer.append('short-entry');
  await overlapping.writer.append('overlapping-entry');
  t.true((await short.reader.verify()).ok);
  t.true((await overlapping.reader.verify()).ok);
});

test('petstore audit journal rejects one capability for entries and heads', t => {
  const values = new Map();
  const powers = harden({
    async list() {
      return [...values.keys()];
    },
    async has(name) {
      return values.has(name);
    },
    async lookup(name) {
      return values.get(name);
    },
    async storeValue(value, name) {
      values.set(name, value);
    },
  });
  t.throws(
    () =>
      makeStoredAuditJournal(powers, {
        journalId: 'not-separated',
        sessionId: 'same-powers',
        anchorPowers: powers,
      }),
    { message: /must be distinct/ },
  );
});

test('concurrent readers share one recovery of a prepared append', async t => {
  const values = new Map();
  const anchors = new Map();
  let entryWrites = 0;
  const makePowers = (valuesMap, count = false) =>
    harden({
      async list() {
        return [...valuesMap.keys()];
      },
      async has(name) {
        return valuesMap.has(name);
      },
      async lookup(name) {
        return valuesMap.get(name);
      },
      async storeValue(value, name) {
        // The real petstore rejects a duplicate name, which is what turned a
        // doubled replay into a thrown integrity check rather than a silent
        // one.
        if (valuesMap.has(name)) throw Error('already exists');
        if (count) entryWrites += 1;
        valuesMap.set(name, value);
      },
    });
  const powers = makePowers(values, true);
  const anchorPowers = makePowers(anchors);
  const journal = makeStoredAuditJournal(powers, {
    journalId: 'operator-journal',
    sessionId: 'session-4',
    anchorPowers,
  });
  await journal.writer.append('session-open', { policyVersion: 'v1' });

  // Simulate a crash between the write-ahead head and the entry append: drop
  // the tail entry, leaving the anchor as the only record of it.
  const tail = [...values.keys()].sort().at(-1);
  values.delete(tail);
  entryWrites = 0;

  // Two readers arrive at once — an operator health check racing the next
  // append. Both used to take the replay branch and both call appendEntry.
  const reopened = makeStoredAuditJournal(powers, {
    journalId: 'operator-journal',
    sessionId: 'session-4',
    anchorPowers,
  });
  const [verification, entries] = await Promise.all([
    reopened.reader.verify(),
    reopened.reader.entries(),
  ]);
  t.true(verification.ok, 'the integrity check reports rather than throwing');
  t.deepEqual(
    entries.map(entry => entry.sequence),
    [0n],
  );
  t.is(entryWrites, 1, 'the prepared entry is replayed exactly once');
});

const makeMapPowers = valuesMap =>
  harden({
    async list() {
      return [...valuesMap.keys()];
    },
    async has(name) {
      return valuesMap.has(name);
    },
    async lookup(name) {
      return valuesMap.get(name);
    },
    async storeValue(value, name) {
      if (valuesMap.has(name)) throw Error('already exists');
      valuesMap.set(name, value);
    },
    async remove(name) {
      valuesMap.delete(name);
    },
  });

test('a journal has no lifetime ceiling, and the anchor store keeps only the newest head', async t => {
  const values = new Map();
  const anchors = new Map();
  const journal = makeStoredAuditJournal(makeMapPowers(values), {
    journalId: 'long',
    sessionId: 'long-session',
    anchorPowers: makeMapPowers(anchors),
  });
  for (let i = 0; i < 300; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await journal.writer.append('tool-result', { result: 'x'.repeat(4096) });
  }
  t.is(values.size, 300);
  t.is(
    anchors.size,
    1,
    'a head that authorized an appended entry is discarded',
  );
  // Recovery from the newest head alone, then the chain verifies whole.
  const revived = makeStoredAuditJournal(makeMapPowers(values), {
    journalId: 'long',
    sessionId: 'long-session',
    anchorPowers: makeMapPowers(anchors),
  });
  await revived.writer.append('session-closed');
  t.true((await revived.reader.verify()).ok);
  t.is((await revived.reader.entries(300, 1))[0].kind, 'session-closed');
});

test('a stale head a failed discard left behind is read past, never trusted over the newest', async t => {
  const values = new Map();
  const anchors = new Map();
  const anchorPowers = makeMapPowers(anchors);
  const journal = makeStoredAuditJournal(makeMapPowers(values), {
    journalId: 'stale',
    sessionId: 'stale-session',
    anchorPowers,
  });
  await journal.writer.append('one');
  const [firstHead] = [...anchors.entries()];
  await journal.writer.append('two');
  // Put the discarded head back, as a removal that failed would leave it.
  anchors.set(firstHead[0], firstHead[1]);
  t.is(anchors.size, 2);
  const revived = makeStoredAuditJournal(makeMapPowers(values), {
    journalId: 'stale',
    sessionId: 'stale-session',
    anchorPowers,
  });
  await revived.writer.append('three');
  t.true((await revived.reader.verify()).ok);
  t.is((await revived.reader.entries()).length, 3);
});

test('a large payload field is stored by reference, attested by its hash, once per content', async t => {
  const values = new Map();
  const anchors = new Map();
  const journal = makeStoredAuditJournal(makeMapPowers(values), {
    journalId: 'refs',
    sessionId: 'refs-session',
    anchorPowers: makeMapPowers(anchors),
    inlineBytes: 1024,
  });
  const big = 'result '.repeat(1000);
  await journal.writer.append('tool-result', { small: 'ok', result: big });
  await journal.writer.append('tool-result', { result: big });
  const [first, second] = await journal.reader.entries();
  t.is(first.payload.small, 'ok', 'a small field stays inline');
  t.like(first.payload.result, { bytes: big.length });
  t.regex(first.payload.result.ref, /^sha256:[0-9a-f]{64}$/);
  t.is(first.payload.result.preview.length, 1024 * 4, 'the preview is bounded');
  t.deepEqual(second.payload.result, first.payload.result);
  t.is(
    [...values.keys()].filter(name => name.includes('-content-')).length,
    1,
    'the same content is stored once',
  );
  t.is(await journal.reader.content(first.payload.result.ref), big);
  // The chain covers the reference, and the reference covers the content.
  t.true((await journal.reader.verify()).ok);
  const name = [...values.keys()].find(key => key.includes('-content-'));
  values.set(name, `${big}tampered`);
  await t.throwsAsync(journal.reader.content(first.payload.result.ref), {
    message: /does not match its reference/,
  });
  // A journal with nowhere to put content refuses the field rather than
  // attesting a reference to nothing.
  const durable = [];
  const heads = makeHeadStore();
  const bare = makeAuditJournal({
    ...heads,
    journalId: 'bare',
    sessionId: 'bare-session',
    inlineBytes: 1024,
    readEntries: async () => durable,
    appendEntry: async entry => {
      durable.push(entry);
    },
  });
  await t.throwsAsync(bare.writer.append('tool-result', { result: big }), {
    message: /stores no content/,
  });
  t.is(durable.length, 0);
});
