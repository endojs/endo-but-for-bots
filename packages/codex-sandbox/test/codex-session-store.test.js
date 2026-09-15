// @ts-check
import '@endo/init';

import test from 'ava';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalAuditJson,
  makeStoredAuditJournal,
  parseCanonicalAuditJson,
} from '../src/audit-journal.js';
import {
  makeCodexSessionState,
  makeDirectoryValueStore,
} from '../src/codex-session-store.js';

const makeTmp = async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-store-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('the canonical encoding round-trips everything an audit entry can hold', t => {
  const value = harden({
    version: 1,
    sequence: 12_345_678_901_234_567_890n,
    previousHash: '0'.repeat(64),
    at: '2026-09-16T00:00:00.000Z',
    kind: 'turn-admitted',
    data: harden({
      nested: harden([null, true, -0, 1.5, 'text', harden({ a: 1n })]),
    }),
  });
  const text = canonicalAuditJson(value);
  const decoded = /** @type {any} */ (parseCanonicalAuditJson(text));
  t.deepEqual(decoded, value);
  // Canonical means the decoded value re-encodes to the same bytes, which is
  // what makes a file on disk verifiable against the hash chain as written.
  t.is(canonicalAuditJson(decoded), text);
  t.is(Object.is(decoded.data.nested[2], -0), true);
});

test('the decoder refuses anything the encoder would not have produced', t => {
  for (const bad of [
    '{"a":1}',
    '["number","1e3"]',
    '["number"," 1"]',
    '["bigint","01"]',
    '["record",[["b",["null"]],["a",["null"]]]]',
    '["record",[["a",["null"]],["a",["null"]]]]',
    '["unknown",1]',
    '["string",1]',
    'not json',
  ]) {
    t.throws(() => parseCanonicalAuditJson(bad), undefined, bad);
  }
});

test('a record key that would be a prototype stays a key', t => {
  // A record whose only key is `__proto__`, built so it is an own property
  // rather than a prototype assignment.
  const source = harden(Object.fromEntries([['__proto__', 'text']]));
  const text = canonicalAuditJson(source);
  const decoded = /** @type {any} */ (parseCanonicalAuditJson(text));
  t.is(Object.getPrototypeOf(decoded), Object.prototype);
  t.is(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value, 'text');
});

test('a value store round-trips through the filesystem', async t => {
  const dir = await makeTmp(t);
  const store = await makeDirectoryValueStore(path.join(dir, 'entries'));
  t.deepEqual([...(await store.list())], []);
  t.false(await store.has('one'));
  await store.storeValue(harden({ sequence: 1n, kind: 'x' }), 'one');
  t.true(await store.has('one'));
  t.deepEqual(await store.lookup('one'), { sequence: 1n, kind: 'x' });
  t.deepEqual([...(await store.list())], ['one']);
  // storeValue replaces, as a petstore name does.
  await store.storeValue(harden({ sequence: 2n, kind: 'x' }), 'one');
  t.deepEqual(await store.lookup('one'), { sequence: 2n, kind: 'x' });
});

test('writes land atomically and leave no temporary behind', async t => {
  const dir = await makeTmp(t);
  const root = path.join(dir, 'entries');
  const store = await makeDirectoryValueStore(root);
  await store.storeValue(
    harden({ sequence: 0n }),
    'codex-audit-s-0'.padEnd(20, '0'),
  );
  const names = await readdir(root);
  t.deepEqual(
    names.filter(name => name.endsWith('.tmp')),
    [],
  );
  t.is(names.length, 1);
  t.true(names[0].endsWith('.json'));
});

test('a name that could escape the directory is refused', async t => {
  const dir = await makeTmp(t);
  const store = await makeDirectoryValueStore(path.join(dir, 'entries'));
  await Promise.all(
    ['../escape', 'a/b', '.hidden', '', 'a'.repeat(200)].flatMap(bad => [
      t.throwsAsync(store.storeValue(harden({}), bad), {
        message: /Invalid Codex value name/,
      }),
      t.throwsAsync(store.lookup(bad), {
        message: /Invalid Codex value name/,
      }),
    ]),
  );
});

test('a symlink where a value should be is not a stored value', async t => {
  const dir = await makeTmp(t);
  const root = path.join(dir, 'entries');
  const store = await makeDirectoryValueStore(root);
  const outside = path.join(dir, 'outside.json');
  await writeFile(outside, canonicalAuditJson(harden({ secret: 'text' })));
  await symlink(outside, path.join(root, 'planted.json'));
  // Absent, so an append will not believe a sequence is already taken...
  t.false(await store.has('planted'));
  // ...and a read never follows it.
  await t.throwsAsync(store.lookup('planted'), { message: /ELOOP|symbolic/ });
  // A write replaces the link rather than writing through it.
  await store.storeValue(harden({ replaced: true }), 'planted');
  t.deepEqual(await store.lookup('planted'), { replaced: true });
  t.is(
    await readFile(outside, 'utf8'),
    canonicalAuditJson(harden({ secret: 'text' })),
  );
  t.false((await lstat(path.join(root, 'planted.json'))).isSymbolicLink());
});

test('the journal runs on a directory exactly as it did on a petstore', async t => {
  const dir = await makeTmp(t);
  const session = await makeCodexSessionState(path.join(dir, 'abc'));
  const journal = makeStoredAuditJournal(session.entries, {
    journalId: 'codex-abc',
    sessionId: 'abc',
    anchorPowers: session.anchors,
  });
  await journal.writer.append('session-opened', harden({ turn: 1 }));
  await journal.writer.append('turn-admitted', harden({ turn: 2n }));
  const entries = await journal.reader.entries();
  t.is(entries.length, 2);
  t.is(entries[0].kind, 'session-opened');
  t.is(entries[1].sequence, 1n);
  t.like(await journal.reader.verify(), { ok: true });

  // Reopening reads the same chain back off disk.
  const reopened = makeStoredAuditJournal(session.entries, {
    journalId: 'codex-abc',
    sessionId: 'abc',
    anchorPowers: session.anchors,
  });
  t.like(await reopened.reader.verify(), { ok: true });
  await reopened.writer.append('session-closed', harden({}));
  t.is((await reopened.reader.entries()).length, 3);
});

test('entries and anchors are distinct stores, as the journal requires', async t => {
  const dir = await makeTmp(t);
  const session = await makeCodexSessionState(path.join(dir, 'abc'));
  t.not(session.entries, session.anchors);
  t.throws(
    () =>
      makeStoredAuditJournal(session.entries, {
        journalId: 'codex-abc',
        sessionId: 'abc',
        anchorPowers: session.entries,
      }),
    { message: /must be distinct/ },
  );
});

test('a thread checkpoint is absent until written, then read back', async t => {
  const dir = await makeTmp(t);
  const session = await makeCodexSessionState(path.join(dir, 'abc'));
  t.deepEqual(await session.readThread(), {});
  await session.writeThread(
    harden({ threadId: 't-1', recovery: harden({ baseTurnId: null }) }),
  );
  t.deepEqual(await session.readThread(), {
    threadId: 't-1',
    recovery: { baseTurnId: null },
  });
});
